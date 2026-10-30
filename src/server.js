import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '*').split(',').map((s) => s.trim());

// Etapas do funil. Quer outras (ex: "perdido")? Basta adicionar aqui.
const STAGES = ['novo', 'em_contato', 'convertido'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ---------- helpers ----------
const fail = (res, status, message) => res.status(status).json({ error: message });
const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

const requireKey = (req, res, next) => {
  if (!API_KEY) return fail(res, 403, 'Rotas protegidas desativadas: defina API_KEY no .env');
  const given = Buffer.from(req.get('x-api-key') || '');
  const expected = Buffer.from(API_KEY);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected))
    return fail(res, 401, 'API key inválida');
  next();
};

const notify = (lead) => {
  if (!WEBHOOK_URL) return;
  const text = `🆕 Novo lead: ${lead.name} <${lead.email}>${lead.phone ? ' · ' + lead.phone : ''}`;
  fetch(WEBHOOK_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, content: text, lead }), // "text" = Slack, "content" = Discord
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
};

const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // evita injeção de fórmula no Excel
  return `"${s.replace(/"/g, '""')}"`;
};

// ---------- statements ----------
const findByEmail = db.prepare('SELECT id, phone FROM leads WHERE email = ?');
const insertLead = db.prepare(`INSERT INTO leads (name,email,phone,message,source,consent,created_at,updated_at)
                               VALUES (?,?,?,?,?,?,?,?)`);
const addEvent = db.prepare('INSERT INTO lead_events (lead_id,type,detail,created_at) VALUES (?,?,?,?)');
const getLead = db.prepare('SELECT * FROM leads WHERE id = ?');

const createLead = db.transaction((l) => {
  const now = new Date().toISOString();
  const id = Number(insertLead.run(l.name, l.email, l.phone, l.message, l.source, l.consent ? 1 : 0, now, now).lastInsertRowid);
  addEvent.run(id, 'criado', l.message || null, now);
  return id;
});

// ---------- app ----------
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '20kb' }));
app.use('/api', cors({
  origin: CORS_ORIGIN.includes('*') ? '*' : CORS_ORIGIN,
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'x-api-key'],
}));

const formLimiter = rateLimit({
  windowMs: 60_000, limit: Number(process.env.RATE_LIMIT) || 10,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Muitos envios. Tente novamente em instantes.' },
});
const adminLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false });

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ===== Rota PÚBLICA: receber lead do formulário =====
app.post('/api/leads', formLimiter, (req, res) => {
  const b = req.body ?? {};
  // Honeypot: campo "website" fica escondido no formulário; só robôs o preenchem.
  if (clean(b.website, 200)) return res.status(201).json({ ok: true });

  const name = clean(b.name, 100);
  const email = clean(b.email, 254).toLowerCase();
  const phoneRaw = clean(b.phone, 30);
  const message = clean(b.message, 2000);
  const phoneDigits = phoneRaw.replace(/\D/g, '');

  if (name.length < 2) return fail(res, 400, 'Informe seu nome');
  if (!EMAIL_RE.test(email)) return fail(res, 400, 'E-mail inválido');
  if (phoneRaw && (phoneDigits.length < 8 || phoneDigits.length > 15)) return fail(res, 400, 'Telefone inválido');

  let source = clean(b.source, 100);
  if (!source) { try { source = new URL(req.get('origin') || req.get('referer')).hostname; } catch {} }

  const existing = findByEmail.get(email);
  if (existing) { // mesmo e-mail: não duplica, registra como nova mensagem no histórico
    const now = new Date().toISOString();
    addEvent.run(existing.id, 'nova_mensagem', message || null, now);
    db.prepare('UPDATE leads SET updated_at = ?, phone = COALESCE(NULLIF(phone, \'\'), ?) WHERE id = ?')
      .run(now, phoneRaw || null, existing.id);
    return res.json({ ok: true, message: 'Recebemos seu contato!' });
  }

  const id = createLead({ name, email, phone: phoneRaw || null, message: message || null, source: source || null, consent: b.consent === true });
  notify({ id, name, email, phone: phoneRaw, message, source });
  res.status(201).json({ ok: true, message: 'Recebemos seu contato!' });
});

// ===== Rotas PROTEGIDAS =====
app.use('/api/leads', adminLimiter, requireKey);

app.get('/api/leads/stats', (_req, res) => {
  const byStage = Object.fromEntries(STAGES.map((s) => [s, 0]));
  for (const r of db.prepare('SELECT stage, COUNT(*) AS n FROM leads GROUP BY stage').all()) byStage[r.stage] = r.n;
  const total = Object.values(byStage).reduce((a, b) => a + b, 0);
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  res.json({
    total, byStage,
    conversionRate: total ? +((byStage.convertido / total) * 100).toFixed(1) : 0,
    leadsByDay: db.prepare(`SELECT substr(created_at,1,10) AS date, COUNT(*) AS leads FROM leads
                            WHERE created_at >= ? GROUP BY date ORDER BY date`).all(since),
    topSources: db.prepare(`SELECT COALESCE(source,'direto') AS name, COUNT(*) AS leads FROM leads
                            GROUP BY name ORDER BY leads DESC LIMIT 5`).all(),
  });
});

const listQuery = (req) => {
  const where = []; const params = [];
  const stage = clean(req.query.stage, 20);
  const q = clean(req.query.q, 100);
  if (stage) { where.push('stage = ?'); params.push(stage); }
  if (q) {
    where.push("(name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR message LIKE ? ESCAPE '\\')");
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    params.push(like, like, like, like);
  }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params, stage };
};

app.get('/api/leads/export.csv', (req, res) => {
  const { sql, params } = listQuery(req);
  const rows = db.prepare(`SELECT * FROM leads ${sql} ORDER BY created_at DESC`).all(...params);
  const head = ['id', 'nome', 'email', 'telefone', 'etapa', 'origem', 'mensagem', 'criado_em'];
  const lines = rows.map((r) => [r.id, r.name, r.email, r.phone, r.stage, r.source, r.message, r.created_at].map(csvCell).join(';'));
  res.type('text/csv').set('Content-Disposition', 'attachment; filename="leads.csv"')
    .send('\uFEFF' + [head.map(csvCell).join(';'), ...lines].join('\r\n'));
});

app.get('/api/leads', (req, res) => {
  const { sql, params, stage } = listQuery(req);
  if (stage && !STAGES.includes(stage)) return fail(res, 400, `stage deve ser: ${STAGES.join(', ')}`);
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM leads ${sql}`).get(...params).n;
  const data = db.prepare(`SELECT * FROM leads ${sql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, (page - 1) * limit);
  res.json({ data, page, limit, total, pages: Math.ceil(total / limit) });
});

app.get('/api/leads/:id', (req, res) => {
  const lead = getLead.get(Number(req.params.id));
  if (!lead) return fail(res, 404, 'Lead não encontrado');
  const events = db.prepare('SELECT type, detail, created_at FROM lead_events WHERE lead_id = ? ORDER BY id').all(lead.id);
  res.json({ ...lead, events });
});

app.patch('/api/leads/:id', (req, res) => {
  const lead = getLead.get(Number(req.params.id));
  if (!lead) return fail(res, 404, 'Lead não encontrado');
  const { stage, notes } = req.body ?? {};
  if (stage !== undefined && !STAGES.includes(stage)) return fail(res, 400, `stage deve ser: ${STAGES.join(', ')}`);
  const now = new Date().toISOString();
  if (stage && stage !== lead.stage) addEvent.run(lead.id, 'etapa', `${lead.stage} → ${stage}`, now);
  db.prepare('UPDATE leads SET stage = ?, notes = ?, updated_at = ? WHERE id = ?')
    .run(stage ?? lead.stage, notes !== undefined ? clean(notes, 2000) : lead.notes, now, lead.id);
  res.json(getLead.get(lead.id));
});

app.delete('/api/leads/:id', (req, res) => {
  const r = db.prepare('DELETE FROM leads WHERE id = ?').run(Number(req.params.id));
  if (!r.changes) return fail(res, 404, 'Lead não encontrado');
  res.status(204).end();
});

app.use('/api', (_req, res) => fail(res, 404, 'Rota não encontrada'));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') return fail(res, 400, 'JSON inválido');
  console.error(err);
  fail(res, 500, 'Erro interno');
});

export default app;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, () => console.log(`📇 LeadConnector rodando em http://localhost:${PORT}  (painel: /admin.html)`));
}
