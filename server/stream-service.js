import WebSocket from 'ws';
import { POLL_INTERVAL_MS, POLYWHALE_WS_URL } from './config.js';
import { applyLeaderboardRows, ingestTrade } from './app-state.js';
import { fetchBootstrapTrades, fetchProfitLeaderboard, fetchRecentWhales } from './polywhale-client.js';
import { normalizeStreamMessage } from './trade-normalizer.js';
import { nowIso } from './format.js';

export function startIngestion(state, broadcast) {
  let socket = null;
  let reconnectTimer = null;

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
        if (event) broadcast();
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
      if (changed) broadcast();
    } catch (error) {
      state.service.pollStatus = 'error';
      state.service.lastError = error.message;
      broadcast();
    }
  }

  bootstrap().finally(() => {
    connect();
    setInterval(poll, POLL_INTERVAL_MS);
  });
}
