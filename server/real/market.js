export function resolveTradeToken(trade, marketInfo = null) {
  if (trade?.asset) {
    return {
      tokenId: String(trade.asset),
      tickSize: numberOrNull(marketInfo?.tick_size ?? marketInfo?.mts) ?? null,
      negRisk: booleanOrNull(marketInfo?.neg_risk ?? marketInfo?.negRisk) ?? null,
      source: 'trade_asset',
    };
  }

  const tokens = normalizeTokens(marketInfo);
  const match = tokens.find((token) => sameOutcome(token.outcome, trade?.outcome));
  if (!match) {
    return {
      tokenId: null,
      tickSize: numberOrNull(marketInfo?.tick_size ?? marketInfo?.mts) ?? null,
      negRisk: booleanOrNull(marketInfo?.neg_risk ?? marketInfo?.negRisk) ?? null,
      source: 'missing_token',
    };
  }

  return {
    tokenId: match.tokenId,
    tickSize: numberOrNull(marketInfo?.tick_size ?? marketInfo?.mts) ?? null,
    negRisk: booleanOrNull(marketInfo?.neg_risk ?? marketInfo?.negRisk) ?? null,
    source: 'clob_market_info',
  };
}

function normalizeTokens(marketInfo) {
  const raw = marketInfo?.tokens || marketInfo?.t || [];
  if (!Array.isArray(raw)) return [];
  return raw.map((token) => ({
    tokenId: stringOrNull(token.token_id || token.asset_id || token.t),
    outcome: stringOrNull(token.outcome || token.o),
  })).filter((token) => token.tokenId && token.outcome);
}

function sameOutcome(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function booleanOrNull(value) {
  if (value === true || value === false) return value;
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim().toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  return null;
}

function stringOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}
