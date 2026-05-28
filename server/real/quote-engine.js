export function evaluateDryRunFokBuy({
  trade,
  orderBook,
  stakeUsd = 10,
  guardCents = 4,
  checkedAt = new Date().toISOString(),
} = {}) {
  const sourcePriceCents = numberOrNull(trade?.priceCents);
  const stake = numberOrNull(stakeUsd);
  const guard = numberOrNull(guardCents);
  if (!Number.isFinite(sourcePriceCents) || sourcePriceCents <= 0) {
    return rejected('missing_source_price', 'Source trade has no usable BUY price', { checkedAt, stakeUsd: stake });
  }
  if (!Number.isFinite(stake) || stake <= 0) {
    return rejected('invalid_stake', 'Real stake is not usable', { checkedAt, sourcePriceCents });
  }

  const minGuardCents = Math.max(0, sourcePriceCents - (Number.isFinite(guard) ? guard : 4));
  const maxGuardCents = Math.min(100, sourcePriceCents + (Number.isFinite(guard) ? guard : 4));
  const asks = normalizeLevels(orderBook?.asks, 'asc');
  if (!asks.length) {
    return rejected('empty_orderbook', 'No asks available in the CLOB order book', {
      checkedAt,
      sourcePriceCents,
      minGuardCents,
      maxGuardCents,
      stakeUsd: stake,
      bookHash: orderBook?.hash || null,
    });
  }

  const bestAsk = asks[0];
  const bestAskCents = bestAsk.price * 100;
  if (bestAskCents > maxGuardCents) {
    return rejected('above_price_guard', `Best ask ${formatCents(bestAskCents)} is above ${formatCents(maxGuardCents)} upper guard`, {
      checkedAt,
      sourcePriceCents,
      minGuardCents,
      maxGuardCents,
      stakeUsd: stake,
      bestAskCents,
      bookHash: orderBook?.hash || null,
    });
  }

  let remainingUsd = stake;
  let estimatedShares = 0;
  let notionalAvailableUsd = 0;
  let worstAskCents = null;

  for (const level of asks) {
    const priceCents = level.price * 100;
    if (priceCents > maxGuardCents) break;
    const levelNotional = level.price * level.size;
    notionalAvailableUsd += levelNotional;
    const spend = Math.min(remainingUsd, levelNotional);
    estimatedShares += spend / level.price;
    remainingUsd -= spend;
    worstAskCents = priceCents;
    if (remainingUsd <= 1e-9) break;
  }

  if (remainingUsd > 1e-6) {
    return rejected('insufficient_liquidity', `Not enough ask liquidity to fill ${formatUsd(stake)} within ${formatCents(maxGuardCents)}`, {
      checkedAt,
      sourcePriceCents,
      minGuardCents,
      maxGuardCents,
      stakeUsd: stake,
      bestAskCents,
      worstAskCents,
      notionalAvailableUsd,
      bookHash: orderBook?.hash || null,
    });
  }

  const vwapCents = estimatedShares > 0 ? (stake / estimatedShares) * 100 : null;
  return {
    status: 'would_fill',
    reasonCode: null,
    reason: 'Dry-run FOK BUY would fill',
    checkedAt,
    sourcePriceCents,
    minGuardCents,
    maxGuardCents,
    stakeUsd: stake,
    bestAskCents,
    worstAskCents,
    vwapCents,
    estimatedShares,
    notionalAvailableUsd,
    bookHash: orderBook?.hash || null,
  };
}

export function normalizeLevels(levels, order = 'asc') {
  const normalized = (Array.isArray(levels) ? levels : [])
    .map((level) => ({
      price: numberOrNull(level?.price),
      size: numberOrNull(level?.size),
    }))
    .filter((level) => Number.isFinite(level.price) && level.price > 0 && Number.isFinite(level.size) && level.size > 0);
  normalized.sort((a, b) => (order === 'desc' ? b.price - a.price : a.price - b.price));
  return normalized;
}

function rejected(reasonCode, reason, extra = {}) {
  return {
    status: 'rejected',
    reasonCode,
    reason,
    ...extra,
  };
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatCents(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(1)}c` : 'n/a';
}

function formatUsd(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `$${number.toFixed(2)}` : 'n/a';
}
