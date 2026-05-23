import { POLYMARKET_DATA_API_URL } from '../config.js';

export async function fetchDataApiTrades({ limit = 500, offset = 0, user = null } = {}) {
  const url = new URL('/trades', POLYMARKET_DATA_API_URL);
  url.searchParams.set('limit', String(limit));
  if (offset) url.searchParams.set('offset', String(offset));
  if (user) url.searchParams.set('user', user);

  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);

  const json = await response.json();
  return Array.isArray(json) ? json : [];
}
