import { WATCHED_WALLETS } from './watched-wallets.js';

export const POLYWHALE_API_BASE_URL =
  process.env.POLYWHALE_API_BASE_URL || 'https://whaleserver-production.up.railway.app';

export const POLYWHALE_WS_URL =
  POLYWHALE_API_BASE_URL.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:') + '/v1/whales/stream';

export const PORT = Number(process.env.PORT || 4101);

export const HOST = process.env.HOST || '0.0.0.0';

export const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 20_000);

export const DEMO_STARTING_CAPITAL_USD = 100;

export const DEMO_STAKE_USD = 10;

export { WATCHED_WALLETS };
