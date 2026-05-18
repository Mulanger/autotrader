export const POLYWHALE_API_BASE_URL =
  process.env.POLYWHALE_API_BASE_URL || 'https://whaleserver-production.up.railway.app';

export const POLYWHALE_WS_URL =
  POLYWHALE_API_BASE_URL.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:') + '/v1/whales/stream';

export const PORT = Number(process.env.PORT || 4101);

export const HOST = process.env.HOST || '0.0.0.0';

export const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 20_000);

export const DEMO_STARTING_CAPITAL_USD = 100;

export const DEMO_STAKE_USD = 10;

export const WATCHED_WALLETS = [
  '0x531b33c5e7b8c2610917f883a13a1b8b1a706022',
  '0x1887879a1bda615e88f280b582514c7d54e2678a',
  '0xc2e7800b5af46e6093872b177b7a5e7f0563be51',
  '0x7c585894ec02d5ed4fcd118ad8982f859360a5a1',
  '0x93abbc022ce98d6f45d4444b594791cc4b7a9723',
  '0xdd92232bcdfbbac04132b3cbacbf32c2e5b16b2a',
  '0x8b5239494dd65eed682f0d9f0481ddeae4ff568e',
  '0xf9c1190aa8184bcbe418e6f5321c53b0bfbc39e2',
  '0xfea31bc088000ff909be1dfd8d0e3f2c7ef2d227',
];
