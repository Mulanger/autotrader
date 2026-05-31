import { DEBUG_STATE_INCLUDE_ALL_TRADES, DEMO_STARTING_CAPITAL_USD, WATCHED_WALLETS } from './config.js';
import {
  applyCopyPoolSnapshot,
  createCopyPoolState,
  ensureTraderProfile,
  isWalletWatched,
} from './copy-pool.js';
import {
  createDemoState,
  evaluateDemoCopy,
  makeMarketKey,
  makeTraderMarketKey,
  markToMarket,
  updateOpenPositionPrices,
} from './demo-engine.js';
import { nowIso, shortWallet } from './format.js';
import {
  createShadowTraderState,
  ensureShadowTraderState,
  isShadowTraderWalletSelected,
  normalizeShadowPortfolio,
} from './shadow-trader.js';

export function createAppState() {
  const traders = {};
  for (const wallet of WATCHED_WALLETS) {
    traders[wallet.toLowerCase()] = {
      wallet: wallet.toLowerCase(),
      label: shortWallet(wallet),
      displayName: null,
      pseudonym: null,
      profileImage: null,
      allTimeProfitUsd: null,
      allTimeVolumeUsd: null,
      allTimeMarketsTraded: null,
      allTimeWinRatePct: null,
      allTimePnlTradeCount: null,
      profileStatsSource: null,
      profileStatsUpdatedAt: null,
      recentFormResults: [],
      recentTrades: [],
      observedCount: 0,
      copiedCount: 0,
      skippedCount: 0,
      lastSeenAt: null,
    };
  }

  return {
    service: {
      startedAt: nowIso(),
      streamStatus: 'booting',
      streamLastMessageAt: null,
      pollStatus: 'idle',
      pollLastRunAt: null,
      profileStatus: 'idle',
      profileLastRunAt: null,
      profileLastWalletCount: 0,
      profileUpdatedWalletCount: 0,
      profileLastError: null,
      resolutionStatus: 'idle',
      resolutionLastRunAt: null,
      resolutionLastSettledAt: null,
      resolutionLastCheckedCount: 0,
      lastError: null,
      storage: {
        mode: 'memory',
        status: 'starting',
        durable: false,
        schemaVersion: null,
        lastLoadedAt: null,
        lastSavedAt: null,
        lastFlushDurationMs: null,
        lastLoadedRows: null,
        lastError: null,
      },
      candidates: {
        enabled: false,
        status: 'disabled',
      },
      real: {
        status: 'disabled',
        mode: 'dry_run',
        liveExecutionEnabled: false,
      },
    },
    copyPool: createCopyPoolState(WATCHED_WALLETS),
    watchedWallets: [...WATCHED_WALLETS.map((wallet) => wallet.toLowerCase())],
    traders,
    allTrades: [],
    copiedFeed: [],
    seenTradeIds: new Set(),
    demo: createDemoState(),
    shadowTrader: createShadowTraderState(),
    real: {
      ok: true,
      mode: 'dry_run',
      storageMode: 'not_started',
      durable: false,
      summary: {
        activeFollowCount: 0,
        attemptedCount: 0,
        wouldFillCount: 0,
        rejectedCount: 0,
        openPositionCount: 0,
        closedPositionCount: 0,
        realizedPnlUsd: 0,
        unrealizedPnlUsd: 0,
        totalPnlUsd: 0,
      },
      follows: [],
      orders: [],
      positions: [],
      events: [],
      notes: [
        'Real mode is dry-run only.',
        'No private key or live CLOB order submission is enabled in this version.',
      ],
    },
  };
}

export function serializeDurableState(state) {
  return {
    version: 1,
    savedAt: nowIso(),
    watchedWallets: state.watchedWallets,
    copyPool: state.copyPool,
    traders: state.traders,
    allTrades: state.allTrades.filter((event) => event?.watched),
    copiedFeed: state.copiedFeed,
    seenTradeIds: [...state.seenTradeIds],
    demo: {
      ...state.demo,
      copiedSourceTradeIds: [...state.demo.copiedSourceTradeIds],
      copiedMarketKeys: [...state.demo.copiedMarketKeys],
      copiedTraderMarketKeys: [...state.demo.copiedTraderMarketKeys],
    },
    shadowTrader: serializeShadowTrader(state.shadowTrader),
    real: state.real,
  };
}

export function restoreDurableState(state, stored) {
  if (!stored || typeof stored !== 'object') return false;

  if (stored.traders && typeof stored.traders === 'object') {
    for (const [wallet, trader] of Object.entries(stored.traders)) {
      ensureTraderProfile(state, wallet, trader);
    }
  }

  if (stored.copyPool && typeof stored.copyPool === 'object') {
    applyCopyPoolSnapshot(state, stored.copyPool);
  }

  state.allTrades = Array.isArray(stored.allTrades) ? stored.allTrades.slice(0, 300) : state.allTrades;
  state.copiedFeed = Array.isArray(stored.copiedFeed) ? stored.copiedFeed.slice(0, 200) : state.copiedFeed;

  if (stored.demo && typeof stored.demo === 'object') {
    state.demo = restoreDemoPortfolio(stored.demo, createDemoState());
    reconcileConfiguredDemoCapital(state.demo, numberOrNull(stored.demo.startingCapitalUsd));
  }

  if (stored.shadowTrader && typeof stored.shadowTrader === 'object') {
    const restoredShadow = {
      ...createShadowTraderState(),
      ...stored.shadowTrader,
      portfolio: normalizeShadowPortfolio(stored.shadowTrader.portfolio),
      feed: Array.isArray(stored.shadowTrader.feed) ? stored.shadowTrader.feed : [],
    };
    restoredShadow.portfolio = restoreDemoPortfolio(restoredShadow.portfolio, createDemoState({ positionIdPrefix: 'shadow-v1' }));
    restoredShadow.portfolio.positionIdPrefix = 'shadow-v1';
    state.shadowTrader = restoredShadow;
  }
  ensureShadowTraderState(state);

  if (stored.real && typeof stored.real === 'object') {
    state.real = { ...state.real, ...stored.real };
  }

  state.seenTradeIds = new Set([
    ...(Array.isArray(stored.seenTradeIds) ? stored.seenTradeIds : []),
    ...state.allTrades.map((event) => event.id).filter(Boolean),
    ...state.demo.copiedSourceTradeIds,
    ...state.shadowTrader.portfolio.copiedSourceTradeIds,
  ]);

  return true;
}

export function ingestTrade(state, trade, source = 'unknown', options = {}) {
  if (!trade?.id || state.seenTradeIds.has(trade.id)) return null;
  const copyEligible = options.copyEligible !== false;

  state.seenTradeIds.add(trade.id);
  updateOpenPositionPrices(state.demo, trade);
  const shadow = ensureShadowTraderState(state);
  updateOpenPositionPrices(shadow.portfolio, trade);

  const wallet = String(trade.trader.proxyWallet || '').toLowerCase();
  trade.trader.proxyWallet = wallet;
  const watched = isWalletWatched(state, wallet);
  const shadowWatched = isShadowTraderWalletSelected(state, wallet);
  const event = {
    id: trade.id,
    source,
    watched,
    shadowWatched,
    trade,
    copyDecision: null,
    shadowDecision: null,
    realDecision: {
      action: watched ? 'blocked' : 'ignored',
      reason: watched ? 'Real trading adapter is disabled' : 'Wallet is not in copy list',
    },
    observedAt: nowIso(),
  };

  if (shadowWatched) {
    event.shadowDecision = copyEligible
      ? evaluateDemoCopy(shadow.portfolio, trade)
      : {
          action: 'observed',
          reason: 'Loaded at startup; not copied by shadow strategy',
          at: nowIso(),
        };
    if (event.shadowDecision?.action === 'copied') shadow.lastCopiedCount = Number(shadow.lastCopiedCount || 0) + 1;
    shadow.feed.unshift(event);
    shadow.feed = shadow.feed.slice(0, 200);
  } else {
    event.shadowDecision = {
      action: 'ignored',
      reason: 'Wallet is not selected by ECP top 20 shadow',
      at: nowIso(),
    };
  }

  if (watched) {
    const trader = ensureTraderProfile(state, wallet, trade.trader);
    trader.displayName = trade.trader.displayName || trader.displayName;
    trader.pseudonym = trade.trader.pseudonym || trader.pseudonym;
    trader.profileImage = trade.trader.profileImage || trader.profileImage;
    trader.observedCount += 1;
    trader.lastSeenAt = event.observedAt;
    trader.recentTrades.unshift({ ...trade, status: trade.resolution?.status || 'open' });
    trader.recentTrades = trader.recentTrades.slice(0, 10);

    event.copyDecision = copyEligible
      ? evaluateDemoCopy(state.demo, trade)
      : {
          action: 'observed',
          reason: 'Loaded at startup; not copied',
          at: nowIso(),
        };
    if (event.copyDecision?.action === 'copied') trader.copiedCount += 1;
    if (event.copyDecision?.action === 'skipped') trader.skippedCount += 1;
    state.copiedFeed.unshift(event);
    state.copiedFeed = state.copiedFeed.slice(0, 200);
  } else {
    event.copyDecision = {
      action: 'ignored',
      reason: 'Wallet is not in copy list',
      at: nowIso(),
    };
  }

  state.allTrades.unshift(event);
  state.allTrades = state.allTrades.slice(0, 300);
  return event;
}

export function applyLeaderboardRows(state, rows = []) {
  for (const row of rows) {
    const wallet = String(row.proxyWallet || row.wallet || '').toLowerCase();
    const trader = state.traders[wallet] || ensureTraderProfile(state, wallet, row);
    if (!trader) continue;
    trader.displayName = row.displayName || row.userName || row.name || trader.displayName;
    trader.pseudonym = row.pseudonym || trader.pseudonym;
    trader.profileImage = row.profileImage || row.profileImageOptimized || trader.profileImage;
    if (hasOwn(row, 'rank')) trader.rank = numberOrNull(row.rank);
    if (hasOwn(row, 'allTimeProfitUsd')) trader.allTimeProfitUsd = numberOrNull(row.allTimeProfitUsd);
    else if (hasOwn(row, 'pnl')) trader.allTimeProfitUsd = numberOrNull(row.pnl);
    if (hasOwn(row, 'allTimeVolumeUsd')) trader.allTimeVolumeUsd = numberOrNull(row.allTimeVolumeUsd);
    else if (hasOwn(row, 'vol')) trader.allTimeVolumeUsd = numberOrNull(row.vol);
    if (hasOwn(row, 'allTimeMarketsTraded')) trader.allTimeMarketsTraded = numberOrNull(row.allTimeMarketsTraded);
    else if (hasOwn(row, 'marketsTraded')) trader.allTimeMarketsTraded = numberOrNull(row.marketsTraded);
    if (hasOwn(row, 'allTimeWinRatePct')) trader.allTimeWinRatePct = numberOrNull(row.allTimeWinRatePct);
    if (hasOwn(row, 'allTimePnlTradeCount')) trader.allTimePnlTradeCount = numberOrNull(row.allTimePnlTradeCount);
    if (row.profileStatsSource) trader.profileStatsSource = row.profileStatsSource;
    if (row.profileStatsUpdatedAt) trader.profileStatsUpdatedAt = row.profileStatsUpdatedAt;
    if (Array.isArray(row.profileStatsErrors)) trader.profileStatsErrors = row.profileStatsErrors;
    if (Array.isArray(row.recentFormResults)) trader.recentFormResults = row.recentFormResults;
  }
}

export function snapshotState(state, options = {}) {
  const includeAllTrades = options.includeAllTrades ?? DEBUG_STATE_INCLUDE_ALL_TRADES;
  const demoMetrics = markToMarket(state.demo);
  return {
    service: state.service,
    watchedWallets: state.watchedWallets,
    copyPool: state.copyPool,
    traders: activeTraderProfiles(state),
    demo: {
      metrics: demoMetrics,
      openPositions: state.demo.openPositions,
      closedPositions: state.demo.closedPositions.slice(0, 250),
      decisions: state.demo.decisions.slice(0, 250),
    },
    real: state.real,
    shadowTrader: shadowTraderView(state.shadowTrader),
    ...(includeAllTrades ? { allTrades: state.allTrades } : {}),
    copiedFeed: state.copiedFeed,
  };
}

function serializeShadowTrader(shadowTrader) {
  const shadow = shadowTrader || createShadowTraderState();
  const portfolio = normalizeShadowPortfolio(shadow.portfolio);
  return {
    ...shadow,
    portfolio: {
      ...portfolio,
      copiedSourceTradeIds: [...portfolio.copiedSourceTradeIds],
      copiedMarketKeys: [...portfolio.copiedMarketKeys],
      copiedTraderMarketKeys: [...portfolio.copiedTraderMarketKeys],
    },
    feed: Array.isArray(shadow.feed) ? shadow.feed.slice(0, 200) : [],
    rankedCandidates: Array.isArray(shadow.rankedCandidates) ? shadow.rankedCandidates.slice(0, 100) : [],
  };
}

function shadowTraderView(shadowTrader) {
  const shadow = shadowTrader || createShadowTraderState();
  const portfolio = normalizeShadowPortfolio(shadow.portfolio);
  return {
    enabled: shadow.enabled,
    strategy: shadow.strategy,
    label: shadow.label,
    status: shadow.status,
    criteria: shadow.criteria,
    selectedWallets: shadow.selectedWallets || {},
    rankedCandidates: Array.isArray(shadow.rankedCandidates) ? shadow.rankedCandidates.slice(0, 100) : [],
    selectedWalletCount: Number(shadow.selectedWalletCount || 0),
    candidatesScoredCount: Number(shadow.candidatesScoredCount || 0),
    lastEvaluatedAt: shadow.lastEvaluatedAt || null,
    lastChangedCount: Number(shadow.lastChangedCount || 0),
    lastCopiedCount: Number(shadow.lastCopiedCount || 0),
    metrics: markToMarket(portfolio),
    openPositions: portfolio.openPositions,
    closedPositions: portfolio.closedPositions.slice(0, 250),
    decisions: portfolio.decisions.slice(0, 250),
    feed: Array.isArray(shadow.feed) ? shadow.feed.slice(0, 200) : [],
  };
}

function restoreDemoPortfolio(storedPortfolio, basePortfolio) {
  const restored = { ...basePortfolio, ...storedPortfolio };
  restored.openPositions = Array.isArray(storedPortfolio.openPositions) ? storedPortfolio.openPositions : [];
  restored.closedPositions = Array.isArray(storedPortfolio.closedPositions) ? storedPortfolio.closedPositions : [];
  restored.decisions = Array.isArray(storedPortfolio.decisions) ? storedPortfolio.decisions : [];
  restored.copiedSourceTradeIds = new Set(iterableValues(storedPortfolio.copiedSourceTradeIds));
  restored.copiedMarketKeys = restoreMarketKeys(restored);
  restored.copiedTraderMarketKeys = restoreTraderMarketKeys(restored);
  repairPrematureResolutionSettlements(restored);
  pruneDuplicateTraderMarkets(restored);
  return restored;
}

function iterableValues(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value[Symbol.iterator] === 'function') return [...value];
  return [];
}

function activeTraderProfiles(state) {
  return (state.watchedWallets || [])
    .map((wallet) => state.traders[String(wallet || '').toLowerCase()])
    .filter(Boolean);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function reconcileConfiguredDemoCapital(demo, storedStartingCapitalUsd) {
  if (storedStartingCapitalUsd === null) {
    demo.startingCapitalUsd = DEMO_STARTING_CAPITAL_USD;
    return;
  }

  const deltaUsd = DEMO_STARTING_CAPITAL_USD - storedStartingCapitalUsd;
  if (Math.abs(deltaUsd) < 0.005) {
    demo.startingCapitalUsd = DEMO_STARTING_CAPITAL_USD;
    return;
  }

  demo.startingCapitalUsd = DEMO_STARTING_CAPITAL_USD;
  demo.cashUsd = numberOrFallback(demo.cashUsd, 0) + deltaUsd;
  demo.decisions = Array.isArray(demo.decisions) ? demo.decisions : [];
  demo.decisions.unshift({
    id: `capital-${Date.now()}`,
    tradeId: 'demo-capital',
    action: 'capital_adjusted',
    reason: `Demo starting capital changed from $${storedStartingCapitalUsd.toFixed(2)} to $${DEMO_STARTING_CAPITAL_USD.toFixed(2)}`,
    copyId: null,
    at: nowIso(),
  });
}

function restoreTraderMarketKeys(demo) {
  const keys = new Set(Array.isArray(demo.copiedTraderMarketKeys) ? demo.copiedTraderMarketKeys : []);
  for (const position of [...(demo.openPositions || []), ...(demo.closedPositions || [])]) {
    const key = position.traderMarketKey || makeTraderMarketKey(position);
    if (key) keys.add(key);
  }
  return keys;
}

function restoreMarketKeys(demo) {
  const keys = new Set(Array.isArray(demo.copiedMarketKeys) ? demo.copiedMarketKeys : []);
  for (const position of [...(demo.openPositions || []), ...(demo.closedPositions || [])]) {
    const key = position.marketKey || makeMarketKey(position);
    if (key) keys.add(key);
  }
  return keys;
}

function pruneDuplicateTraderMarkets(demo) {
  const positions = [
    ...(demo.openPositions || []).map((position) => ({ position, list: 'open' })),
    ...(demo.closedPositions || []).map((position) => ({ position, list: 'closed' })),
  ];
  const grouped = new Map();

  for (const item of positions) {
    const key = item.position.traderMarketKey || makeTraderMarketKey(item.position);
    if (!key) continue;
    item.position.traderMarketKey = key;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }

  const removed = [];
  const keptKeys = new Set();

  for (const [key, items] of grouped.entries()) {
    if (items.length <= 1) {
      keptKeys.add(key);
      continue;
    }

    const sorted = [...items].sort(comparePositionAge);
    const [keep, ...duplicates] = sorted;
    keptKeys.add(key);
    removed.push(...duplicates);
    keep.position.duplicateRepairNote = keep.position.duplicateRepairNote || 'Kept as first copied trader-market entry';
  }

  if (!removed.length) {
    demo.copiedTraderMarketKeys = keptKeys;
    return;
  }

  const removedIds = new Set(removed.map((item) => item.position.id));
  let cashAdjustmentUsd = 0;
  let realizedPnlAdjustmentUsd = 0;
  let notionalAdjustmentUsd = 0;

  for (const { position, list } of removed) {
    const stakeUsd = numberOrFallback(position.stakeUsd, 0);
    const realizedPnlUsd = numberOrFallback(position.realizedPnlUsd, 0);
    if (list === 'open') cashAdjustmentUsd += stakeUsd;
    if (list === 'closed') {
      cashAdjustmentUsd -= realizedPnlUsd;
      realizedPnlAdjustmentUsd -= realizedPnlUsd;
    }
    notionalAdjustmentUsd += stakeUsd;
  }

  demo.cashUsd += cashAdjustmentUsd;
  demo.realizedPnlUsd += realizedPnlAdjustmentUsd;
  demo.totalNotionalCopiedUsd = Math.max(0, numberOrFallback(demo.totalNotionalCopiedUsd, 0) - notionalAdjustmentUsd);
  demo.copiedCount = Math.max(0, Number(demo.copiedCount || 0) - removed.length);
  demo.openPositions = (demo.openPositions || []).filter((position) => !removedIds.has(position.id));
  demo.closedPositions = (demo.closedPositions || []).filter((position) => !removedIds.has(position.id));
  demo.decisions = (demo.decisions || []).filter((decision) => !removedIds.has(decision.copyId));
  demo.copiedSourceTradeIds = new Set(
    [...(demo.copiedSourceTradeIds || [])].filter((tradeId) => {
      return !removed.some(({ position }) => position.sourceTradeId === tradeId);
    })
  );
  demo.copiedTraderMarketKeys = keptKeys;
  demo.decisions.unshift({
    id: `dedupe-${Date.now()}`,
    tradeId: removed[0]?.position.sourceTradeId || 'dedupe',
    action: 'repaired',
    reason: `Removed ${removed.length} duplicate trader-market demo position${removed.length === 1 ? '' : 's'}`,
    copyId: removed[0]?.position.id || null,
    at: nowIso(),
  });
}

function comparePositionAge(a, b) {
  const aTime = dateValue(a.position.openedAt || a.position.createdAt || a.position.updatedAt);
  const bTime = dateValue(b.position.openedAt || b.position.createdAt || b.position.updatedAt);
  if (aTime !== bTime) return aTime - bTime;
  return String(a.position.sourceTradeId || a.position.id).localeCompare(String(b.position.sourceTradeId || b.position.id));
}

function dateValue(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
}

function repairPrematureResolutionSettlements(demo) {
  const reopened = [];
  const retainedClosed = [];
  let cashAdjustmentUsd = 0;
  let realizedPnlAdjustmentUsd = 0;

  for (const position of demo.closedPositions || []) {
    const repairNote = resolutionSettlementRepairNote(position);
    if (!repairNote) {
      retainedClosed.push(position);
      continue;
    }

    const currentPriceCents = numberOrFallback(position.currentPriceCents, position.entryPriceCents);
    const entryPriceCents = numberOrFallback(position.entryPriceCents, currentPriceCents);
    const shares = numberOrFallback(position.shares, 0);
    const unrealizedPnlUsd = (currentPriceCents - entryPriceCents) / 100 * shares;

    reopened.push({
      ...position,
      status: 'open',
      exitPriceCents: null,
      exitValueUsd: null,
      payoutUsd: null,
      realizedPnlUsd: null,
      closedAt: null,
      resolvedAt: null,
      closeSourceTradeId: null,
      settlementSource: null,
      settlementReason: null,
      currentPriceCents,
      resolutionStatus: 'open',
      resolutionRepairNote: repairNote,
      unrealizedPnlUsd,
      unrealizedPnlPct: entryPriceCents ? ((currentPriceCents - entryPriceCents) / entryPriceCents) * 100 : 0,
      updatedAt: nowIso(),
    });

    cashAdjustmentUsd += numberOrFallback(position.exitValueUsd, 0);
    realizedPnlAdjustmentUsd += numberOrFallback(position.realizedPnlUsd, 0);
  }

  if (!reopened.length) return;

  const reopenedIds = new Set(reopened.map((position) => position.id));
  demo.cashUsd -= cashAdjustmentUsd;
  demo.realizedPnlUsd -= realizedPnlAdjustmentUsd;
  demo.openPositions = [...reopened, ...(demo.openPositions || [])];
  demo.closedPositions = retainedClosed;
  demo.decisions = (demo.decisions || []).filter((decision) => {
    return !(decision.action === 'settled' && reopenedIds.has(decision.copyId));
  });
  demo.decisions.unshift({
    id: `repair-${Date.now()}`,
    tradeId: reopened[0]?.sourceTradeId || 'repair',
    action: 'reopened',
    reason: `Reopened ${reopened.length} premature resolution settlement${reopened.length === 1 ? '' : 's'}`,
    copyId: reopened[0]?.id || null,
    at: nowIso(),
  });
}

function isPrematureResolutionSettlement(position) {
  return (
    position?.settlementSource === 'polywhale-resolution' &&
    String(position.resolutionStatus || '').toLowerCase() === 'open'
  );
}

function resolutionSettlementRepairNote(position) {
  if (isPrematureResolutionSettlement(position)) {
    return 'Reopened after a premature null-PnL settlement';
  }
  if (isAmbiguousBinaryMarketSettlement(position)) {
    return 'Reopened for market-resolution cross-check after an ambiguous binary winner label';
  }
  return null;
}

function isAmbiguousBinaryMarketSettlement(position) {
  if (position?.settlementSource !== 'polywhale-resolution') return false;
  const status = String(position.resolutionStatus || '').toLowerCase();
  if (!['resolved', 'resolved_win', 'resolved_loss'].includes(status)) return false;
  return isBinaryOutcome(position.winningOutcome) && !isBinaryOutcome(position.outcome);
}

function isBinaryOutcome(value) {
  const text = String(value || '').trim().toUpperCase();
  return text === 'YES' || text === 'NO';
}

function numberOrFallback(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
