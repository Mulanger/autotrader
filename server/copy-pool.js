import {
  AUTO_COPY_MAX_AEP_CENTS,
  AUTO_COPY_MIN_DISTINCT_MARKETS,
  AUTO_COPY_MIN_WIN_RATE_PCT,
  AUTO_COPY_REMOVE_MIN_WIN_RATE_PCT,
  CANDIDATE_BACKFILL_DAYS,
  WATCHED_WALLETS,
} from './config.js';
import { nowIso, shortWallet } from './format.js';

export function defaultCopyPoolThresholds(overrides = {}) {
  return {
    windowDays: numberOrFallback(overrides.windowDays, CANDIDATE_BACKFILL_DAYS),
    minDistinctResolvedMarkets: numberOrFallback(
      overrides.minDistinctResolvedMarkets,
      AUTO_COPY_MIN_DISTINCT_MARKETS
    ),
    minWinRatePct: numberOrFallback(overrides.minWinRatePct, AUTO_COPY_MIN_WIN_RATE_PCT),
    removeMinWinRatePct: numberOrFallback(overrides.removeMinWinRatePct, AUTO_COPY_REMOVE_MIN_WIN_RATE_PCT),
    maxAvgEntryPriceCents: numberOrFallback(overrides.maxAvgEntryPriceCents, AUTO_COPY_MAX_AEP_CENTS),
  };
}

export function createCopyPoolState(baselineWallets = WATCHED_WALLETS, options = {}) {
  const thresholds = defaultCopyPoolThresholds(options.thresholds || {});
  const wallets = {};
  for (const wallet of baselineWallets) {
    const normalized = normalizeWallet(wallet);
    if (!normalized) continue;
    wallets[normalized] = makeCopyPoolWallet({
      wallet: normalized,
      source: 'baseline',
      status: 'active',
      protected: true,
      reason: 'Protected baseline wallet',
    });
  }

  return {
    enabled: true,
    thresholds,
    counts: summarizeCopyPoolWallets(wallets),
    lastEvaluatedAt: null,
    wallets,
    recentAdded: [],
    recentRemoved: [],
  };
}

export function applyCopyPoolSnapshot(state, snapshot = {}) {
  const current = state.copyPool || createCopyPoolState(WATCHED_WALLETS);
  const thresholds = defaultCopyPoolThresholds(snapshot.thresholds || current.thresholds || {});
  const snapshotWallets = normalizeSnapshotWallets(snapshot.wallets);
  const wallets = {};

  for (const wallet of WATCHED_WALLETS) {
    const normalized = normalizeWallet(wallet);
    if (!normalized) continue;
    wallets[normalized] = makeCopyPoolWallet({
      ...(current.wallets?.[normalized] || {}),
      ...(snapshotWallets[normalized] || {}),
      wallet: normalized,
      source: 'baseline',
      status: 'active',
      protected: true,
      reason: snapshotWallets[normalized]?.reason || current.wallets?.[normalized]?.reason || 'Protected baseline wallet',
    });
  }

  for (const [wallet, row] of Object.entries(snapshotWallets)) {
    const normalized = normalizeWallet(wallet);
    if (!normalized || wallets[normalized]) continue;
    wallets[normalized] = makeCopyPoolWallet({
      ...(current.wallets?.[normalized] || {}),
      ...row,
      wallet: normalized,
      source: row.source || 'auto',
      status: row.status === 'active' ? 'active' : 'removed',
      protected: Boolean(row.protected),
    });
  }

  state.copyPool = {
    ...current,
    ...snapshot,
    enabled: snapshot.enabled ?? current.enabled ?? true,
    thresholds,
    wallets,
    counts: snapshot.counts || summarizeCopyPoolWallets(wallets),
    lastEvaluatedAt: snapshot.lastEvaluatedAt || current.lastEvaluatedAt || null,
    recentAdded: Array.isArray(snapshot.recentAdded) ? snapshot.recentAdded : current.recentAdded || [],
    recentRemoved: Array.isArray(snapshot.recentRemoved) ? snapshot.recentRemoved : current.recentRemoved || [],
  };

  state.watchedWallets = activeCopyPoolWallets(wallets);
  for (const wallet of state.watchedWallets) {
    ensureTraderProfile(state, wallet, wallets[wallet]);
  }

  return state.copyPool;
}

export function activeCopyPoolWallets(wallets = {}) {
  const rows = Object.values(wallets)
    .filter((row) => row?.status === 'active')
    .sort((a, b) => {
      if (a.protected !== b.protected) return a.protected ? -1 : 1;
      return Date.parse(a.addedAt || a.firstAddedAt || 0) - Date.parse(b.addedAt || b.firstAddedAt || 0);
    });
  return rows.map((row) => row.wallet);
}

export function isWalletWatched(state, wallet) {
  const normalized = normalizeWallet(wallet);
  if (!normalized) return false;
  const row = state.copyPool?.wallets?.[normalized];
  if (row) return row.status === 'active';
  return WATCHED_WALLETS.map(normalizeWallet).includes(normalized);
}

export function ensureTraderProfile(state, wallet, profile = {}) {
  const normalized = normalizeWallet(wallet);
  if (!normalized) return null;
  const existing = state.traders?.[normalized] || {};
  const next = {
    ...existing,
    wallet: normalized,
    label: existing.label || shortWallet(normalized),
    displayName: profile.displayName || profile.display_name || existing.displayName || null,
    pseudonym: profile.pseudonym || existing.pseudonym || null,
    profileImage: profile.profileImage || profile.profile_image || existing.profileImage || null,
    allTimeProfitUsd: existing.allTimeProfitUsd ?? null,
    allTimeWinRatePct: existing.allTimeWinRatePct ?? null,
    allTimePnlTradeCount: existing.allTimePnlTradeCount ?? null,
    recentFormResults: existing.recentFormResults || [],
    recentTrades: existing.recentTrades || [],
    observedCount: existing.observedCount || 0,
    copiedCount: existing.copiedCount || 0,
    skippedCount: existing.skippedCount || 0,
    lastSeenAt: existing.lastSeenAt || null,
  };
  state.traders[normalized] = next;
  return next;
}

export function buildCopyPoolMetrics(trades = [], options = {}) {
  const thresholds = defaultCopyPoolThresholds(options.thresholds || {});
  const nowMs = Date.parse(options.now || nowIso());
  const cutoffMs = nowMs - thresholds.windowDays * 24 * 60 * 60 * 1000;
  const buyTrades = trades.filter((trade) => {
    const tradeTime = Date.parse(trade.tradeTimestamp || trade.timestamp || 0);
    return (
      String(trade.side || '').toUpperCase() === 'BUY' &&
      Number.isFinite(tradeTime) &&
      tradeTime >= cutoffMs
    );
  });
  const entryTrades = buyTrades.filter((trade) => {
    return Number(trade.shares) > 0 && Number.isFinite(Number(trade.usdSize));
  });
  const entryUsd = entryTrades.reduce((sum, trade) => sum + Number(trade.usdSize || 0), 0);
  const entryShares = entryTrades.reduce((sum, trade) => sum + Number(trade.shares || 0), 0);
  const avgEntryPriceCents30d = entryShares > 0 ? (entryUsd / entryShares) * 100 : null;

  const distinctResolved = new Map();
  const resolvedTrades = buyTrades
    .filter((trade) => ['resolved_win', 'resolved_loss'].includes(String(trade.status || '').toLowerCase()))
    .sort(compareResolvedNewest);

  for (const trade of resolvedTrades) {
    const key = marketKey(trade);
    if (!key || distinctResolved.has(key)) continue;
    distinctResolved.set(key, trade);
  }

  const resolved = [...distinctResolved.values()];
  const winCount = resolved.filter((trade) => String(trade.status || '').toLowerCase() === 'resolved_win').length;
  const distinctResolvedTradeCount = resolved.length;
  const winRatePct = distinctResolvedTradeCount ? (winCount / distinctResolvedTradeCount) * 100 : null;
  const metrics = {
    distinctResolvedTradeCount,
    winCount,
    winRatePct,
    avgEntryPriceCents30d,
    avgEntryTradeCount30d: entryTrades.length,
  };

  return {
    ...metrics,
    eligible: isCopyPoolEligible(metrics, thresholds),
    retained: isCopyPoolRetained(metrics, thresholds),
    reason: copyPoolEligibilityReason(metrics, thresholds),
    retentionReason: copyPoolRetentionReason(metrics, thresholds),
  };
}

export function isCopyPoolEligible(metrics, thresholds = defaultCopyPoolThresholds()) {
  return (
    Number(metrics.distinctResolvedTradeCount || 0) >= thresholds.minDistinctResolvedMarkets &&
    Number(metrics.winRatePct || 0) >= thresholds.minWinRatePct &&
    Number.isFinite(Number(metrics.avgEntryPriceCents30d)) &&
    Number(metrics.avgEntryPriceCents30d) < thresholds.maxAvgEntryPriceCents
  );
}

export function isCopyPoolRetained(metrics, thresholds = defaultCopyPoolThresholds()) {
  return (
    Number(metrics.distinctResolvedTradeCount || 0) >= thresholds.minDistinctResolvedMarkets &&
    Number(metrics.winRatePct || 0) >= thresholds.removeMinWinRatePct &&
    Number.isFinite(Number(metrics.avgEntryPriceCents30d)) &&
    Number(metrics.avgEntryPriceCents30d) < thresholds.maxAvgEntryPriceCents
  );
}

export function copyPoolEligibilityReason(metrics, thresholds = defaultCopyPoolThresholds()) {
  const distinctCount = Number(metrics.distinctResolvedTradeCount || 0);
  if (distinctCount < thresholds.minDistinctResolvedMarkets) {
    return `Needs ${thresholds.minDistinctResolvedMarkets} resolved distinct BUY markets; has ${distinctCount}`;
  }

  const winRate = Number(metrics.winRatePct || 0);
  if (winRate < thresholds.minWinRatePct) {
    return `Win rate ${winRate.toFixed(1)}% below ${thresholds.minWinRatePct.toFixed(1)}%`;
  }

  const aep = Number(metrics.avgEntryPriceCents30d);
  if (!Number.isFinite(aep)) return 'No trailing 30-day BUY entry price';
  if (aep >= thresholds.maxAvgEntryPriceCents) {
    return `AEP ${aep.toFixed(1)}c at or above ${thresholds.maxAvgEntryPriceCents.toFixed(1)}c`;
  }

  return 'Eligible';
}

export function copyPoolRetentionReason(metrics, thresholds = defaultCopyPoolThresholds()) {
  const distinctCount = Number(metrics.distinctResolvedTradeCount || 0);
  if (distinctCount < thresholds.minDistinctResolvedMarkets) {
    return `Removal threshold missed: needs ${thresholds.minDistinctResolvedMarkets} resolved distinct BUY markets; has ${distinctCount}`;
  }

  const winRate = Number(metrics.winRatePct || 0);
  if (winRate < thresholds.removeMinWinRatePct) {
    return `Removal threshold missed: win rate ${winRate.toFixed(1)}% below ${thresholds.removeMinWinRatePct.toFixed(1)}%`;
  }

  const aep = Number(metrics.avgEntryPriceCents30d);
  if (!Number.isFinite(aep)) return 'Removal threshold missed: no trailing 30-day BUY entry price';
  if (aep >= thresholds.maxAvgEntryPriceCents) {
    return `Removal threshold missed: AEP ${aep.toFixed(1)}c at or above ${thresholds.maxAvgEntryPriceCents.toFixed(1)}c`;
  }

  return 'Retained by removal threshold';
}

export function makeCopyPoolWallet(row = {}) {
  const wallet = normalizeWallet(row.wallet);
  return {
    wallet,
    source: row.source || 'auto',
    status: row.status === 'active' ? 'active' : 'removed',
    protected: Boolean(row.protected),
    displayName: row.displayName || row.display_name || null,
    pseudonym: row.pseudonym || null,
    profileImage: row.profileImage || row.profile_image || null,
    distinctResolvedTradeCount: numberOrFallback(row.distinctResolvedTradeCount ?? row.distinct_resolved_trade_count, 0),
    winCount: numberOrFallback(row.winCount ?? row.win_count, 0),
    winRatePct: nullableNumber(row.winRatePct ?? row.win_rate_pct),
    avgEntryPriceCents30d: nullableNumber(row.avgEntryPriceCents30d ?? row.avg_entry_price_cents_30d),
    avgEntryTradeCount30d: numberOrFallback(row.avgEntryTradeCount30d ?? row.avg_entry_trade_count_30d, 0),
    eligible: Boolean(row.eligible ?? row.payload?.eligible),
    retained: Boolean(row.retained ?? row.payload?.retained),
    reason: row.reason || null,
    retentionReason: row.retentionReason || row.retention_reason || row.payload?.retentionReason || null,
    firstAddedAt: row.firstAddedAt || row.first_added_at || null,
    addedAt: row.addedAt || row.added_at || null,
    removedAt: row.removedAt || row.removed_at || null,
    lastEvaluatedAt: row.lastEvaluatedAt || row.last_evaluated_at || null,
  };
}

export function normalizeWallet(wallet) {
  const text = String(wallet || '').trim().toLowerCase();
  return text || null;
}

function normalizeSnapshotWallets(wallets) {
  if (!wallets) return {};
  const entries = Array.isArray(wallets)
    ? wallets.map((row) => [row?.wallet, row])
    : Object.entries(wallets);
  const normalized = {};
  for (const [wallet, row] of entries) {
    const key = normalizeWallet(wallet || row?.wallet);
    if (!key) continue;
    normalized[key] = makeCopyPoolWallet({ ...row, wallet: key });
  }
  return normalized;
}

function summarizeCopyPoolWallets(wallets = {}) {
  const rows = Object.values(wallets);
  return {
    active: rows.filter((row) => row.status === 'active').length,
    protectedActive: rows.filter((row) => row.status === 'active' && row.protected).length,
    autoActive: rows.filter((row) => row.status === 'active' && row.source === 'auto').length,
    autoRemoved: rows.filter((row) => row.status === 'removed' && row.source === 'auto').length,
  };
}

function marketKey(trade) {
  return String(trade.conditionId || trade.condition_id || trade.marketSlug || trade.market_slug || trade.marketTitle || '').toLowerCase();
}

function compareResolvedNewest(a, b) {
  const aTime = Date.parse(a.resolvedAt || a.resolved_at || a.tradeTimestamp || a.trade_timestamp || 0);
  const bTime = Date.parse(b.resolvedAt || b.resolved_at || b.tradeTimestamp || b.trade_timestamp || 0);
  if (bTime !== aTime) return bTime - aTime;
  return String(b.id || '').localeCompare(String(a.id || ''));
}

function numberOrFallback(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
