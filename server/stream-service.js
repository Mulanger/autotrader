import WebSocket from 'ws';
import { POLL_INTERVAL_MS, POLYWHALE_WS_URL, RESOLUTION_POLL_INTERVAL_MS } from './config.js';
import { applyLeaderboardRows, ingestTrade } from './app-state.js';
import { fetchBootstrapTrades, fetchProfitLeaderboard, fetchRecentWhales, fetchWhaleTrade } from './polywhale-client.js';
import { fetchGammaResolution } from './polymarket-client.js';
import { reconcileOpenDemoPositions } from './resolution-engine.js';
import { normalizeStreamMessage } from './trade-normalizer.js';
import { nowIso } from './format.js';

export function startIngestion(state, broadcast, storage) {
  let socket = null;
  let reconnectTimer = null;
  let resolutionRunning = false;

  async function bootstrap() {
    try {
      state.service.pollStatus = 'bootstrapping';
      const [leaderboardRows, trades] = await Promise.all([
        fetchProfitLeaderboard(100).catch((error) => {
          state.service.lastError = error.message;
          return [];
        }),
        fetchBootstrapTrades(),
      ]);
      applyLeaderboardRows(state, leaderboardRows);
      for (const trade of trades) ingestTrade(state, trade, 'bootstrap', { copyEligible: false });
      state.service.pollStatus = 'ready';
      state.service.pollLastRunAt = nowIso();
      storage.queueSave(state);
      broadcast();
    } catch (error) {
      state.service.pollStatus = 'error';
      state.service.lastError = error.message;
      broadcast();
    }
  }

  function connect() {
    clearTimeout(reconnectTimer);
    state.service.streamStatus = 'connecting';
    broadcast();

    socket = new WebSocket(POLYWHALE_WS_URL);

    socket.on('open', () => {
      state.service.streamStatus = 'connected';
      state.service.lastError = null;
      broadcast();
    });

    socket.on('message', (data) => {
      state.service.streamLastMessageAt = nowIso();
      try {
        const parsed = JSON.parse(String(data));
        const normalized = normalizeStreamMessage(parsed);
        if (!normalized) return;
        if (normalized.kind === 'hello') {
          broadcast();
          return;
        }
        const event = ingestTrade(state, normalized, 'websocket');
        if (event) {
          storage.queueSave(state);
          broadcast();
        }
      } catch (error) {
        state.service.lastError = error.message;
        broadcast();
      }
    });

    socket.on('error', (error) => {
      state.service.streamStatus = 'error';
      state.service.lastError = error.message;
      broadcast();
    });

    socket.on('close', () => {
      state.service.streamStatus = 'reconnecting';
      broadcast();
      reconnectTimer = setTimeout(connect, 3_000);
    });
  }

  async function poll() {
    try {
      state.service.pollStatus = 'polling';
      const trades = await fetchRecentWhales(100);
      let changed = false;
      for (const trade of trades.reverse()) {
        const event = ingestTrade(state, trade, 'poll');
        if (event) changed = true;
      }
      state.service.pollStatus = 'ready';
      state.service.pollLastRunAt = nowIso();
      if (changed) {
        storage.queueSave(state);
        broadcast();
      }
    } catch (error) {
      state.service.pollStatus = 'error';
      state.service.lastError = error.message;
      broadcast();
    }
  }

  async function reconcileResolutions() {
    if (resolutionRunning) return;
    resolutionRunning = true;
    try {
      state.service.resolutionStatus = 'polling';
      broadcast();
      const result = await reconcileOpenDemoPositions(state, fetchWhaleTrade, fetchGammaResolution);
      state.service.resolutionStatus = 'ready';
      state.service.resolutionLastRunAt = nowIso();
      state.service.resolutionLastCheckedCount = result.checked;
      if (result.settled.length) state.service.resolutionLastSettledAt = nowIso();
      if (result.errors.length) state.service.lastError = `Resolution checks failed: ${result.errors.slice(0, 2).join('; ')}`;
      else if (String(state.service.lastError || '').startsWith('Resolution checks failed:')) state.service.lastError = null;
      if (result.changed) storage.queueSave(state);
      broadcast();
    } catch (error) {
      state.service.resolutionStatus = 'error';
      state.service.lastError = error.message;
      broadcast();
    } finally {
      resolutionRunning = false;
    }
  }

  bootstrap().finally(() => {
    connect();
    setInterval(poll, POLL_INTERVAL_MS);
    setInterval(reconcileResolutions, RESOLUTION_POLL_INTERVAL_MS);
    reconcileResolutions();
  });
}
