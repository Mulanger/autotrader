import { createHash } from 'node:crypto';
import { CANDIDATE_MAX_USD, CANDIDATE_MIN_USD } from '../config.js';

export function normalizeCandidateTrade(raw, options = {}) {
  if (!raw || typeof raw !== 'object') return null;

  const minUsd = numberOrFallback(options.minUsd, CANDIDATE_MIN_USD);
  const maxUsd = numberOrFallback(options.maxUsd, CANDIDATE_MAX_USD);
  const wallet = stringOrNull(raw.proxyWallet || raw.traderWallet || raw.wallet)?.toLowerCase();
  const price = numberOrNull(raw.price);
  const shares = numberOrNull(raw.size ?? raw.shares);
  const usdSize = price !== null && shares !== null ? price * shares : null;
  const side = String(raw.side || '').trim().toUpperCase();
  const timestamp = toUnixSeconds(raw.timestamp ?? raw.createdAt ?? raw.ts);

  if (!wallet || !side || !Number.isFinite(usdSize) || usdSize < minUsd || usdSize >= maxUsd) return null;
  if (!Number.isFinite(timestamp)) return null;

  const outcomeIndex = integerOrNull(raw.outcomeIndex ?? raw.outcome_index);
  const transactionHash = stringOrNull(raw.transactionHash || raw.txHash);
  const asset = stringOrNull(raw.asset || raw.tokenId || raw.token_id);
  const conditionId = stringOrNull(raw.conditionId || raw.condition_id);
  const slug = stringOrNull(raw.slug || raw.marketSlug);
  const eventSlug = stringOrNull(raw.eventSlug || raw.event_slug);

  return {
    id: makeCandidateTradeId({
      transactionHash,
      wallet,
      asset,
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
    marketSlug: slug,
    eventSlug,
    marketTitle: stringOrNull(raw.title || raw.question) || 'Unknown market',
    marketIcon: stringOrNull(raw.icon || raw.image),
    polymarketUrl: buildPolymarketUrl({ eventSlug, slug }),
    side,
    outcome: stringOrNull(raw.outcome || raw.tokenOutcome) || 'Unknown outcome',
    outcomeIndex,
    shares,
    price,
    priceCents: price * 100,
    usdSize,
    timestamp,
    tradeTimestamp: new Date(timestamp * 1000).toISOString(),
    displayName: stringOrNull(raw.name || raw.displayName),
    pseudonym: stringOrNull(raw.pseudonym),
    profileImage: stringOrNull(raw.profileImageOptimized || raw.profileImage),
    source: options.source || 'live',
    status: 'open',
    raw,
  };
}

export function makeCandidateTradeId(parts) {
  const stableParts = [
    parts.transactionHash,
    parts.wallet,
    parts.asset,
    parts.side,
    parts.outcomeIndex,
    parts.timestamp,
    normalizeNumberForId(parts.shares),
    normalizeNumberForId(parts.price),
  ];
  return `candidate-${createHash('sha256').update(stableParts.map((part) => part ?? '').join('|')).digest('hex').slice(0, 32)}`;
}

function buildPolymarketUrl({ eventSlug, slug }) {
  if (eventSlug) return `https://polymarket.com/event/${eventSlug}`;
  if (slug) return `https://polymarket.com/market/${slug}`;
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

function numberOrFallback(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
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
