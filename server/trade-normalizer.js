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
  const status = String(input.status || input.resolutionStatus || input.outcomeStatus || '').toLowerCase();
  const pnlUsd = numberOrNull(input.pnlUsd ?? input.profitUsd ?? input.realizedPnlUsd);
  if (status.includes('resolved_win') || status === 'win') return { status: 'win', pnlUsd };
  if (status.includes('resolved_loss') || status === 'loss') return { status: 'loss', pnlUsd };
  if (pnlUsd !== null) return { status: pnlUsd >= 0 ? 'win' : 'loss', pnlUsd };
  return { status: 'open', pnlUsd: null };
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
