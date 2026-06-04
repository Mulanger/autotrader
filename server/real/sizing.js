import { fetchDataApiTrades, isDataApiOffsetLimitError } from '../candidate-tracker/data-api-client.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HISTORY_DAYS = 90;
const DEFAULT_PAGE_LIMIT = 500;
const DEFAULT_MAX_PAGES = 20;
const DEFAULT_MIN_BASELINE_MARKETS = 5;
const DEFAULT_BASELINE_TTL_MS = 3 * 60 * 60 * 1000;
const DEFAULT_SIGNAL_TTL_MS = 90 * 1000;

export function createTraderSizingService(options = {}) {
  const fetchTrades = options.fetchTrades || fetchDataApiTrades;
  const historyDays = positiveInteger(options.historyDays, DEFAULT_HISTORY_DAYS);
  const pageLimit = positiveInteger(options.pageLimit, DEFAULT_PAGE_LIMIT);
  const maxPages = positiveInteger(options.maxPages, DEFAULT_MAX_PAGES);
  const minBaselineMarkets = positiveInteger(options.minBaselineMarkets, DEFAULT_MIN_BASELINE_MARKETS);
  const baselineTtlMs = positiveInteger(options.baselineTtlMs, DEFAULT_BASELINE_TTL_MS);
  const signalTtlMs = positiveInteger(options.signalTtlMs, DEFAULT_SIGNAL_TTL_MS);
  const now = options.now || (() => Date.now());
  const tradeCache = new Map();
  const baselineCache = new Map();
  const signalCache = new Map();

  async function getBatchSizing(items = []) {
    const normalizedItems = (Array.isArray(items) ? items : [])
      .slice(0, 50)
      .map(normalizeSizingRequest)
      .filter(Boolean);
    const results = [];
    const generatedAt = new Date(now()).toISOString();

    for (const item of normalizedItems) {
      results.push(await getSizing(item));
    }

    return { ok: true, generatedAt, items: results };
  }

  async function getSizing(item) {
    const cacheKey = sizingCacheKey(item);
    const cached = signalCache.get(cacheKey);
    if (cached && cached.expiresAt > now()) return cached.value;

    let value;
    try {
      const history = await getWalletTrades(item.wallet);
      const baseline = getWalletBaseline(item.wallet, history);
      value = calculateSizingSignal({
        item,
        trades: history.trades,
        baselineGroups: baseline.groups,
        partial: history.partial || baseline.partial,
        historyTradeCount: history.rawTradeCount,
        minBaselineMarkets,
      });
    } catch (error) {
      value = unavailableSizing(item, 'error', error.message || 'Sizing lookup failed');
    }

    signalCache.set(cacheKey, { value, expiresAt: now() + signalTtlMs });
    return value;
  }

  async function getWalletTrades(wallet) {
    const cached = tradeCache.get(wallet);
    if (cached && cached.expiresAt > now()) {
      if (cached.promise) return cached.promise;
      return cached.value;
    }

    const promise = fetchWalletHistory({ wallet, fetchTrades, historyDays, pageLimit, maxPages, now })
      .then((value) => {
        tradeCache.set(wallet, { value, expiresAt: now() + signalTtlMs });
        return value;
      })
      .catch((error) => {
        tradeCache.delete(wallet);
        throw error;
      });
    tradeCache.set(wallet, { promise, expiresAt: now() + signalTtlMs });
    return promise;
  }

  function getWalletBaseline(wallet, history) {
    const cached = baselineCache.get(wallet);
    if (cached && cached.expiresAt > now()) return cached.value;
    const value = {
      groups: buildExposureGroups(history.trades),
      partial: Boolean(history.partial),
      rawTradeCount: history.rawTradeCount,
    };
    baselineCache.set(wallet, { value, expiresAt: now() + baselineTtlMs });
    return value;
  }

  return { getBatchSizing, getSizing };
}

export async function fetchWalletHistory({ wallet, fetchTrades, historyDays = DEFAULT_HISTORY_DAYS, pageLimit = DEFAULT_PAGE_LIMIT, maxPages = DEFAULT_MAX_PAGES, now = () => Date.now() }) {
  const cutoffMs = now() - positiveInteger(historyDays, DEFAULT_HISTORY_DAYS) * DAY_MS;
  const trades = [];
  let rawTradeCount = 0;
  let reachedCutoff = false;
  let reachedEnd = false;
  let partial = false;
  let partialReason = null;

  for (let page = 0; page < maxPages && !reachedCutoff; page += 1) {
    const offset = page * pageLimit;
    let rawTrades;
    try {
      rawTrades = await fetchTrades({ user: wallet, limit: pageLimit, offset });
    } catch (error) {
      if (page > 0 && isDataApiOffsetLimitError(error)) {
        partial = true;
        partialReason = `Data API rejected offset ${offset}`;
        break;
      }
      throw error;
    }

    if (!rawTrades.length) {
      reachedEnd = true;
      break;
    }
    rawTradeCount += rawTrades.length;

    for (const raw of rawTrades) {
      const trade = normalizeSizingTrade(raw);
      if (!trade || trade.wallet !== wallet) continue;
      if (trade.timestampMs < cutoffMs) {
        reachedCutoff = true;
        continue;
      }
      trades.push(trade);
    }
  }

  if (!reachedCutoff && !reachedEnd && !partial) {
    partial = true;
    partialReason = `Stopped after ${maxPages} Data API pages`;
  }

  trades.sort((a, b) => a.timestampMs - b.timestampMs || String(a.id).localeCompare(String(b.id)));
  return { trades, rawTradeCount, partial, partialReason };
}

export function calculateSizingSignal({ item, trades = [], baselineGroups = null, partial = false, historyTradeCount = null, minBaselineMarkets = DEFAULT_MIN_BASELINE_MARKETS } = {}) {
  const request = normalizeSizingRequest(item);
  if (!request) return unavailableSizing(item, 'invalid_request', 'Sizing request is missing wallet or market information');

  const groups = buildExposureGroups(trades);
  const currentGroup = groups.find((group) => group.key === request.marketKey);
  if (!currentGroup) {
    return unavailableSizing(request, 'no_current_exposure', 'No current market exposure found in fresh Data API history', {
      partial,
      historyTradeCount,
    });
  }

  const historicalGroups = Array.isArray(baselineGroups) ? baselineGroups : groups;
  const baselineValues = historicalGroups
    .filter((group) => group.key !== request.marketKey && group.peakExposureUsd > 0)
    .map((group) => group.peakExposureUsd)
    .sort((a, b) => a - b);
  const baselineMarketCount = baselineValues.length;
  if (baselineMarketCount < minBaselineMarkets) {
    return unavailableSizing(request, 'insufficient_history', 'Not enough prior markets to estimate this trader unit size', {
      partial,
      historyTradeCount,
      current: groupToCurrentPayload(currentGroup, request),
      baselineMarketCount,
    });
  }

  const usualUnitUsd = median(baselineValues);
  if (!Number.isFinite(usualUnitUsd) || usualUnitUsd <= 0) {
    return unavailableSizing(request, 'insufficient_history', 'Historical unit size could not be estimated', {
      partial,
      historyTradeCount,
      current: groupToCurrentPayload(currentGroup, request),
      baselineMarketCount,
    });
  }

  const currentPrice = request.sourcePriceCents !== null
    ? request.sourcePriceCents / 100
    : currentGroup.latestPrice;
  const currentExposureUsd = Math.max(0, currentGroup.netShares) * Math.max(0, currentPrice || 0);
  const multiple = currentExposureUsd / usualUnitUsd;
  const label = labelSizingMultiple(multiple);

  return {
    id: request.id,
    wallet: request.wallet,
    status: 'ok',
    label: label.label,
    tone: label.tone,
    multiple: round(multiple, 4),
    currentExposureUsd: round(currentExposureUsd, 4),
    usualUnitUsd: round(usualUnitUsd, 4),
    baselineMarketCount,
    historyTradeCount,
    partial,
    reason: partial ? 'Sizing history may be partial due to Data API pagination limits' : null,
    current: groupToCurrentPayload(currentGroup, request, currentPrice),
  };
}

export function buildExposureGroups(trades = []) {
  const groups = new Map();
  for (const trade of trades) {
    const normalized = normalizeSizingTrade(trade);
    if (!normalized) continue;
    const key = marketOutcomeKey(normalized);
    if (!key) continue;

    const current = groups.get(key) || {
      key,
      wallet: normalized.wallet,
      conditionId: normalized.conditionId,
      marketSlug: normalized.marketSlug,
      marketTitle: normalized.marketTitle,
      outcome: normalized.outcome,
      outcomeIndex: normalized.outcomeIndex,
      netShares: 0,
      peakExposureUsd: 0,
      latestPrice: null,
      latestTradeAt: null,
      tradeCount: 0,
    };

    const delta = normalized.side === 'SELL' ? -normalized.shares : normalized.shares;
    current.netShares = Math.max(0, current.netShares + delta);
    current.latestPrice = normalized.price;
    current.latestTradeAt = normalized.tradeTimestamp;
    current.tradeCount += 1;
    current.peakExposureUsd = Math.max(current.peakExposureUsd, current.netShares * normalized.price);
    groups.set(key, current);
  }
  return [...groups.values()];
}

export function normalizeSizingTrade(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const wallet = normalizeWallet(raw.proxyWallet || raw.traderWallet || raw.wallet);
  const side = String(raw.side || '').trim().toUpperCase();
  const price = numberOrNull(raw.price);
  const shares = numberOrNull(raw.size ?? raw.shares);
  const timestampMs = toTimestampMs(raw.timestamp ?? raw.createdAt ?? raw.ts ?? raw.tradeTimestamp);
  if (!wallet || !['BUY', 'SELL'].includes(side) || !Number.isFinite(price) || price <= 0 || !Number.isFinite(shares) || shares <= 0 || !Number.isFinite(timestampMs)) {
    return null;
  }
  const conditionId = stringOrNull(raw.conditionId || raw.condition_id);
  const marketSlug = stringOrNull(raw.slug || raw.marketSlug || raw.market_slug);
  const marketTitle = stringOrNull(raw.title || raw.question || raw.marketTitle || raw.market_title);
  const outcome = stringOrNull(raw.outcome || raw.tokenOutcome);
  const outcomeIndex = integerOrNull(raw.outcomeIndex ?? raw.outcome_index);
  const asset = stringOrNull(raw.asset || raw.tokenId || raw.token_id);

  return {
    id: stringOrNull(raw.id || raw.transactionHash || raw.txHash) || `${wallet}-${timestampMs}-${side}-${shares}-${price}`,
    wallet,
    side,
    price,
    priceCents: price * 100,
    shares,
    usdSize: price * shares,
    timestampMs,
    tradeTimestamp: new Date(timestampMs).toISOString(),
    asset,
    conditionId,
    marketSlug,
    marketTitle,
    outcome,
    outcomeIndex,
  };
}

export function normalizeSizingRequest(item) {
  if (!item || typeof item !== 'object') return null;
  const wallet = normalizeWallet(item.wallet || item.traderWallet);
  const normalized = {
    id: stringOrNull(item.id || item.orderId || item.sourceTradeId) || null,
    wallet,
    asset: stringOrNull(item.asset),
    conditionId: stringOrNull(item.conditionId || item.condition_id),
    marketSlug: stringOrNull(item.marketSlug || item.market_slug),
    marketTitle: stringOrNull(item.marketTitle || item.market_title),
    outcome: stringOrNull(item.outcome),
    outcomeIndex: integerOrNull(item.outcomeIndex ?? item.outcome_index ?? item.sourceTrade?.outcomeIndex),
    sourcePriceCents: numberOrNull(item.sourcePriceCents ?? item.source_price_cents),
  };
  normalized.marketKey = marketOutcomeKey(normalized);
  if (!normalized.id || !normalized.wallet || !normalized.marketKey) return null;
  return normalized;
}

export function labelSizingMultiple(multiple) {
  const value = Number(multiple);
  if (!Number.isFinite(value)) return { label: 'unknown', tone: 'neutral' };
  if (value < 0.5) return { label: 'probe/small', tone: 'neutral' };
  if (value < 1.5) return { label: 'normal', tone: 'neutral' };
  if (value < 2.5) return { label: 'conviction', tone: 'positive' };
  if (value < 5) return { label: 'high conviction', tone: 'positive' };
  return { label: 'extreme/outsized', tone: 'negative' };
}

function unavailableSizing(item, status, reason, extras = {}) {
  const request = normalizeSizingRequest(item) || item || {};
  return {
    id: request.id || null,
    wallet: request.wallet || normalizeWallet(request.traderWallet) || null,
    status,
    label: status === 'insufficient_history' ? 'insufficient history' : 'sizing unavailable',
    tone: 'neutral',
    multiple: null,
    currentExposureUsd: null,
    usualUnitUsd: null,
    baselineMarketCount: extras.baselineMarketCount ?? null,
    historyTradeCount: extras.historyTradeCount ?? null,
    partial: Boolean(extras.partial),
    reason,
    current: extras.current || null,
  };
}

function groupToCurrentPayload(group, request, markPrice = null) {
  const price = Number.isFinite(markPrice) ? markPrice : group.latestPrice;
  return {
    marketTitle: request.marketTitle || group.marketTitle || null,
    outcome: request.outcome || group.outcome || null,
    netShares: round(group.netShares, 4),
    latestPriceCents: Number.isFinite(price) ? round(price * 100, 4) : null,
    latestTradeAt: group.latestTradeAt,
    tradeCount: group.tradeCount,
  };
}

function marketOutcomeKey(item) {
  const outcomePart = item.outcomeIndex !== null && item.outcomeIndex !== undefined
    ? `idx:${item.outcomeIndex}`
    : item.outcome
      ? `out:${String(item.outcome).trim().toLowerCase()}`
      : item.asset
        ? `asset:${String(item.asset).trim().toLowerCase()}`
        : '';
  const marketPart = item.conditionId
    ? `condition:${String(item.conditionId).trim().toLowerCase()}`
    : item.marketSlug
      ? `slug:${String(item.marketSlug).trim().toLowerCase()}`
      : item.marketTitle
        ? `title:${String(item.marketTitle).trim().toLowerCase()}`
        : item.asset
          ? `asset:${String(item.asset).trim().toLowerCase()}`
          : '';
  if (!marketPart || !outcomePart) return null;
  return `${marketPart}|${outcomePart}`;
}

function sizingCacheKey(item) {
  return [
    item.wallet,
    item.marketKey,
    item.sourcePriceCents === null ? '' : Number(item.sourcePriceCents).toFixed(4),
  ].join('|');
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[midpoint];
  return (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}

function normalizeWallet(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(text) ? text : null;
}

function stringOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integerOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function toTimestampMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value > 10_000_000_000 ? Math.floor(value) : Math.floor(value * 1000);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function round(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}
