import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppState, restoreDurableState, snapshotState } from './app-state.js';
import { HOST, PORT } from './config.js';
import { startIngestion } from './stream-service.js';
import { createMemoryStorage, createStorage } from './storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.resolve(__dirname, '../dist');
const indexPath = path.join(distPath, 'index.html');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/events' });
const state = createAppState();
let storage = createMemoryStorage(state.service.storage, 'starting');
let ingestionStarted = false;

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

async function initializeStorageAndIngestion() {
  try {
    storage = await createStorage(state);
    const storedState = await storage.load();
    restoreDurableState(state, storedState);
    console.log(`Storage initialized: ${state.service.storage.mode}/${state.service.storage.status}`);
  } catch (error) {
    state.service.storage.mode = 'postgres';
    state.service.storage.status = 'error';
    state.service.storage.durable = false;
    state.service.storage.lastError = error.message;
    console.error(`Storage initialization failed: ${error.message}`);
  } finally {
    if (!ingestionStarted) {
      ingestionStarted = true;
      startIngestion(state, broadcast, storage);
    }
    broadcast();
  }
}

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
  initializeStorageAndIngestion();
});
