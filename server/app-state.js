import { DEMO_STARTING_CAPITAL_USD, WATCHED_WALLETS } from './config.js';
import {
  applyCopyPoolSnapshot,
  createCopyPoolState,
  ensureTraderProfile,
  isWalletWatched,
} from './copy-pool.js';
import { createDemoState, evaluateDemoCopy, makeTraderMarketKey, markToMarket, updateOpenPositionPrices } from './demo-engine.js';
import { nowIso, shortWallet } from './format.js';

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
      allTimeWinRatePct: null,
      allTimePnlTradeCount: null,
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
    },
    copyPool: createCopyPoolState(WATCHED_WALLETS),
    watchedWallets: [...WATCHED_WALLETS.map((wallet) => wallet.toLowerCase())],
    traders,
    allTrades: [],
    copiedFeed: [],
    seenTradeIds: new Set(),
    demo: createDemoState(),
    real: {
      armed: false,
      adapter: 'not_configured',
      copiedCount: 0,
      rejectedCount: 0,
      notes: [
        'Real execution is disabled.',
        'A Polymarket execution adapter, wallet signing, and risk confirmations must be added before live orders are possible.',
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
    allTrades: state.allTrades,
    copiedFeed: state.copiedFeed,
    seenTradeIds: [...state.seenTradeIds],
    demo: {
      ...state.demo,
      copiedSourceTradeIds: [...state.demo.copiedSourceTradeIds],
      copiedTraderMarketKeys: [...state.demo.copiedTraderMarketKeys],
    },
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
    const storedStartingCapitalUsd = numberOrNull(stored.demo.startingCapitalUsd);
    const restoredDemo = { ...createDemoState(), ...stored.demo };
    restoredDemo.openPositions = Array.isArray(stored.demo.openPositions) ? stored.demo.openPositions : [];
    restoredDemo.closedPositions = Array.isArray(stored.demo.closedPositions) ? stored.demo.closedPositions : [];
    restoredDemo.decisions = Array.isArray(stored.demo.decisions) ? stored.demo.decisions : [];
    restoredDemo.copiedSourceTradeIds = new Set(
      Array.isArray(stored.demo.copiedSourceTradeIds) ? stored.demo.copiedSourceTradeIds : []
    );
    restoredDemo.copiedTraderMarketKeys = restoreTraderMarketKeys(stored.demo);
    state.demo = restoredDemo;
    repairPrematureResolutionSettlements(state.demo);
    pruneDuplicateTraderMarkets(state.demo);
    reconcileConfiguredDemoCapital(state.demo, storedStartingCapitalUsd);
  }

  if (stored.real && typeof stored.real === 'object') {
    state.real = { ...state.real, ...stored.real };
  }

  state.seenTradeIds = new Set([
    ...(Array.isArray(stored.seenTradeIds) ? stored.seenTradeIds : []),
    ...state.allTrades.map((event) => event.id).filter(Boolean),
    ...state.demo.copiedSourceTradeIds,
  ]);

  return true;
}

export function ingestTrade(state, trade, source = 'unknown', options = {}) {
  if (!trade?.id || state.seenTradeIds.has(trade.id)) return null;
  const copyEligible = options.copyEligible !== false;

  state.seenTradeIds.add(trade.id);
  updateOpenPositionPrices(state.demo, trade);

  const wallet = String(trade.trader.proxyWallet || '').toLowerCase();
  trade.trader.proxyWallet = wallet;
  const watched = isWalletWatched(state, wallet);
  const event = {
    id: trade.id,
    source,
    watched,
    trade,
    copyDecision: null,
    realDecision: {
      action: watched ? 'blocked' : 'ignored',
      reason: watched ? 'Real trading adapter is disabled' : 'Wallet is not in copy list',
    },
    observedAt: nowIso(),
  };

  if (watched) {
    const trader = ensureTraderProfile(state, wallet, trade.trader);
    trader.displayName = trade.trader.displayName || trader.displayName;
    trader.pseudonym = trade.trader.pseudonym || trader.pseudonym;
    trader.profileImage = trade.trader.profileImage || trader.profileImage;
    trader.observedCount += 1;
    trader.lastSeenAt = event.observedAt;
    trader.recentTrades.unshift({ ...trade, status: trade.resolution?.status || 'open' });
    trader.recentTrades = trader.recentTrades.slice(0, 8);

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
    const wallet = String(row.proxyWallet || '').toLowerCase();
    const trader = state.traders[wallet];
    if (!trader) continue;
    trader.displayName = row.displayName || trader.displayName;
    trader.pseudonym = row.pseudonym || trader.pseudonym;
    trader.profileImage = row.profileImage || trader.profileImage;
    trader.rank = row.rank ?? trader.rank;
    trader.allTimeProfitUsd = numberOrNull(row.allTimeProfitUsd);
    trader.allTimeWinRatePct = numberOrNull(row.allTimeWinRatePct);
    trader.allTimePnlTradeCount = numberOrNull(row.allTimePnlTradeCount);
    trader.recentFormResults = Array.isArray(row.recentFormResults) ? row.recentFormResults : trader.recentFormResults;
  }
}

export function snapshotState(state) {
  const demoMetrics = markToMarket(state.demo);
  return {
    service: state.service,
    watchedWallets: state.watchedWallets,
    copyPool: state.copyPool,
    traders: Object.values(state.traders),
    demo: {
      metrics: demoMetrics,
      openPositions: state.demo.openPositions,
      closedPositions: state.demo.closedPositions.slice(0, 250),
      decisions: state.demo.decisions.slice(0, 250),
    },
    real: state.real,
    allTrades: state.allTrades,
    copiedFeed: state.copiedFeed,
  };
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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
