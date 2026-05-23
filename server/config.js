import { WATCHED_WALLETS } from './watched-wallets.js';

export const POLYWHALE_API_BASE_URL =
  process.env.POLYWHALE_API_BASE_URL || 'https://whaleserver-production.up.railway.app';

export const POLYMARKET_GAMMA_URL =
  process.env.POLYMARKET_GAMMA_URL || 'https://gamma-api.polymarket.com';

export const POLYMARKET_DATA_API_URL =
  process.env.POLYMARKET_DATA_API_URL || 'https://data-api.polymarket.com';

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

export const CANDIDATE_MIN_USD = Number(process.env.CANDIDATE_MIN_USD || 1_000);

export const CANDIDATE_MAX_USD = Number(process.env.CANDIDATE_MAX_USD || 10_000);

export const CANDIDATE_BACKFILL_DAYS = Number(process.env.CANDIDATE_BACKFILL_DAYS || 30);

export const CANDIDATE_POLL_INTERVAL_MS = Number(process.env.CANDIDATE_POLL_INTERVAL_MS || 30_000);

export const CANDIDATE_RESOLUTION_POLL_INTERVAL_MS = Number(
  process.env.CANDIDATE_RESOLUTION_POLL_INTERVAL_MS || 60_000
);

export const CANDIDATE_POLL_LIMIT = Number(process.env.CANDIDATE_POLL_LIMIT || 500);

export const CANDIDATE_POLL_MAX_PAGES = Number(process.env.CANDIDATE_POLL_MAX_PAGES || 3);

export const CANDIDATE_BACKFILL_PAGE_LIMIT = Number(process.env.CANDIDATE_BACKFILL_PAGE_LIMIT || 100);

export const CANDIDATE_BACKFILL_MAX_PAGES = Number(process.env.CANDIDATE_BACKFILL_MAX_PAGES || 100);

export const CANDIDATE_RESOLUTION_BATCH_SIZE = Number(process.env.CANDIDATE_RESOLUTION_BATCH_SIZE || 50);

export const AUTO_COPY_POOL_ENABLED = parseBoolean(process.env.AUTO_COPY_POOL_ENABLED, true);

export const AUTO_COPY_POOL_INTERVAL_MS = Number(process.env.AUTO_COPY_POOL_INTERVAL_MS || 300_000);

export const AUTO_COPY_MIN_DISTINCT_MARKETS = Number(process.env.AUTO_COPY_MIN_DISTINCT_MARKETS || 15);

export const AUTO_COPY_MIN_WIN_RATE_PCT = Number(process.env.AUTO_COPY_MIN_WIN_RATE_PCT || 75);

export const AUTO_COPY_MAX_AEP_CENTS = Number(process.env.AUTO_COPY_MAX_AEP_CENTS || 75);

export { WATCHED_WALLETS };

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}
