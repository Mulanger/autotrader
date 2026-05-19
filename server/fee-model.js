const CATEGORY_FEE_RATES = new Map([
  ['crypto', 0.072],
  ['sports', 0.03],
  ['finance', 0.04],
  ['politics', 0.04],
  ['economics', 0.05],
  ['culture', 0.05],
  ['weather', 0.05],
  ['other', 0.05],
  ['general', 0.05],
  ['mentions', 0.04],
  ['tech', 0.04],
  ['geopolitics', 0],
]);

export function buildEntryFeeModel(trade, { priceCents, shares }) {
  const price = Number(priceCents) / 100;
  const grossShares = Number(shares);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(grossShares) || grossShares <= 0) {
    return unknownFeeModel(grossShares);
  }

  const feeInfo = trade?.fees || {};
  const explicitFeeUsd = numberOrNull(feeInfo.feeUsd);
  const feeRate = resolveFeeRate(feeInfo, trade?.market?.category);
  let entryFeeUsd = null;
  let status = 'unknown';
  let source = 'unavailable';

  if (explicitFeeUsd !== null) {
    entryFeeUsd = roundFee(explicitFeeUsd);
    status = 'known';
    source = feeInfo.source || 'upstream-fee-usd';
  } else if (feeInfo.feesEnabled === false || feeRate === 0) {
    entryFeeUsd = 0;
    status = 'known';
    source = feeInfo.feesEnabled === false ? 'fees-disabled' : 'zero-fee-rate';
  } else if (feeRate !== null && feeInfo.feesEnabled === true) {
    entryFeeUsd = roundFee(grossShares * feeRate * price * (1 - price));
    status = 'estimated';
    source = feeInfo.feeRateSource || 'fee-rate';
  }

  const feeShares = entryFeeUsd === null ? null : entryFeeUsd / price;
  const netShares = feeShares === null ? grossShares : Math.max(0, grossShares - feeShares);

  return {
    status,
    source,
    collection: 'shares_on_buy',
    feesEnabled: feeInfo.feesEnabled ?? null,
    feeRate,
    feeRateBps: feeRate === null ? null : Math.round(feeRate * 10_000),
    entryFeeUsd,
    feeShares,
    grossShares,
    netShares,
  };
}

function resolveFeeRate(feeInfo, category) {
  const directRate = numberOrNull(feeInfo.feeRate);
  if (directRate !== null) return directRate;

  const bps = numberOrNull(feeInfo.feeRateBps);
  if (bps !== null) return bps / 10_000;

  if (feeInfo.feesEnabled === true) {
    const categoryRate = CATEGORY_FEE_RATES.get(String(category || '').trim().toLowerCase());
    if (categoryRate !== undefined) return categoryRate;
  }

  return null;
}

function unknownFeeModel(grossShares) {
  return {
    status: 'unknown',
    source: 'unavailable',
    collection: 'shares_on_buy',
    feesEnabled: null,
    feeRate: null,
    feeRateBps: null,
    entryFeeUsd: null,
    feeShares: null,
    grossShares: Number.isFinite(grossShares) ? grossShares : null,
    netShares: Number.isFinite(grossShares) ? grossShares : null,
  };
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundFee(value) {
  return Math.round(Number(value) * 100_000) / 100_000;
}
