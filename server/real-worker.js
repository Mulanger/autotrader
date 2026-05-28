import { createAppState } from './app-state.js';
import { REAL_LIVE_TRADING_ENABLED, REAL_POLLING_ENABLED, REAL_TRADING_MODE } from './config.js';
import { createRealTraderService } from './real/service.js';

const GEOBLOCK_URL = 'https://polymarket.com/api/geoblock';
const HEARTBEAT_MS = 60_000;

const state = createAppState();
const service = createRealTraderService(state, () => {});
let stopping = false;

main().catch((error) => {
  console.error(`[real-worker] fatal: ${error.stack || error.message}`);
  process.exit(1);
});

async function main() {
  if (!REAL_POLLING_ENABLED) {
    throw new Error('REAL_POLLING_ENABLED=false; refusing to start the real worker without polling enabled');
  }

  const liveRequested = REAL_TRADING_MODE === 'live' && Boolean(REAL_LIVE_TRADING_ENABLED);
  const geo = await checkGeoblock();
  console.log(
    `[real-worker] geoblock blocked=${geo.blocked} country=${geo.country || 'unknown'} region=${geo.region || ''}`
  );

  if (liveRequested && geo.blocked) {
    throw new Error(
      `Polymarket geoblock rejected this host (${geo.country || 'unknown'} ${geo.region || ''}); live worker not started`
    );
  }

  await service.start();
  console.log(`[real-worker] started ${summary()}`);

  const heartbeat = setInterval(() => {
    console.log(`[real-worker] heartbeat ${summary()}`);
  }, HEARTBEAT_MS);

  process.on('SIGINT', () => shutdown('SIGINT', heartbeat));
  process.on('SIGTERM', () => shutdown('SIGTERM', heartbeat));
}

async function shutdown(signal, heartbeat) {
  if (stopping) return;
  stopping = true;
  clearInterval(heartbeat);
  console.log(`[real-worker] shutting down from ${signal}`);
  await service.close();
  process.exit(0);
}

async function checkGeoblock() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(GEOBLOCK_URL, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const geo = await response.json();
    return {
      blocked: Boolean(geo.blocked),
      country: geo.country || null,
      region: geo.region || null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function summary() {
  const real = state.service.real || {};
  return [
    `status=${real.status || 'unknown'}`,
    `mode=${real.mode || REAL_TRADING_MODE}`,
    `polling=${real.pollingEnabled !== false}`,
    `liveReady=${Boolean(real.liveExecutionReady)}`,
    `lastPoll=${real.lastPollAt || 'never'}`,
    `lastError=${real.lastError || 'none'}`,
  ].join(' ');
}
