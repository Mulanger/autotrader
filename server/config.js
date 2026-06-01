import { WATCHED_WALLETS } from './watched-wallets.js';

export const POLYWHALE_API_BASE_URL =
  process.env.POLYWHALE_API_BASE_URL || 'https://whaleserver-production.up.railway.app';

export const POLYMARKET_GAMMA_URL =
  process.env.POLYMARKET_GAMMA_URL || 'https://gamma-api.polymarket.com';

export const POLYMARKET_DATA_API_URL =
  process.env.POLYMARKET_DATA_API_URL || 'https://data-api.polymarket.com';

export const POLYMARKET_CLOB_URL =
  process.env.POLYMARKET_CLOB_URL || 'https://clob.polymarket.com';

export const POLYMARKET_PROFILE_REFRESH_INTERVAL_MS = Number(
  process.env.POLYMARKET_PROFILE_REFRESH_INTERVAL_MS || 15 * 60_000
);

export const POLYMARKET_PROFILE_REFRESH_CONCURRENCY = Number(
  process.env.POLYMARKET_PROFILE_REFRESH_CONCURRENCY || 6
);

export const POLYGON_RPC_URL =
  process.env.POLYGON_RPC_URL || process.env.POLYMARKET_RPC_URL || process.env.RPC_URL || 'https://polygon-rpc.com';

export const POLYWHALE_WS_URL =
  POLYWHALE_API_BASE_URL.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:') + '/v1/whales/stream';

export const PORT = Number(process.env.PORT || 4101);

export const HOST = process.env.HOST || '0.0.0.0';

export const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 20_000);

export const RESOLUTION_POLL_INTERVAL_MS = Number(process.env.RESOLUTION_POLL_INTERVAL_MS || 60_000);

export const DEMO_STARTING_CAPITAL_USD = Number(process.env.DEMO_STARTING_CAPITAL_USD || 1_000);

export const DEMO_STAKE_USD = 10;

export const DEMO_MAX_ENTRY_PRICE_CENTS = Number(process.env.DEMO_MAX_ENTRY_PRICE_CENTS || 75);

export const CANDIDATE_TRACKER_ENABLED = parseBoolean(process.env.CANDIDATE_TRACKER_ENABLED, false);

export const CANDIDATE_MAINTENANCE_ENABLED = parseBoolean(process.env.CANDIDATE_MAINTENANCE_ENABLED, false);

export const CANDIDATE_MAINTENANCE_INTERVAL_MS = Number(
  process.env.CANDIDATE_MAINTENANCE_INTERVAL_MS || 24 * 60 * 60_000
);

export const CANDIDATE_MAINTENANCE_SCORING_INTERVAL_MS = Number(
  process.env.CANDIDATE_MAINTENANCE_SCORING_INTERVAL_MS || 5 * 24 * 60 * 60_000
);

export const CANDIDATE_MAINTENANCE_LOOKBACK_HOURS = Number(process.env.CANDIDATE_MAINTENANCE_LOOKBACK_HOURS || 48);

export const CANDIDATE_MAINTENANCE_STARTUP_CATCHUP_HOURS = Number(
  process.env.CANDIDATE_MAINTENANCE_STARTUP_CATCHUP_HOURS || 96
);

export const CANDIDATE_MAINTENANCE_SCOPE = process.env.CANDIDATE_MAINTENANCE_SCOPE || 'active_scored';

export const CANDIDATE_MAINTENANCE_PAGE_LIMIT = Number(process.env.CANDIDATE_MAINTENANCE_PAGE_LIMIT || 500);

export const CANDIDATE_MAINTENANCE_MAX_PAGES_PER_WALLET = Number(
  process.env.CANDIDATE_MAINTENANCE_MAX_PAGES_PER_WALLET || 2
);

export const CANDIDATE_MAINTENANCE_RESOLUTION_MAX_TRADES = Number(
  process.env.CANDIDATE_MAINTENANCE_RESOLUTION_MAX_TRADES || 2_000
);

export const CANDIDATE_MIN_USD = Number(process.env.CANDIDATE_MIN_USD || 1_000);

export const CANDIDATE_MAX_USD = Number(process.env.CANDIDATE_MAX_USD || 10_000);

export const CANDIDATE_BACKFILL_DAYS = Number(process.env.CANDIDATE_BACKFILL_DAYS || 30);

export const CANDIDATE_ACCEPTED_HISTORY_DAYS = Number(process.env.CANDIDATE_ACCEPTED_HISTORY_DAYS || 90);

export const CANDIDATE_POLL_INTERVAL_MS = Number(process.env.CANDIDATE_POLL_INTERVAL_MS || 30_000);

export const CANDIDATE_RESOLUTION_POLL_INTERVAL_MS = Number(
  process.env.CANDIDATE_RESOLUTION_POLL_INTERVAL_MS || 60_000
);

export const CANDIDATE_POLL_LIMIT = Number(process.env.CANDIDATE_POLL_LIMIT || 500);

export const CANDIDATE_POLL_MAX_PAGES = Number(process.env.CANDIDATE_POLL_MAX_PAGES || 3);

export const CANDIDATE_BACKFILL_PAGE_LIMIT = Number(process.env.CANDIDATE_BACKFILL_PAGE_LIMIT || 500);

export const CANDIDATE_BACKFILL_MAX_PAGES = Number(process.env.CANDIDATE_BACKFILL_MAX_PAGES || 100);

export const CANDIDATE_BACKFILL_MAX_OFFSET = Number(process.env.CANDIDATE_BACKFILL_MAX_OFFSET || 10_000);

export const CANDIDATE_STALE_BACKFILL_MS = Number(process.env.CANDIDATE_STALE_BACKFILL_MS || 30 * 60_000);

export const CANDIDATE_RESOLUTION_BATCH_SIZE = Number(process.env.CANDIDATE_RESOLUTION_BATCH_SIZE || 250);

export const SHADOW_POLLING_ENABLED = parseBoolean(process.env.SHADOW_POLLING_ENABLED, false);

export const SHADOW_FOLLOW_POLL_INTERVAL_MS = Number(process.env.SHADOW_FOLLOW_POLL_INTERVAL_MS || 30_000);

export const SHADOW_FOLLOW_POLL_LIMIT = Number(process.env.SHADOW_FOLLOW_POLL_LIMIT || 100);

export const AUTO_COPY_POOL_ENABLED = parseBoolean(process.env.AUTO_COPY_POOL_ENABLED, false);

export const AUTO_COPY_POOL_INTERVAL_MS = Number(process.env.AUTO_COPY_POOL_INTERVAL_MS || 300_000);

export const AUTO_COPY_MIN_DISTINCT_MARKETS = Number(process.env.AUTO_COPY_MIN_DISTINCT_MARKETS || 15);

export const AUTO_COPY_MIN_WIN_RATE_PCT = Number(process.env.AUTO_COPY_MIN_WIN_RATE_PCT || 75);

export const AUTO_COPY_REMOVE_MIN_WIN_RATE_PCT = Number(process.env.AUTO_COPY_REMOVE_MIN_WIN_RATE_PCT || 70);

export const AUTO_COPY_MAX_AEP_CENTS = Number(process.env.AUTO_COPY_MAX_AEP_CENTS || 75);

export const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 15_000);

export const FETCH_RETRY_COUNT = Number(process.env.FETCH_RETRY_COUNT || 2);

export const DASHBOARD_AUTH_TOKEN = process.env.DASHBOARD_AUTH_TOKEN || '';

export const REAL_ACTION_PIN = process.env.REAL_ACTION_PIN || '1993';

export const REAL_DRY_RUN_STAKE_USD = Number(process.env.REAL_DRY_RUN_STAKE_USD || 10);

export const REAL_STAKE_USD = Number(process.env.REAL_STAKE_USD || process.env.REAL_DRY_RUN_STAKE_USD || 10);

export const REAL_TRADING_MODE = normalizeRealTradingMode(
  process.env.REAL_TRADING_MODE || (parseBoolean(process.env.REAL_LIVE_TRADING_ENABLED, false) ? 'live' : 'dry_run')
);

export const REAL_LIVE_TRADING_ENABLED = parseBoolean(process.env.REAL_LIVE_TRADING_ENABLED, false);

export const REAL_POLLING_ENABLED = parseBoolean(process.env.REAL_POLLING_ENABLED, true);

export const REAL_PRICE_GUARD_CENTS = Number(process.env.REAL_PRICE_GUARD_CENTS || 4);

export const REAL_MAX_ENTRY_PRICE_CENTS = Number(
  process.env.REAL_MAX_ENTRY_PRICE_CENTS || process.env.DEMO_MAX_ENTRY_PRICE_CENTS || 75
);

export const REAL_MAX_SOURCE_TRADE_AGE_SECONDS = Number(process.env.REAL_MAX_SOURCE_TRADE_AGE_SECONDS || 45);

export const REAL_FOLLOW_POLL_INTERVAL_MS = Number(process.env.REAL_FOLLOW_POLL_INTERVAL_MS || 30_000);

export const REAL_FOLLOW_POLL_LIMIT = Number(process.env.REAL_FOLLOW_POLL_LIMIT || 100);

export const DEBUG_STATE_INCLUDE_ALL_TRADES = parseBoolean(process.env.DEBUG_STATE_INCLUDE_ALL_TRADES, false);

export { WATCHED_WALLETS };

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function normalizeRealTradingMode(value) {
  const text = String(value || '').trim().toLowerCase().replace('-', '_');
  if (text === 'live') return 'live';
  return 'dry_run';
}
