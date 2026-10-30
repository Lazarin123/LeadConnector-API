FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production DB_PATH=/data/leads.db
VOLUME /data
EXPOSE 3000
CMD ["npm", "start"]
