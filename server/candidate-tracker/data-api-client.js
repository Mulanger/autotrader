import { POLYMARKET_DATA_API_URL } from '../config.js';
import { fetchJson, isHttpStatus } from '../fetch-json.js';

export async function fetchDataApiTrades({
  limit = 500,
  offset = 0,
  user = null,
  side = null,
  filterType = null,
  filterAmount = null,
  takerOnly = null,
} = {}) {
  const url = new URL('/trades', POLYMARKET_DATA_API_URL);
  url.searchParams.set('limit', String(limit));
  if (offset) url.searchParams.set('offset', String(offset));
  if (user) url.searchParams.set('user', user);
  if (side) url.searchParams.set('side', side);
  if (filterType && filterAmount !== null && filterAmount !== undefined) {
    url.searchParams.set('filterType', filterType);
    url.searchParams.set('filterAmount', String(filterAmount));
  }
  if (takerOnly !== null && takerOnly !== undefined) url.searchParams.set('takerOnly', String(Boolean(takerOnly)));

  const json = await fetchJson(url);
  return Array.isArray(json) ? json : [];
}

export function isDataApiOffsetLimitError(error) {
  return isHttpStatus(error, 400) && String(error.url || error.message || '').includes('offset=');
}
