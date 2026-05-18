import { WATCHED_WALLETS } from './config.js';
import { createDemoState, evaluateDemoCopy, markToMarket, updateOpenPositionPrices } from './demo-engine.js';
import { nowIso, shortWallet } from './format.js';

const watchedSet = new Set(WATCHED_WALLETS.map((wallet) => wallet.toLowerCase()));

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
    },
    watchedWallets: [...WATCHED_WALLETS],
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
    traders: state.traders,
    allTrades: state.allTrades,
    copiedFeed: state.copiedFeed,
    seenTradeIds: [...state.seenTradeIds],
    demo: {
      ...state.demo,
      copiedSourceTradeIds: [...state.demo.copiedSourceTradeIds],
    },
    real: state.real,
  };
}

export function restoreDurableState(state, stored) {
  if (!stored || typeof stored !== 'object') return false;

  if (stored.traders && typeof stored.traders === 'object') {
    for (const [wallet, trader] of Object.entries(stored.traders)) {
      if (state.traders[wallet]) state.traders[wallet] = { ...state.traders[wallet], ...trader };
    }
  }

  state.allTrades = Array.isArray(stored.allTrades) ? stored.allTrades.slice(0, 300) : state.allTrades;
  state.copiedFeed = Array.isArray(stored.copiedFeed) ? stored.copiedFeed.slice(0, 200) : state.copiedFeed;

  if (stored.demo && typeof stored.demo === 'object') {
    const restoredDemo = { ...createDemoState(), ...stored.demo };
    restoredDemo.openPositions = Array.isArray(stored.demo.openPositions) ? stored.demo.openPositions : [];
    restoredDemo.closedPositions = Array.isArray(stored.demo.closedPositions) ? stored.demo.closedPositions : [];
    restoredDemo.decisions = Array.isArray(stored.demo.decisions) ? stored.demo.decisions : [];
    restoredDemo.copiedSourceTradeIds = new Set(
      Array.isArray(stored.demo.copiedSourceTradeIds) ? stored.demo.copiedSourceTradeIds : []
    );
    state.demo = restoredDemo;
    repairPrematureResolutionSettlements(state.demo);
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

  const watched = watchedSet.has(trade.trader.proxyWallet);
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
    const trader = state.traders[trade.trader.proxyWallet];
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

function repairPrematureResolutionSettlements(demo) {
  const reopened = [];
  const retainedClosed = [];
  let cashAdjustmentUsd = 0;
  let realizedPnlAdjustmentUsd = 0;

  for (const position of demo.closedPositions || []) {
    if (!isPrematureResolutionSettlement(position)) {
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
      resolutionRepairNote: 'Reopened after a premature null-PnL settlement',
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

function numberOrFallback(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
