import { POLYMARKET_CLOB_URL } from '../config.js';
import { fetchJson } from '../fetch-json.js';

export async function fetchOrderBook(tokenId) {
  if (!tokenId) throw new Error('Missing token id for order book lookup');
  const url = new URL('/book', POLYMARKET_CLOB_URL);
  url.searchParams.set('token_id', tokenId);
  return fetchJson(url);
}

export async function fetchClobMarketInfo(conditionId) {
  if (!conditionId) throw new Error('Missing condition id for CLOB market lookup');
  const url = new URL(`/clob-markets/${encodeURIComponent(conditionId)}`, POLYMARKET_CLOB_URL);
  return fetchJson(url);
}
