import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = './data/test.db';
process.env.API_KEY = 'testkey';
const { default: app } = await import('../src/server.js');

let server, base;
before(() => new Promise((ok) => { server = app.listen(0, () => { base = `http://localhost:${server.address().port}`; ok(); }); }));
after(() => server.close());

const json = { 'Content-Type': 'application/json' };
const admin = { ...json, 'x-api-key': 'testkey' };
const send = (b) => fetch(`${base}/api/leads`, { method: 'POST', headers: json, body: JSON.stringify(b) });
const email = `ana${Date.now()}@teste.com`;

test('captura lead, valida dados e não duplica e-mail', async () => {
  assert.equal((await send({ name: 'Ana', email, phone: '(11) 99999-0000', message: 'Oi' })).status, 201);
  assert.equal((await send({ name: 'A', email })).status, 400);
  assert.equal((await send({ name: 'Ana', email: 'invalido' })).status, 400);
  assert.equal((await send({ name: 'Ana', email, message: 'De novo' })).status, 200); // duplicado
  const r = await fetch(`${base}/api/leads?q=${encodeURIComponent(email)}`, { headers: admin });
  const { data, total } = await r.json();
  assert.equal(total, 1);
  const lead = await (await fetch(`${base}/api/leads/${data[0].id}`, { headers: admin })).json();
  assert.equal(lead.events.length, 2); // criado + nova_mensagem
});

test('honeypot descarta robôs sem salvar', async () => {
  const bot = `bot${Date.now()}@spam.com`;
  assert.equal((await send({ name: 'Robo', email: bot, website: 'http://spam' })).status, 201);
  const { total } = await (await fetch(`${base}/api/leads?q=${bot}`, { headers: admin })).json();
  assert.equal(total, 0);
});

test('rotas protegidas exigem chave; funil e stats funcionam', async () => {
  assert.equal((await fetch(`${base}/api/leads`)).status, 401);
  assert.equal((await fetch(`${base}/api/leads`, { headers: { 'x-api-key': 'errada' } })).status, 401);
  const { data } = await (await fetch(`${base}/api/leads?q=${encodeURIComponent(email)}`, { headers: admin })).json();
  const id = data[0].id;
  const p = await fetch(`${base}/api/leads/${id}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ stage: 'convertido' }) });
  assert.equal((await p.json()).stage, 'convertido');
  assert.equal((await fetch(`${base}/api/leads/${id}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ stage: 'xyz' }) })).status, 400);
  const st = await (await fetch(`${base}/api/leads/stats`, { headers: admin })).json();
  assert.ok(st.byStage.convertido >= 1);
  const csv = await (await fetch(`${base}/api/leads/export.csv`, { headers: admin })).text();
  assert.ok(csv.includes(email));
  assert.equal((await fetch(`${base}/api/leads/${id}`, { method: 'DELETE', headers: admin })).status, 204);
});
