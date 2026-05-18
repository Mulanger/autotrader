import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppState, restoreDurableState, snapshotState } from './app-state.js';
import { HOST, PORT } from './config.js';
import { startIngestion } from './stream-service.js';
import { createStorage } from './storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.resolve(__dirname, '../dist');
const indexPath = path.join(distPath, 'index.html');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/events' });
const state = createAppState();
const storage = await createStorage(state);
const storedState = await storage.load();
restoreDurableState(state, storedState);

app.use(express.json());

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, service: state.service });
});

app.get('/api/state', (_request, response) => {
  response.json(snapshotState(state));
});

if (existsSync(indexPath)) {
  app.use(express.static(distPath, {
    index: false,
    maxAge: '1h',
  }));

  app.get(/.*/, (request, response, next) => {
    if (request.path.startsWith('/api/')) return next();
    response.sendFile(indexPath);
  });
}

wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'state', payload: snapshotState(state) }));
});

function broadcast() {
  const message = JSON.stringify({ type: 'state', payload: snapshotState(state) });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(message);
  }
}

startIngestion(state, broadcast, storage);

process.on('SIGINT', async () => {
  await storage.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await storage.close();
  process.exit(0);
});

server.listen(PORT, HOST, () => {
  console.log(`Autotrader server listening on http://${HOST}:${PORT}`);
});
