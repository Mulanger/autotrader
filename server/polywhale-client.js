import { POLYWHALE_API_BASE_URL, WATCHED_WALLETS } from './config.js';
import { normalizeTrade } from './trade-normalizer.js';

export async function fetchRecentWhales(limit = 80) {
  const url = new URL('/v1/whales', POLYWHALE_API_BASE_URL);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('minUsd', '10000');

  const json = await fetchJson(url);
  return Array.isArray(json.items) ? json.items.map(normalizeTrade).filter(Boolean) : [];
}

export async function fetchWatchedWalletHistory(wallet, limit = 20) {
  const url = new URL('/v1/whales', POLYWHALE_API_BASE_URL);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('minUsd', '10000');
  url.searchParams.set('traderWallet', wallet);

  const json = await fetchJson(url);
  return Array.isArray(json.items) ? json.items.map(normalizeTrade).filter(Boolean) : [];
}

export async function fetchProfitLeaderboard(limit = 100) {
  const url = new URL('/v1/leaderboard', POLYWHALE_API_BASE_URL);
  url.searchParams.set('sort', 'profit');
  url.searchParams.set('limit', String(limit));
  const json = await fetchJson(url);
  return Array.isArray(json.items) ? json.items : [];
}

export async function fetchWhaleTrade(tradeId) {
  if (!tradeId) return null;

  try {
    const url = new URL(`/v1/whales/${encodeURIComponent(tradeId)}`, POLYWHALE_API_BASE_URL);
    return normalizeTrade(await fetchJson(url));
  } catch (error) {
    const detailUrl = new URL(`/v1/whales/${encodeURIComponent(tradeId)}/detail`, POLYWHALE_API_BASE_URL);
    const detail = await fetchJson(detailUrl);
    const trade = detail.trade || detail.item || detail;
    if (detail.market && trade.market) trade.market = { ...trade.market, ...detail.market };
    return normalizeTrade(trade);
  }
}

export async function fetchBootstrapTrades() {
  const [recent, watched] = await Promise.all([
    fetchRecentWhales(100),
    Promise.all(WATCHED_WALLETS.map((wallet) => fetchWatchedWalletHistory(wallet, 12).catch(() => []))),
  ]);
  return [...recent, ...watched.flat()].sort((a, b) => a.timestamp - b.timestamp);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }
  return response.json();
}
