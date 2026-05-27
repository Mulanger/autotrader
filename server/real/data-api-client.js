import { POLYMARKET_DATA_API_URL, REAL_FOLLOW_POLL_LIMIT } from '../config.js';
import { fetchJson } from '../fetch-json.js';

export async function fetchRealFollowTrades({ user, limit = REAL_FOLLOW_POLL_LIMIT, offset = 0, side = 'BUY' } = {}) {
  if (!user) return [];
  const url = new URL('/trades', POLYMARKET_DATA_API_URL);
  url.searchParams.set('user', user);
  url.searchParams.set('limit', String(limit));
  if (offset) url.searchParams.set('offset', String(offset));
  if (side) url.searchParams.set('side', side);

  const json = await fetchJson(url);
  return Array.isArray(json) ? json : [];
}
