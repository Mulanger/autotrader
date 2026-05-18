import { settleDemoPosition, updateOpenPositionPrices } from './demo-engine.js';

export async function reconcileOpenDemoPositions(state, fetchTradeById) {
  const openPositions = [...(state.demo?.openPositions || [])];
  if (!openPositions.length) {
    return { changed: false, checked: 0, settled: [], errors: [] };
  }

  let changed = false;
  const settled = [];
  const errors = [];

  const results = await Promise.allSettled(
    openPositions.map(async (position) => {
      const trade = await fetchTradeById(position.sourceTradeId);
      return { position, trade };
    })
  );

  for (const result of results) {
    if (result.status === 'rejected') {
      errors.push(result.reason?.message || String(result.reason));
      continue;
    }

    const { position, trade } = result.value;
    if (!trade) continue;

    const livePosition = state.demo.openPositions.find((item) => item.id === position.id);
    if (!livePosition) continue;

    const previousPrice = livePosition.currentPriceCents;
    updateOpenPositionPrices(state.demo, trade);
    livePosition.resolutionLastCheckedAt = new Date().toISOString();
    livePosition.resolutionStatus = trade.resolution?.status || livePosition.resolutionStatus || 'open';
    if (trade.resolution?.winningOutcome) livePosition.winningOutcome = trade.resolution.winningOutcome;

    if (previousPrice !== livePosition.currentPriceCents) changed = true;

    const settlement = buildSettlementForPosition(livePosition, trade);
    if (!settlement) continue;

    const closed = settleDemoPosition(state.demo, livePosition.id, settlement);
    if (closed) {
      changed = true;
      settled.push(closed);
    }
  }

  return { changed, checked: openPositions.length, settled, errors };
}

export function buildSettlementForPosition(position, trade) {
  const resolution = trade?.resolution || {};
  const resolutionStatus = String(resolution.status || '').toLowerCase();

  if (!isResolvableStatus(resolutionStatus, resolution)) return null;

  if (resolutionStatus === 'invalid') {
    return {
      status: 'invalid',
      exitPriceCents: position.entryPriceCents,
      exitValueUsd: position.stakeUsd,
      realizedPnlUsd: 0,
      resolvedAt: resolution.resolvedAt,
      resolutionStatus,
      winningOutcome: resolution.winningOutcome || null,
      settlementSource: 'polywhale-resolution',
      sourceTradeId: trade.id,
      reason: 'Market invalidated; demo stake refunded',
    };
  }

  const won = inferWin(position, resolution);
  if (won === null) return null;

  const exitValueUsd = won ? position.shares : 0;
  const realizedPnlUsd = exitValueUsd - position.stakeUsd;

  return {
    status: won ? 'win' : 'loss',
    exitPriceCents: won ? 100 : 0,
    exitValueUsd,
    realizedPnlUsd,
    resolvedAt: resolution.resolvedAt,
    resolutionStatus,
    winningOutcome: resolution.winningOutcome || null,
    settlementSource: 'polywhale-resolution',
    sourceTradeId: trade.id,
    reason: `Official market resolution: ${won ? 'won' : 'lost'} ${formatSignedUsd(realizedPnlUsd)}`,
  };
}

function isResolvableStatus(status, resolution) {
  if (status === 'invalid' || status === 'resolved_win' || status === 'resolved_loss') return true;
  if (status === 'resolved' && resolution.winningOutcome) return true;
  return hasNumericValue(resolution.pnlUsd);
}

function inferWin(position, resolution) {
  const status = String(resolution.status || '').toLowerCase();
  if (status === 'resolved_win') return true;
  if (status === 'resolved_loss') return false;

  const match = outcomeMatches(position.outcome, resolution.winningOutcome);
  if (match !== null) return match;

  if (hasNumericValue(resolution.pnlUsd)) {
    return Number(resolution.pnlUsd) >= 0;
  }

  return null;
}

function outcomeMatches(outcome, winningOutcome) {
  const normalizedOutcome = normalizeOutcomeLabel(outcome);
  const normalizedWinner = normalizeOutcomeLabel(winningOutcome);
  if (!normalizedOutcome || !normalizedWinner) return null;
  if (normalizedOutcome === normalizedWinner) return true;
  if (['YES', 'NO'].includes(normalizedOutcome) && ['YES', 'NO'].includes(normalizedWinner)) return false;
  return null;
}

function normalizeOutcomeLabel(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toUpperCase();
  return text || null;
}

function hasNumericValue(value) {
  if (value === null || value === undefined || value === '') return false;
  return Number.isFinite(Number(value));
}

function formatSignedUsd(value) {
  const prefix = value >= 0 ? '+' : '-';
  return `${prefix}$${Math.abs(value).toFixed(2)}`;
}
