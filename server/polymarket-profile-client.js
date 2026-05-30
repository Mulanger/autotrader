import {
  POLYMARKET_DATA_API_URL,
  POLYMARKET_GAMMA_URL,
  POLYMARKET_PROFILE_REFRESH_CONCURRENCY,
} from './config.js';
import { fetchJson } from './fetch-json.js';

const WALLET_PATTERN = /^0x[a-fA-F0-9]{40}$/;

export async function fetchPolymarketProfileStatsForWallets(wallets = [], options = {}) {
  const uniqueWallets = [...new Set(wallets.map(normalizeWallet).filter(Boolean))];
  const concurrency = boundedConcurrency(options.concurrency ?? POLYMARKET_PROFILE_REFRESH_CONCURRENCY);
  const rows = [];
  let index = 0;

  async function worker() {
    while (index < uniqueWallets.length) {
      const wallet = uniqueWallets[index];
      index += 1;
      try {
        rows.push(await fetchPolymarketProfileStats(wallet, options));
      } catch (error) {
        rows.push({
          proxyWallet: wallet,
          wallet,
          profileStatsError: error.message,
          profileStatsSource: 'polymarket',
          profileStatsUpdatedAt: new Date().toISOString(),
        });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, uniqueWallets.length) }, worker));
  return rows;
}

export async function fetchPolymarketProfileStats(wallet, options = {}) {
  const normalized = normalizeWallet(wallet);
  if (!normalized) throw new Error(`Invalid wallet address: ${wallet}`);

  const [leaderboardResult, profileResult, tradedResult] = await Promise.allSettled([
    fetchPolymarketLeaderboardRow(normalized, options),
    fetchPublicProfile(normalized, options),
    fetchMarketsTraded(normalized, options),
  ]);
  const leaderboardFetched = leaderboardResult.status === 'fulfilled';
  const profileFetched = profileResult.status === 'fulfilled';
  const tradedFetched = tradedResult.status === 'fulfilled';

  if (!leaderboardFetched && !profileFetched && !tradedFetched) {
    throw new Error([
      leaderboardResult.reason?.message,
      profileResult.reason?.message,
      tradedResult.reason?.message,
    ].filter(Boolean).join('; ') || 'Polymarket profile requests failed');
  }

  const leaderboard = leaderboardFetched ? leaderboardResult.value : null;
  const profile = profileFetched ? profileResult.value : null;
  const traded = tradedFetched ? tradedResult.value : null;
  const errors = [
    leaderboardResult.status === 'rejected' ? `leaderboard: ${leaderboardResult.reason?.message}` : null,
    profileResult.status === 'rejected' ? `profile: ${profileResult.reason?.message}` : null,
    tradedResult.status === 'rejected' ? `traded: ${tradedResult.reason?.message}` : null,
  ].filter(Boolean);

  return {
    proxyWallet: normalized,
    wallet: normalized,
    displayName: stringOrNull(profile?.name || leaderboard?.userName),
    pseudonym: stringOrNull(profile?.pseudonym),
    profileImage: stringOrNull(profile?.profileImage || leaderboard?.profileImage),
    rank: leaderboardFetched ? numberOrNull(leaderboard?.rank) : undefined,
    allTimeProfitUsd: leaderboardFetched ? numberOrNull(leaderboard?.pnl) : undefined,
    allTimeVolumeUsd: leaderboardFetched ? numberOrNull(leaderboard?.vol) : undefined,
    allTimeMarketsTraded: tradedFetched ? numberOrNull(traded?.traded) : undefined,
    allTimePnlTradeCount: tradedFetched ? numberOrNull(traded?.traded) : undefined,
    allTimeWinRatePct: leaderboardFetched ? null : undefined,
    profileStatsSource: 'polymarket',
    profileStatsUpdatedAt: new Date().toISOString(),
    profileStatsErrors: errors,
  };
}

async function fetchPolymarketLeaderboardRow(wallet, options = {}) {
  const url = new URL('/v1/leaderboard', options.dataApiUrl || POLYMARKET_DATA_API_URL);
  url.searchParams.set('timePeriod', 'ALL');
  url.searchParams.set('orderBy', 'PNL');
  url.searchParams.set('limit', '1');
  url.searchParams.set('user', wallet);
  return firstItem(await fetchJson(url, options));
}

async function fetchPublicProfile(wallet, options = {}) {
  const url = new URL('/public-profile', options.gammaUrl || POLYMARKET_GAMMA_URL);
  url.searchParams.set('address', wallet);
  return await fetchJson(url, options);
}

async function fetchMarketsTraded(wallet, options = {}) {
  const url = new URL('/traded', options.dataApiUrl || POLYMARKET_DATA_API_URL);
  url.searchParams.set('user', wallet);
  return await fetchJson(url, options);
}

function firstItem(value) {
  if (Array.isArray(value)) return value[0] || null;
  if (Array.isArray(value?.items)) return value.items[0] || null;
  if (Array.isArray(value?.data)) return value.data[0] || null;
  if (Array.isArray(value?.value)) return value.value[0] || null;
  if (value && typeof value === 'object' && value.proxyWallet) return value;
  return null;
}

function normalizeWallet(value) {
  const wallet = String(value || '').trim().toLowerCase();
  return WALLET_PATTERN.test(wallet) ? wallet : null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stringOrNull(value) {
  const text = String(value || '').trim();
  return text ? text : null;
}

function boundedConcurrency(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) return 1;
  return Math.min(20, number);
}
