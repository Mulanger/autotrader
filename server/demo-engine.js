import { DEMO_STAKE_USD, DEMO_STARTING_CAPITAL_USD } from './config.js';
import { buildEntryFeeModel } from './fee-model.js';
import { getTradeCurrentPriceCents } from './trade-normalizer.js';
import { nowIso } from './format.js';

export function createDemoState() {
  return {
    startingCapitalUsd: DEMO_STARTING_CAPITAL_USD,
    cashUsd: DEMO_STARTING_CAPITAL_USD,
    fixedStakeUsd: DEMO_STAKE_USD,
    realizedPnlUsd: 0,
    copiedCount: 0,
    skippedCount: 0,
    totalNotionalCopiedUsd: 0,
    openPositions: [],
    closedPositions: [],
    decisions: [],
    copiedSourceTradeIds: new Set(),
  };
}

export function evaluateDemoCopy(demo, trade) {
  if (!trade || demo.copiedSourceTradeIds.has(trade.id)) {
    return null;
  }

  const side = trade.side;
  if (side === 'BUY') return copyBuy(demo, trade);
  if (side === 'SELL') {
    return recordDecision(demo, trade, {
      action: 'skipped',
      reason: 'SELL observed; demo positions settle from official market resolution',
    });
  }

  return recordDecision(demo, trade, {
    action: 'skipped',
    reason: `Unsupported side ${side}`,
  });
}

export function markToMarket(demo) {
  const positions = [...demo.openPositions, ...demo.closedPositions];
  const openValueUsd = demo.openPositions.reduce((sum, position) => {
    return sum + position.shares * (position.currentPriceCents / 100);
  }, 0);

  const unrealizedPnlUsd = demo.openPositions.reduce((sum, position) => {
    return sum + (position.currentPriceCents - position.entryPriceCents) / 100 * position.shares;
  }, 0);

  return {
    cashUsd: demo.cashUsd,
    startingCapitalUsd: demo.startingCapitalUsd,
    equityUsd: demo.cashUsd + openValueUsd,
    openValueUsd,
    realizedPnlUsd: demo.realizedPnlUsd,
    unrealizedPnlUsd,
    totalPnlUsd: demo.realizedPnlUsd + unrealizedPnlUsd,
    copiedCount: demo.copiedCount,
    skippedCount: demo.skippedCount,
    totalNotionalCopiedUsd: demo.totalNotionalCopiedUsd,
    knownEntryFeesUsd: positions.reduce((sum, position) => sum + (numberOrNull(position.entryFeeUsd) ?? 0), 0),
    feeUnknownCount: positions.filter((position) => position.feeStatus === 'unknown' || !position.feeStatus).length,
    fixedStakeUsd: demo.fixedStakeUsd,
    openPositionCount: demo.openPositions.length,
    closedPositionCount: demo.closedPositions.length,
  };
}

export function updateOpenPositionPrices(demo, trade) {
  const price = getTradeCurrentPriceCents(trade);
  if (!Number.isFinite(price)) return;

  for (const position of demo.openPositions) {
    if (position.marketSlug === trade.market.slug && sameOutcome(position.outcome, trade.outcome)) {
      position.currentPriceCents = price;
      position.updatedAt = nowIso();
      position.unrealizedPnlUsd = (position.currentPriceCents - position.entryPriceCents) / 100 * position.shares;
      position.unrealizedPnlPct = position.entryPriceCents
        ? ((position.currentPriceCents - position.entryPriceCents) / position.entryPriceCents) * 100
        : 0;
    }
  }
}

function copyBuy(demo, trade) {
  const price = getTradeCurrentPriceCents(trade);
  if (!Number.isFinite(price) || price <= 0) {
    return recordDecision(demo, trade, {
      action: 'skipped',
      reason: 'No usable execution price',
    });
  }

  if (demo.cashUsd < demo.fixedStakeUsd) {
    return recordDecision(demo, trade, {
      action: 'skipped',
      reason: 'Demo cash below fixed stake',
    });
  }

  const grossShares = demo.fixedStakeUsd / (price / 100);
  const fee = buildEntryFeeModel(trade, { priceCents: price, shares: grossShares });
  const position = {
    id: `demo-${trade.id}`,
    sourceTradeId: trade.id,
    traderWallet: trade.trader.proxyWallet,
    traderName: trade.trader.displayName || trade.trader.pseudonym || trade.trader.proxyWallet,
    marketSlug: trade.market.slug,
    marketTitle: trade.market.title,
    marketIcon: trade.market.icon,
    polymarketUrl: trade.market.polymarketUrl,
    side: trade.side,
    outcome: trade.outcome,
    stakeUsd: demo.fixedStakeUsd,
    shares: fee.netShares ?? grossShares,
    grossShares,
    entryFeeUsd: fee.entryFeeUsd,
    feeShares: fee.feeShares,
    feeStatus: fee.status,
    feeSource: fee.source,
    feeCollection: fee.collection,
    feeRate: fee.feeRate,
    feeRateBps: fee.feeRateBps,
    feesEnabled: fee.feesEnabled,
    entryPriceCents: price,
    currentPriceCents: price,
    openedAt: new Date(trade.timestamp * 1000).toISOString(),
    updatedAt: nowIso(),
    status: 'open',
    unrealizedPnlUsd: 0,
    unrealizedPnlPct: 0,
  };

  demo.cashUsd -= demo.fixedStakeUsd;
  demo.copiedCount += 1;
  demo.totalNotionalCopiedUsd += demo.fixedStakeUsd;
  demo.openPositions.unshift(position);
  demo.copiedSourceTradeIds.add(trade.id);

  return recordDecision(demo, trade, {
    action: 'copied',
    reason: `Copied BUY with fixed $${demo.fixedStakeUsd} demo stake; awaiting market resolution`,
    copyId: position.id,
  });
}

export function settleDemoPosition(demo, positionId, settlement) {
  const index = demo.openPositions.findIndex((position) => position.id === positionId);
  if (index === -1) return null;

  const [position] = demo.openPositions.splice(index, 1);
  const exitValueUsd = settlement.exitValueUsd;
  const realizedPnlUsd = settlement.realizedPnlUsd;
  const closed = {
    ...position,
    status: settlement.status,
    exitPriceCents: settlement.exitPriceCents,
    exitValueUsd,
    payoutUsd: exitValueUsd,
    realizedPnlUsd,
    closedAt: settlement.resolvedAt || nowIso(),
    resolvedAt: settlement.resolvedAt || nowIso(),
    closeSourceTradeId: settlement.sourceTradeId || position.sourceTradeId,
    resolutionStatus: settlement.resolutionStatus || settlement.status,
    winningOutcome: settlement.winningOutcome || null,
    settlementSource: settlement.settlementSource || 'resolution',
    settlementReason: settlement.reason || null,
    unrealizedPnlUsd: 0,
    unrealizedPnlPct: 0,
  };

  demo.cashUsd += exitValueUsd;
  demo.realizedPnlUsd += realizedPnlUsd;
  demo.closedPositions.unshift(closed);
  demo.closedPositions = demo.closedPositions.slice(0, 500);

  recordDecision(demo, { id: position.sourceTradeId }, {
    action: 'settled',
    reason: settlement.reason || `Settled from official resolution: ${formatSignedUsd(realizedPnlUsd)}`,
    copyId: closed.id,
    at: closed.closedAt,
  });

  return closed;
}

function recordDecision(demo, trade, decision) {
  if (decision.action === 'skipped') demo.skippedCount += 1;
  const entry = {
    id: `${trade.id}-${decision.action}`,
    tradeId: trade.id,
    action: decision.action,
    reason: decision.reason,
    copyId: decision.copyId || null,
    at: decision.at || nowIso(),
  };
  demo.decisions.unshift(entry);
  demo.decisions = demo.decisions.slice(0, 200);
  return entry;
}

function sameOutcome(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatSignedUsd(value) {
  const prefix = value >= 0 ? '+' : '-';
  return `${prefix}$${Math.abs(value).toFixed(2)}`;
}
