import { POLYMARKET_GAMMA_URL } from './config.js';

export async function fetchGammaResolution({ conditionId, slug }) {
  const markets = await fetchGammaMarkets({ conditionId, slug });
  const market = markets[0];
  if (!market) return null;

  return classifyGammaMarket(market);
}

async function fetchGammaMarkets({ conditionId, slug }) {
  const queries = [];
  for (const closed of [false, true]) {
    const query = { closed, limit: 100 };
    if (conditionId) query.condition_ids = conditionId;
    else if (slug) query.slug = slug;
    else continue;
    queries.push(query);
  }

  const results = [];
  for (const query of queries) {
    const url = new URL('/markets', POLYMARKET_GAMMA_URL);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
    const json = await response.json();
    if (Array.isArray(json)) results.push(...json);
  }
  return results;
}

export function classifyGammaMarket(market, now = new Date()) {
  const outcomes = parseArray(market.outcomes).map(String);
  const prices = parseArray(market.outcomePrices).map(Number);
  const umaResolutionStatuses = parseArray(market.umaResolutionStatuses).map((status) => String(status).toLowerCase());
  const closed = market.closed === true || market.active === false || market.acceptingOrders === false;
  const finalIndex = prices.findIndex((price) => isFinalPrice(price, 1));
  const hasSingleWinner = finalIndex >= 0 && prices.every((price, index) => {
    return index === finalIndex ? isFinalPrice(price, 1) : isFinalPrice(price, 0);
  });
  const nearFinalIndex = prices.findIndex((price) => isNearFinalPrice(price, 1));
  const hasNearSingleWinner = nearFinalIndex >= 0 && prices.every((price, index) => {
    return index === nearFinalIndex ? isNearFinalPrice(price, 1) : isNearFinalPrice(price, 0);
  });
  const proposed = umaResolutionStatuses.some((status) => status.includes('proposed'));

  if (!closed) {
    return {
      status: 'open',
      rawStatus: proposed ? 'gamma_proposed' : hasNearSingleWinner ? 'gamma_near_final_open' : 'gamma_open',
      winningOutcome: null,
      resolvedAt: null,
      closed: false,
      source: 'polymarket-gamma',
      proposed,
      nearFinal: hasNearSingleWinner,
    };
  }

  if (!hasSingleWinner) {
    return {
      status: 'closed',
      rawStatus: 'gamma_closed',
      winningOutcome: null,
      resolvedAt: null,
      closed: true,
      source: 'polymarket-gamma',
    };
  }

  return {
    status: 'resolved',
    rawStatus: 'gamma_resolved',
    winningOutcome: outcomes[finalIndex] || (finalIndex === 0 ? 'YES' : 'NO'),
    winningOutcomeIndex: finalIndex,
    resolvedAt: market.resolvedAt || market.closedTime || market.updatedAt || now.toISOString(),
    closed: true,
    source: 'polymarket-gamma',
    finalOutcomePrices: prices,
  };
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isFinalPrice(value, expected) {
  return Number.isFinite(value) && Math.abs(value - expected) < 1e-9;
}

function isNearFinalPrice(value, expected) {
  if (!Number.isFinite(value)) return false;
  return expected === 1 ? value >= 0.99 : value <= 0.01;
}
