import {
  REAL_ACTION_PIN,
  REAL_DRY_RUN_STAKE_USD,
  REAL_FOLLOW_POLL_INTERVAL_MS,
  REAL_LIVE_TRADING_ENABLED,
  REAL_MAX_ENTRY_PRICE_CENTS,
  REAL_PRICE_GUARD_CENTS,
  REAL_STAKE_USD,
  REAL_TRADING_MODE,
  RESOLUTION_POLL_INTERVAL_MS,
} from '../config.js';
import { fetchGammaResolution } from '../polymarket-client.js';
import { fetchClobMarketInfo, fetchOrderBook } from './clob-client.js';
import { fetchRealFollowTrades } from './data-api-client.js';
import { createPolymarketLiveExecutor } from './live-executor.js';
import { resolveTradeToken } from './market.js';
import { normalizeRealTrade } from './normalizer.js';
import { evaluateDryRunFokBuy, normalizeLevels } from './quote-engine.js';
import { createRealStorage } from './storage.js';

export function createRealTraderService(state, broadcast = () => {}, options = {}) {
  const storageFactory = options.storageFactory || createRealStorage;
  const fetchTrades = options.fetchRealFollowTrades || fetchRealFollowTrades;
  const fetchBook = options.fetchOrderBook || fetchOrderBook;
  const fetchMarketInfo = options.fetchClobMarketInfo || fetchClobMarketInfo;
  const fetchResolution = options.fetchGammaResolution || fetchGammaResolution;
  const pollIntervalMs = options.pollIntervalMs ?? REAL_FOLLOW_POLL_INTERVAL_MS;
  const resolutionIntervalMs = options.resolutionIntervalMs ?? RESOLUTION_POLL_INTERVAL_MS;
  const tradingMode = normalizeTradingMode(options.tradingMode ?? REAL_TRADING_MODE);
  const liveTradingEnabled = options.liveTradingEnabled ?? REAL_LIVE_TRADING_ENABLED;
  const liveExecutor = options.liveExecutor || createPolymarketLiveExecutor();
  const stakeUsd = options.stakeUsd ?? (tradingMode === 'live' ? REAL_STAKE_USD : REAL_DRY_RUN_STAKE_USD);
  const guardCents = options.guardCents ?? REAL_PRICE_GUARD_CENTS;
  const maxEntryPriceCents = options.maxEntryPriceCents ?? REAL_MAX_ENTRY_PRICE_CENTS;
  const setTimer = options.setInterval || setInterval;
  const clearTimer = options.clearInterval || clearInterval;
  const autoRun = options.autoRun !== false;

  let storage = null;
  let pollTimer = null;
  let resolutionTimer = null;
  let pollRunning = false;
  let resolutionRunning = false;

  async function start() {
    state.service.real = {
      ...(state.service.real || {}),
      status: 'starting',
      mode: tradingMode,
      liveExecutionEnabled: isLiveExecutionRequested(),
      liveExecutionReady: liveReadiness().ready,
      liveExecutionConfig: liveReadiness(),
      stakeUsd,
      priceGuardCents: guardCents,
      maxEntryPriceCents,
    };
    broadcast();
    storage = await storageFactory();
    state.service.real.status = 'ready';
    state.service.real.storageMode = storage.mode;
    state.service.real.durable = Boolean(storage.durable);
    state.service.real.migrateError = storage.migrateError || null;
    await refreshState();

    if (autoRun) {
      pollTimer = setTimer(runPoll, pollIntervalMs);
      resolutionTimer = setTimer(runReconciliation, resolutionIntervalMs);
      runPoll();
      runReconciliation();
    }
  }

  async function close() {
    if (pollTimer) clearTimer(pollTimer);
    if (resolutionTimer) clearTimer(resolutionTimer);
    await storage?.close();
  }

  async function getState() {
    if (!storage) return state.real;
    return refreshState();
  }

  async function followTrader(profile) {
    assertPin(profile?.pin);
    if (!storage) throw new Error('Real trader service is not ready');
    const result = await storage.followTrader(profile);
    await refreshState();
    broadcast();
    return { ok: true, ...result, real: state.real };
  }

  async function unfollowTrader({ wallet, pin }) {
    assertPin(pin);
    if (!storage) throw new Error('Real trader service is not ready');
    const entry = await storage.unfollowTrader(wallet);
    await refreshState();
    broadcast();
    return { ok: true, entry, real: state.real };
  }

  async function runPoll() {
    if (!storage || pollRunning) return { checked: 0, inserted: 0 };
    pollRunning = true;
    let checked = 0;
    let inserted = 0;
    try {
      const readiness = liveReadiness();
      state.service.real.mode = tradingMode;
      state.service.real.liveExecutionEnabled = isLiveExecutionRequested();
      state.service.real.liveExecutionReady = readiness.ready;
      state.service.real.liveExecutionConfig = readiness;
      state.service.real.stakeUsd = stakeUsd;
      state.service.real.priceGuardCents = guardCents;
      state.service.real.maxEntryPriceCents = maxEntryPriceCents;
      if (isLiveExecutionRequested() && !readiness.ready) {
        throw new Error(`Live trading mode is enabled but not ready: missing ${readiness.missing.join(', ')}`);
      }
      state.service.real.status = 'polling';
      broadcast();
      const follows = await storage.listActiveFollows();
      for (const follow of follows) {
        const rawTrades = await fetchTrades({ user: follow.wallet, side: 'BUY' });
        for (const raw of rawTrades.slice().reverse()) {
          const trade = normalizeRealTrade(raw);
          if (!trade || trade.wallet !== follow.wallet) continue;
          if (!isAfterAdded(trade, follow)) continue;
          checked += 1;
          if (await storage.hasOrderAttempt(makeOrderAttemptId(trade.id))) continue;
          const attempt = await buildExecutionAttempt({ trade, follow });
          if (await storage.hasOrderAttempt(attempt.id)) continue;
          const result = await storage.recordOrderAttempt(attempt);
          if (result.inserted) inserted += 1;
        }
      }
      state.service.real.status = 'ready';
      state.service.real.lastPollAt = new Date().toISOString();
      state.service.real.lastPollChecked = checked;
      state.service.real.lastPollInserted = inserted;
      state.service.real.lastError = null;
      await refreshState();
      broadcast();
      return { checked, inserted };
    } catch (error) {
      state.service.real.status = 'error';
      state.service.real.lastError = error.message;
      broadcast();
      return { checked, inserted, error };
    } finally {
      pollRunning = false;
    }
  }

  async function runReconciliation() {
    if (!storage || resolutionRunning) return { checked: 0, settled: 0 };
    resolutionRunning = true;
    let checked = 0;
    let settled = 0;
    try {
      const positions = await storage.getOpenPositions(250);
      for (const position of positions) {
        checked += 1;
        const resolution = await fetchResolution({
          conditionId: position.conditionId || position.marketConditionId,
          slug: position.marketSlug,
        });
        const settlement = settlementForPosition(position, resolution);
        if (settlement) {
          await storage.updatePosition(position.id, settlement);
          settled += 1;
          continue;
        }
        const mark = await markToBook(position).catch(() => null);
        if (mark) await storage.updatePosition(position.id, mark);
      }
      state.service.real.lastResolutionAt = new Date().toISOString();
      state.service.real.lastResolutionChecked = checked;
      state.service.real.lastResolutionSettled = settled;
      state.service.real.lastError = null;
      await refreshState();
      if (checked || settled) broadcast();
      return { checked, settled };
    } catch (error) {
      state.service.real.status = 'error';
      state.service.real.lastError = error.message;
      broadcast();
      return { checked, settled, error };
    } finally {
      resolutionRunning = false;
    }
  }

  async function buildExecutionAttempt({ trade, follow }) {
    const checkedAt = new Date().toISOString();
    const sourcePriceCents = numberOrNull(trade.priceCents);
    const minGuardCents = Math.max(0, sourcePriceCents - guardCents);
    const maxGuardCents = Math.min(100, sourcePriceCents + guardCents);

    if (Number.isFinite(sourcePriceCents) && sourcePriceCents > maxEntryPriceCents) {
      return withExecutionMode(makeAttempt(trade, follow, {
        status: 'rejected',
        reasonCode: 'above_max_entry_price',
        reason: `Entry price ${formatCents(sourcePriceCents)} above ${formatCents(maxEntryPriceCents)} max`,
        checkedAt,
        sourcePriceCents,
        minGuardCents,
        maxGuardCents,
        stakeUsd,
      }));
    }

    const marketKeys = makeMarketKeys(trade);
    const traderMarketPosition = await findExistingMarketPosition({ marketKeys, traderWallet: trade.wallet });
    if (traderMarketPosition) {
      return withExecutionMode(makeAttempt(trade, follow, {
        status: 'rejected',
        reasonCode: 'trader_market_already_copied',
        reason: 'Trader market already copied; ignoring repeat entry',
        checkedAt,
        sourcePriceCents,
        minGuardCents,
        maxGuardCents,
        stakeUsd,
        duplicatePositionId: traderMarketPosition.id,
      }));
    }

    const marketPosition = await findExistingMarketPosition({ marketKeys });
    if (marketPosition) {
      return withExecutionMode(makeAttempt(trade, follow, {
        status: 'rejected',
        reasonCode: 'market_already_copied',
        reason: 'Market already copied; ignoring additional trader entry',
        checkedAt,
        sourcePriceCents,
        minGuardCents,
        maxGuardCents,
        stakeUsd,
        duplicatePositionId: marketPosition.id,
      }));
    }

    let marketInfo = null;
    if (!trade.asset && trade.conditionId) {
      marketInfo = await fetchMarketInfo(trade.conditionId).catch(() => null);
    }
    const token = resolveTradeToken(trade, marketInfo);
    if (!token.tokenId) {
      return withExecutionMode(makeAttempt(trade, follow, {
        status: 'rejected',
        reasonCode: 'missing_token',
        reason: 'Could not resolve CLOB token for source trade',
        checkedAt,
        sourcePriceCents: trade.priceCents,
        minGuardCents,
        maxGuardCents,
        stakeUsd,
        tokenSource: token.source,
      }));
    }

    let orderBook;
    try {
      orderBook = await fetchBook(token.tokenId);
    } catch (error) {
      return withExecutionMode(makeAttempt(trade, follow, {
        status: 'rejected',
        reasonCode: 'quote_error',
        reason: `Order book lookup failed: ${error.message}`,
        checkedAt,
        sourcePriceCents: trade.priceCents,
        minGuardCents,
        maxGuardCents,
        stakeUsd,
        asset: token.tokenId,
        tokenSource: token.source,
      }));
    }

    const quote = evaluateDryRunFokBuy({ trade, orderBook, stakeUsd, guardCents, checkedAt });
    const attempt = makeAttempt(trade, follow, {
      ...quote,
      asset: token.tokenId,
      tokenSource: token.source,
      tickSize: numberOrNull(orderBook?.tick_size ?? orderBook?.tickSize ?? token.tickSize),
      negRisk: booleanOrNull(orderBook?.neg_risk ?? orderBook?.negRisk ?? token.negRisk),
      minOrderSize: numberOrNull(orderBook?.min_order_size ?? orderBook?.minOrderSize),
    });
    if (!isLiveExecutionRequested() || attempt.status !== 'would_fill') return withExecutionMode(attempt);

    try {
      const liveResult = await liveExecutor.executeFokBuy({ attempt, trade, follow, orderBook, marketInfo });
      return {
        ...attempt,
        ...liveResult,
        id: attempt.id,
        status: liveResult.status || 'filled',
        dryRun: false,
        liveExecution: true,
        checkedAt: liveResult.checkedAt || attempt.checkedAt,
      };
    } catch (error) {
      return {
        ...attempt,
        status: 'rejected',
        dryRun: false,
        liveExecution: true,
        reasonCode: 'live_order_error',
        reason: `Live order submission failed: ${error.message}`,
      };
    }
  }

  async function markToBook(position) {
    if (!position.asset) return null;
    const book = await fetchBook(position.asset);
    const bestBid = normalizeLevels(book?.bids, 'desc')[0];
    if (!bestBid) return null;
    const currentPriceCents = bestBid.price * 100;
    const shares = Number(position.shares || 0);
    const currentValueUsd = shares * bestBid.price;
    const stake = Number(position.stakeUsd || 0);
    const unrealizedPnlUsd = currentValueUsd - stake;
    return {
      currentPriceCents,
      currentValueUsd,
      unrealizedPnlUsd,
      unrealizedPnlPct: stake > 0 ? (unrealizedPnlUsd / stake) * 100 : 0,
    };
  }

  async function refreshState() {
    const real = await storage.getState();
    const readiness = liveReadiness();
    state.real = {
      ...real,
      mode: tradingMode,
      service: state.service.real,
      notes: realModeNotes({ readiness }),
    };
    state.service.real.mode = tradingMode;
    state.service.real.liveExecutionEnabled = isLiveExecutionRequested();
    state.service.real.liveExecutionReady = readiness.ready;
    state.service.real.liveExecutionConfig = readiness;
    state.service.real.stakeUsd = stakeUsd;
    state.service.real.priceGuardCents = guardCents;
    state.service.real.maxEntryPriceCents = maxEntryPriceCents;
    return state.real;
  }

  return {
    start,
    close,
    getState,
    followTrader,
    unfollowTrader,
    runPoll,
    runReconciliation,
    buildDryRunAttempt: buildExecutionAttempt,
    buildExecutionAttempt,
  };

  function isLiveExecutionRequested() {
    return tradingMode === 'live' && Boolean(liveTradingEnabled);
  }

  async function findExistingMarketPosition({ marketKeys, traderWallet = null } = {}) {
    const keys = normalizeMarketKeys(marketKeys);
    if (!keys.length || !storage?.findPositionByMarketKeys) return null;
    return storage.findPositionByMarketKeys({ marketKeys: keys, traderWallet });
  }

  function liveReadiness() {
    const readiness = liveExecutor.getReadiness?.() || { ready: false, missing: ['live executor'] };
    return {
      ...readiness,
      ready: isLiveExecutionRequested() && readiness.ready,
      mode: tradingMode,
      enabled: isLiveExecutionRequested(),
    };
  }

  function realModeNotes({ readiness }) {
    if (isLiveExecutionRequested()) {
      return readiness.ready
        ? ['Live mode is enabled. Approved followed-wallet BUY entries are submitted as fixed-stake FOK orders after the price guard passes.']
        : [`Live mode is requested but blocked until required Railway variables are set: ${readiness.missing.join(', ')}.`];
    }
    return [
      'Real mode is dry-run only.',
      'Set REAL_TRADING_MODE=live and REAL_LIVE_TRADING_ENABLED=true to allow live CLOB submission.',
    ];
  }

  function withExecutionMode(attempt) {
    if (!isLiveExecutionRequested()) return attempt;
    return {
      ...attempt,
      dryRun: false,
      liveExecution: true,
    };
  }
}

export function assertPin(pin) {
  if (String(pin || '') !== String(REAL_ACTION_PIN || '')) {
    const error = new Error('Invalid real action PIN');
    error.status = 403;
    throw error;
  }
}

function makeAttempt(trade, follow, quote) {
  return {
    id: makeOrderAttemptId(trade.id),
    sourceTradeId: trade.id,
    traderWallet: trade.wallet,
    traderName: follow.displayName || follow.pseudonym || trade.displayName || trade.pseudonym || trade.wallet,
    displayName: trade.displayName || follow.displayName || null,
    pseudonym: trade.pseudonym || follow.pseudonym || null,
    profileImage: trade.profileImage || follow.profileImage || null,
    asset: quote.asset || trade.asset || null,
    conditionId: trade.conditionId || null,
    marketSlug: trade.marketSlug || null,
    eventSlug: trade.eventSlug || null,
    marketTitle: trade.marketTitle || 'Unknown market',
    marketIcon: trade.marketIcon || null,
    polymarketUrl: trade.polymarketUrl || null,
    outcome: trade.outcome || 'Unknown outcome',
    side: 'BUY',
    dryRun: true,
    orderType: 'FOK',
    sourcePriceCents: quote.sourcePriceCents ?? trade.priceCents,
    minGuardCents: quote.minGuardCents,
    maxGuardCents: quote.maxGuardCents,
    stakeUsd: quote.stakeUsd ?? stakeOrDefault(),
    status: quote.status,
    reasonCode: quote.reasonCode || null,
    reason: quote.reason,
    bestAskCents: quote.bestAskCents ?? null,
    worstAskCents: quote.worstAskCents ?? null,
    vwapCents: quote.vwapCents ?? null,
    estimatedShares: quote.estimatedShares ?? null,
    notionalAvailableUsd: quote.notionalAvailableUsd ?? null,
    bookHash: quote.bookHash || null,
    tokenSource: quote.tokenSource || null,
    marketKeys: makeMarketKeys(trade),
    duplicatePositionId: quote.duplicatePositionId || null,
    tickSize: quote.tickSize ?? null,
    negRisk: quote.negRisk ?? null,
    minOrderSize: quote.minOrderSize ?? null,
    sourceTradeTimestamp: trade.tradeTimestamp,
    checkedAt: quote.checkedAt || new Date().toISOString(),
    sourceTrade: trade,
  };
}

function makeOrderAttemptId(sourceTradeId) {
  return `real-order-${sourceTradeId}`;
}

function stakeOrDefault() {
  return Number.isFinite(Number(REAL_STAKE_USD)) ? Number(REAL_STAKE_USD) : 10;
}

function isAfterAdded(trade, follow) {
  const tradeTime = Date.parse(trade.tradeTimestamp);
  const addedAt = Date.parse(follow.addedAt);
  const addedAtSecond = Math.floor(addedAt / 1000) * 1000;
  return Number.isFinite(tradeTime) && Number.isFinite(addedAtSecond) && tradeTime >= addedAtSecond;
}

function settlementForPosition(position, resolution) {
  if (!resolution || resolution.status === 'open' || resolution.closed === false) return null;
  if (resolution.status === 'invalid') {
    return {
      status: 'invalid',
      currentPriceCents: position.entryPriceCents,
      currentValueUsd: position.stakeUsd,
      realizedPnlUsd: 0,
      unrealizedPnlUsd: 0,
      winningOutcome: resolution.winningOutcome || null,
      resolutionStatus: resolution.status,
      resolvedAt: resolution.resolvedAt || new Date().toISOString(),
      closedAt: resolution.resolvedAt || new Date().toISOString(),
    };
  }
  if (!resolution.winningOutcome) return null;
  const won = sameOutcome(position.outcome, resolution.winningOutcome);
  const exitValueUsd = won ? Number(position.shares || 0) : 0;
  const stake = Number(position.stakeUsd || 0);
  return {
    status: won ? 'win' : 'loss',
    currentPriceCents: won ? 100 : 0,
    currentValueUsd: exitValueUsd,
    realizedPnlUsd: exitValueUsd - stake,
    unrealizedPnlUsd: 0,
    unrealizedPnlPct: 0,
    winningOutcome: resolution.winningOutcome,
    resolutionStatus: resolution.status,
    resolvedAt: resolution.resolvedAt || new Date().toISOString(),
    closedAt: resolution.resolvedAt || new Date().toISOString(),
  };
}

function sameOutcome(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function makeMarketKeys(tradeOrPosition) {
  return normalizeMarketKeys([
    tradeOrPosition?.conditionId,
    tradeOrPosition?.marketConditionId,
    tradeOrPosition?.marketSlug,
    tradeOrPosition?.marketTitle,
  ]);
}

function normalizeMarketKeys(values) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean))];
}

function formatCents(value) {
  return `${Number(value).toFixed(1)}c`;
}

function booleanOrNull(value) {
  if (value === true || value === false) return value;
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim().toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  return null;
}

function normalizeTradingMode(value) {
  return String(value || '').trim().toLowerCase().replace('-', '_') === 'live' ? 'live' : 'dry_run';
}
