import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppState, restoreDurableState, snapshotState } from './app-state.js';
import {
  isAuthorizedRequest,
  isDashboardAuthEnabled,
  redactServiceForPublicHealth,
  requireDashboardAuth,
} from './auth.js';
import { HOST, PORT } from './config.js';
import { createCandidateRoutes } from './candidate-tracker/routes.js';
import { createCandidateTracker } from './candidate-tracker/service.js';
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
let candidateTrackerStarted = false;

const candidateTracker = createCandidateTracker(state, broadcast, {
  onStateChanged: () => storage.queueSave(state),
});

app.use(express.json());

app.get('/api/health', (request, response) => {
  refreshHealthRuntimeMetrics();
  const service = isAuthorizedRequest(request) ? state.service : redactServiceForPublicHealth(state.service);
  response.json({ ok: true, authEnabled: isDashboardAuthEnabled(), service });
});

app.get('/api/state', requireDashboardAuth, (_request, response) => {
  response.json(snapshotState(state));
});

app.use('/api/candidates', requireDashboardAuth, createCandidateRoutes(candidateTracker));

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

wss.on('connection', (socket, request) => {
  if (!isAuthorizedRequest(request)) {
    socket.close(1008, 'Unauthorized');
    return;
  }
  socket.send(JSON.stringify({ type: 'state', payload: snapshotState(state) }));
});

function broadcast() {
  const message = JSON.stringify({ type: 'state', payload: snapshotState(state) });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(message);
  }
}

function refreshHealthRuntimeMetrics() {
  const storage = state.service.storage;
  if (!storage?.lastSavedAt) {
    if (storage) storage.lastSuccessfulSaveAgeMs = null;
    return;
  }
  const lastSavedAt = Date.parse(storage.lastSavedAt);
  storage.lastSuccessfulSaveAgeMs = Number.isFinite(lastSavedAt) ? Date.now() - lastSavedAt : null;
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
    if (!candidateTrackerStarted) {
      candidateTrackerStarted = true;
      candidateTracker.start().catch((error) => {
        state.service.candidates.status = 'error';
        state.service.candidates.lastError = error.message;
        broadcast();
      });
    }
    broadcast();
  }
}

process.on('SIGINT', async () => {
  await storage.flush(state);
  await storage.close();
  await candidateTracker.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await storage.flush(state);
  await storage.close();
  await candidateTracker.close();
  process.exit(0);
});

server.listen(PORT, HOST, () => {
  console.log(`Autotrader server listening on http://${HOST}:${PORT}`);
  initializeStorageAndIngestion();
});
