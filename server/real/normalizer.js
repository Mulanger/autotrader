import { createHash } from 'node:crypto';

export function normalizeRealTrade(raw, options = {}) {
  if (!raw || typeof raw !== 'object') return null;

  const wallet = stringOrNull(raw.proxyWallet || raw.traderWallet || raw.wallet)?.toLowerCase();
  const side = String(raw.side || '').trim().toUpperCase();
  const price = numberOrNull(raw.price);
  const shares = numberOrNull(raw.size ?? raw.shares);
  const timestamp = toUnixSeconds(raw.timestamp ?? raw.createdAt ?? raw.ts);

  if (!wallet || side !== 'BUY' || !Number.isFinite(price) || price <= 0 || !Number.isFinite(timestamp)) {
    return null;
  }

  const transactionHash = stringOrNull(raw.transactionHash || raw.txHash);
  const asset = stringOrNull(raw.asset || raw.tokenId || raw.token_id);
  const conditionId = stringOrNull(raw.conditionId || raw.condition_id);
  const marketSlug = stringOrNull(raw.slug || raw.marketSlug);
  const eventSlug = stringOrNull(raw.eventSlug || raw.event_slug);
  const outcomeIndex = integerOrNull(raw.outcomeIndex ?? raw.outcome_index);

  return {
    id: makeRealTradeId({
      transactionHash,
      wallet,
      asset,
      conditionId,
      side,
      outcomeIndex,
      timestamp,
      shares,
      price,
    }),
    wallet,
    transactionHash,
    asset,
    conditionId,
    marketSlug,
    eventSlug,
    marketTitle: stringOrNull(raw.title || raw.question) || 'Unknown market',
    marketIcon: stringOrNull(raw.icon || raw.image),
    polymarketUrl: buildPolymarketUrl({ eventSlug, marketSlug }),
    side,
    outcome: stringOrNull(raw.outcome || raw.tokenOutcome) || 'Unknown outcome',
    outcomeIndex,
    shares,
    price,
    priceCents: price * 100,
    usdSize: Number.isFinite(shares) ? price * shares : null,
    timestamp,
    tradeTimestamp: new Date(timestamp * 1000).toISOString(),
    displayName: stringOrNull(raw.name || raw.displayName),
    pseudonym: stringOrNull(raw.pseudonym),
    profileImage: stringOrNull(raw.profileImageOptimized || raw.profileImage),
    source: options.source || 'real-follow-poll',
    raw,
  };
}

export function makeRealTradeId(parts) {
  const stableParts = [
    parts.transactionHash,
    parts.wallet,
    parts.asset,
    parts.conditionId,
    parts.side,
    parts.outcomeIndex,
    parts.timestamp,
    normalizeNumberForId(parts.shares),
    normalizeNumberForId(parts.price),
  ];
  return `real-src-${createHash('sha256').update(stableParts.map((part) => part ?? '').join('|')).digest('hex').slice(0, 32)}`;
}

function buildPolymarketUrl({ eventSlug, marketSlug }) {
  if (eventSlug) return `https://polymarket.com/event/${eventSlug}`;
  if (marketSlug) return `https://polymarket.com/market/${marketSlug}`;
  return null;
}

function toUnixSeconds(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function integerOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeNumberForId(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(12) : '';
}

function stringOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}
