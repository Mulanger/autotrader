import { createDemoState } from './demo-engine.js';
import { nowIso } from './format.js';

export const SHADOW_TRADER_STRATEGY = 'ecp_top20_v1';

export const SHADOW_TRADER_CRITERIA = {
  selectionLimit: 20,
  rankedCandidateLimit: 80,
  minCopyableMarkets: 20,
  minCopyableWins: 12,
  minDistinctEvents: 6,
  minEdgeLowerBoundPct: 0,
  minProfitFactor: 1.3,
  maxTopWinSharePct: 35,
  minFillRatePct: 50,
  minFillRateAttempts: 20,
};

export function createShadowTraderState(overrides = {}) {
  return {
    enabled: true,
    strategy: SHADOW_TRADER_STRATEGY,
    label: 'ECP top 20 shadow',
    status: 'starting',
    criteria: SHADOW_TRADER_CRITERIA,
    selectedWallets: {},
    rankedCandidates: [],
    selectedWalletCount: 0,
    candidatesScoredCount: 0,
    lastEvaluatedAt: null,
    lastChangedCount: 0,
    lastCopiedCount: 0,
    feed: [],
    portfolio: createDemoState({ positionIdPrefix: 'shadow-v1' }),
    ...overrides,
  };
}

export function ensureShadowTraderState(state) {
  if (!state.shadowTrader || typeof state.shadowTrader !== 'object') {
    state.shadowTrader = createShadowTraderState();
  }
  state.shadowTrader.portfolio = normalizeShadowPortfolio(state.shadowTrader.portfolio);
  state.shadowTrader.selectedWallets = normalizeSelectedWallets(state.shadowTrader.selectedWallets);
  state.shadowTrader.selectedWalletCount = Object.keys(state.shadowTrader.selectedWallets).length;
  state.shadowTrader.criteria = state.shadowTrader.criteria || SHADOW_TRADER_CRITERIA;
  state.shadowTrader.strategy = state.shadowTrader.strategy || SHADOW_TRADER_STRATEGY;
  state.shadowTrader.label = state.shadowTrader.label || 'ECP top 20 shadow';
  state.shadowTrader.feed = Array.isArray(state.shadowTrader.feed) ? state.shadowTrader.feed : [];
  state.shadowTrader.rankedCandidates = Array.isArray(state.shadowTrader.rankedCandidates)
    ? state.shadowTrader.rankedCandidates
    : [];
  return state.shadowTrader;
}

export function applyShadowTraderSnapshot(state, snapshot = {}) {
  const current = ensureShadowTraderState(state);
  const selectedWallets = normalizeSelectedWallets(snapshot.selectedWallets || {});
  const previous = new Set(Object.keys(current.selectedWallets || {}));
  const next = new Set(Object.keys(selectedWallets));
  let changed = 0;

  for (const wallet of next) {
    if (!previous.has(wallet)) changed += 1;
  }
  for (const wallet of previous) {
    if (!next.has(wallet)) changed += 1;
  }

  state.shadowTrader = {
    ...current,
    ...snapshot,
    enabled: snapshot.enabled ?? current.enabled ?? true,
    strategy: snapshot.strategy || current.strategy || SHADOW_TRADER_STRATEGY,
    label: snapshot.label || current.label || 'ECP top 20 shadow',
    criteria: snapshot.criteria || current.criteria || SHADOW_TRADER_CRITERIA,
    selectedWallets,
    rankedCandidates: Array.isArray(snapshot.rankedCandidates) ? snapshot.rankedCandidates : current.rankedCandidates || [],
    selectedWalletCount: Object.keys(selectedWallets).length,
    candidatesScoredCount: Number(snapshot.candidatesScoredCount || 0),
    lastEvaluatedAt: snapshot.lastEvaluatedAt || nowIso(),
    lastChangedCount: changed,
    portfolio: current.portfolio,
    feed: current.feed,
  };

  return state.shadowTrader;
}

export function isShadowTraderWalletSelected(state, wallet) {
  const normalized = normalizeWallet(wallet);
  if (!normalized) return false;
  const shadow = ensureShadowTraderState(state);
  return Boolean(shadow.enabled && shadow.selectedWallets?.[normalized]);
}

export function normalizeShadowPortfolio(portfolio = {}) {
  const restored = {
    ...createDemoState({ positionIdPrefix: 'shadow-v1' }),
    ...(portfolio || {}),
    positionIdPrefix: 'shadow-v1',
  };
  restored.openPositions = Array.isArray(restored.openPositions) ? restored.openPositions : [];
  restored.closedPositions = Array.isArray(restored.closedPositions) ? restored.closedPositions : [];
  restored.decisions = Array.isArray(restored.decisions) ? restored.decisions : [];
  restored.copiedSourceTradeIds = new Set(
    Array.isArray(restored.copiedSourceTradeIds) ? restored.copiedSourceTradeIds : [...(restored.copiedSourceTradeIds || [])]
  );
  restored.copiedMarketKeys = new Set(
    Array.isArray(restored.copiedMarketKeys) ? restored.copiedMarketKeys : [...(restored.copiedMarketKeys || [])]
  );
  restored.copiedTraderMarketKeys = new Set(
    Array.isArray(restored.copiedTraderMarketKeys)
      ? restored.copiedTraderMarketKeys
      : [...(restored.copiedTraderMarketKeys || [])]
  );
  return restored;
}

function normalizeSelectedWallets(wallets = {}) {
  const normalized = {};
  for (const [wallet, row] of Object.entries(wallets || {})) {
    const key = normalizeWallet(wallet || row?.wallet);
    if (!key) continue;
    normalized[key] = {
      ...(row || {}),
      wallet: key,
      status: row?.status || 'active',
    };
  }
  return normalized;
}

function normalizeWallet(value) {
  const text = String(value || '').trim().toLowerCase();
  return text || null;
}
