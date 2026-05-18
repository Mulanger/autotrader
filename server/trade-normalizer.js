import { toUnixSeconds } from './format.js';

export function normalizeStreamMessage(raw) {
  if (!raw) return null;
  if (raw.type === 'hello') return { kind: 'hello', serverTime: raw.serverTime };
  if (raw.type === 'trade' || raw.type === 'whale') return normalizeTrade(raw.trade || raw.data || raw.item || raw);
  if (raw.trade || raw.data?.trade) return normalizeTrade(raw.trade || raw.data.trade);
  if (raw.id && raw.market && raw.trader) return normalizeTrade(raw);
  return null;
}

export function normalizeTrade(input) {
  if (!input || !input.id) return null;
  const wallet = String(
    input.trader?.proxyWallet ||
      input.proxyWallet ||
      input.traderWallet ||
      input.wallet ||
      ''
  ).toLowerCase();

  const market = input.market || {};
  const priceCents = Number(input.priceCents ?? input.price ?? input.executionPriceCents ?? 0);
  const normalized = {
    id: String(input.id),
    tier: input.tier || 'unknown',
    side: String(input.side || '').toUpperCase() || 'UNKNOWN',
    outcome: input.outcome || input.tokenOutcome || 'Unknown outcome',
    usdSize: Number(input.usdSize ?? input.sizeUsd ?? input.amountUsd ?? 0),
    shares: Number(input.shares ?? 0),
    priceCents,
    priceMillicents: Number(input.priceMillicents ?? priceCents * 100),
    timestamp: toUnixSeconds(input.timestamp ?? input.createdAt ?? input.ts),
    market: {
      conditionId: market.conditionId || market.condition_id || null,
      slug: market.slug || null,
      title: market.title || market.question || 'Unknown market',
      icon: market.icon || market.image || null,
      category: market.category || null,
      eventSlug: market.eventSlug || null,
      yesPriceCents: numberOrNull(market.yesPriceCents),
      noPriceCents: numberOrNull(market.noPriceCents),
      polymarketUrl: market.polymarketUrl || market.url || null,
    },
    trader: {
      proxyWallet: wallet,
      pseudonym: input.trader?.pseudonym || input.pseudonym || null,
      displayName: input.trader?.displayName || input.displayName || null,
      profileImage: input.trader?.profileImage || input.profileImage || null,
      winRate: numberOrNull(input.trader?.winRate ?? input.winRate),
      tradeCount: numberOrNull(input.trader?.tradeCount ?? input.tradeCount),
    },
    transactionHash: input.transactionHash || input.txHash || null,
    resolution: normalizeResolution(input),
  };

  return normalized.trader.proxyWallet ? normalized : null;
}

export function getTradeCurrentPriceCents(trade) {
  const outcome = String(trade?.outcome || '').toUpperCase();
  if (outcome === 'YES' && Number.isFinite(trade?.market?.yesPriceCents)) {
    return trade.market.yesPriceCents;
  }
  if (outcome === 'NO' && Number.isFinite(trade?.market?.noPriceCents)) {
    return trade.market.noPriceCents;
  }
  return Number.isFinite(trade?.priceCents) ? trade.priceCents : null;
}

function normalizeResolution(input) {
  const source = firstObject(input.resolution, input.outcomeResolution, input.market?.resolution, input.outcomeStatus) || {};
  const rawStatus = String(
    source.status ||
      input.status ||
      input.resolutionStatus ||
      input.outcomeStatus ||
      ''
  ).toLowerCase();
  const winningOutcome = stringOrNull(
    source.winningOutcome ??
      source.winner ??
      input.winningOutcome ??
      input.market?.winningOutcome
  );
  const payoutUsd = numberOrNull(source.payoutUsd ?? input.payoutUsd);
  const pnlUsd = numberOrNull(source.pnlUsd ?? input.pnlUsd ?? input.profitUsd ?? input.realizedPnlUsd);
  const resolvedAt = isoTimeOrNull(source.resolvedAt ?? input.resolvedAt ?? input.closedAt ?? input.market?.resolvedAt);
  const closed = Boolean(source.closed) || isClosedStatus(rawStatus) || Boolean(resolvedAt && rawStatus !== 'open');
  const status = normalizeResolutionStatus(rawStatus, { pnlUsd, closed, winningOutcome });

  return {
    status,
    rawStatus: rawStatus || null,
    winningOutcome,
    payoutUsd,
    pnlUsd,
    resolvedAt,
    closed: status !== 'open' || closed,
  };
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstObject(...values) {
  return values.find((value) => value && typeof value === 'object' && !Array.isArray(value));
}

function stringOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizeResolutionStatus(rawStatus, { pnlUsd, closed, winningOutcome }) {
  if (rawStatus.includes('invalid') || rawStatus.includes('void') || rawStatus.includes('cancel')) {
    return 'invalid';
  }
  if (rawStatus.includes('resolved_win') || rawStatus === 'win' || rawStatus === 'won') {
    return 'resolved_win';
  }
  if (rawStatus.includes('resolved_loss') || rawStatus === 'loss' || rawStatus === 'lost') {
    return 'resolved_loss';
  }
  if (rawStatus.includes('resolved')) return 'resolved';
  if (rawStatus.includes('closed')) return 'closed';
  if (pnlUsd !== null) return pnlUsd >= 0 ? 'resolved_win' : 'resolved_loss';
  if (closed && winningOutcome) return 'resolved';
  if (closed) return 'closed';
  return 'open';
}

function isClosedStatus(status) {
  return ['closed', 'resolved', 'resolved_win', 'resolved_loss', 'invalid'].some((closedStatus) => {
    return status.includes(closedStatus);
  });
}

function isoTimeOrNull(value) {
  if (!value) return null;
  let millis;
  if (typeof value === 'number') {
    millis = value > 10_000_000_000 ? value : value * 1000;
  } else {
    millis = Date.parse(value);
  }
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}
