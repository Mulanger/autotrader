export function buildCandidateSettlement(trade, resolution, now = new Date()) {
  const status = normalizeResolutionStatus(resolution);
  if (status === 'open' || status === 'closed') return null;

  if (status === 'invalid') {
    return {
      status: 'invalid',
      payoutUsd: isBuy(trade) ? numberOrFallback(trade.usdSize, 0) : numberOrFallback(trade.usdSize, null),
      pnlUsd: isBuy(trade) ? 0 : null,
      winningOutcome: resolution?.winningOutcome || null,
      winningOutcomeIndex: integerOrNull(resolution?.winningOutcomeIndex),
      resolvedAt: isoOrNow(resolution?.resolvedAt, now),
      resolutionSource: resolution?.source || 'polymarket-gamma',
    };
  }

  const selectedOutcomeWon = inferSelectedOutcomeWon(trade, resolution);
  if (selectedOutcomeWon === null) return null;

  if (isBuy(trade)) {
    const payoutUsd = selectedOutcomeWon ? numberOrFallback(trade.shares, 0) : 0;
    const pnlUsd = payoutUsd - numberOrFallback(trade.usdSize, 0);
    return {
      status: selectedOutcomeWon ? 'resolved_win' : 'resolved_loss',
      payoutUsd,
      pnlUsd,
      winningOutcome: resolution?.winningOutcome || null,
      winningOutcomeIndex: integerOrNull(resolution?.winningOutcomeIndex),
      resolvedAt: isoOrNow(resolution?.resolvedAt, now),
      resolutionSource: resolution?.source || 'polymarket-gamma',
    };
  }

  if (isSell(trade)) {
    const goodSell = !selectedOutcomeWon;
    return {
      status: goodSell ? 'resolved_win' : 'resolved_loss',
      payoutUsd: numberOrFallback(trade.usdSize, null),
      pnlUsd: null,
      winningOutcome: resolution?.winningOutcome || null,
      winningOutcomeIndex: integerOrNull(resolution?.winningOutcomeIndex),
      resolvedAt: isoOrNow(resolution?.resolvedAt, now),
      resolutionSource: resolution?.source || 'polymarket-gamma',
    };
  }

  return null;
}

function inferSelectedOutcomeWon(trade, resolution) {
  const tradeOutcomeIndex = integerOrNull(trade?.outcomeIndex);
  const winningOutcomeIndex = integerOrNull(resolution?.winningOutcomeIndex);
  if (tradeOutcomeIndex !== null && winningOutcomeIndex !== null) return tradeOutcomeIndex === winningOutcomeIndex;

  const selected = normalizeLabel(trade?.outcome);
  const winner = normalizeLabel(resolution?.winningOutcome);
  if (!selected || !winner) return null;
  return selected === winner;
}

function normalizeResolutionStatus(resolution) {
  const raw = String(resolution?.status || '').toLowerCase();
  if (raw === 'invalid' || raw.includes('invalid') || raw.includes('void') || raw.includes('cancel')) return 'invalid';
  if (raw === 'resolved' || raw === 'resolved_win' || raw === 'resolved_loss') return 'resolved';
  if (raw === 'closed' && (resolution?.winningOutcome || integerOrNull(resolution?.winningOutcomeIndex) !== null)) return 'resolved';
  if (raw === 'closed') return 'closed';
  return 'open';
}

function isBuy(trade) {
  return String(trade?.side || '').toUpperCase() === 'BUY';
}

function isSell(trade) {
  return String(trade?.side || '').toUpperCase() === 'SELL';
}

function normalizeLabel(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toUpperCase();
  return text || null;
}

function integerOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function numberOrFallback(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function isoOrNow(value, now) {
  if (!value) return now.toISOString();
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : now.toISOString();
}
