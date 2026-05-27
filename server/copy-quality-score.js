export function scoreCopyTrader(row = {}) {
  const profit = numberOrFallback(row.profit_usd_30d ?? row.profitUsd30d ?? row.profit_usd, 0);
  const roi = numberOrFallback(row.roi_pct_30d ?? row.roiPct30d ?? row.roi_pct, 0);
  const profitFactor = numberOrFallback(row.profit_factor_30d ?? row.profitFactor30d ?? row.profit_factor, 0);
  const maxDrawdown = Math.abs(numberOrFallback(
    row.max_drawdown_usd_30d ?? row.maxDrawdownUsd30d ?? row.max_drawdown_usd,
    0
  ));
  const medianEntry = numberOrFallback(
    row.median_entry_cents_30d ?? row.medianEntryCents30d ?? row.median_entry_cents,
    0
  );
  const avgEntry = numberOrFallback(
    row.avg_entry_price_cents_30d ?? row.avgEntryPriceCents30d ?? row.avg_entry_price_cents,
    0
  );
  const markets = numberOrFallback(
    row.distinct_resolved_markets_30d ??
      row.resolved_distinct_trade_count_30d ??
      row.distinctResolvedMarkets30d,
    0
  );
  const wins = numberOrFallback(row.win_count_30d ?? row.win_count_distinct_30d ?? row.winCount30d, 0);
  const trades = numberOrFallback(row.pnl_trade_count_30d ?? row.pnlTradeCount30d ?? row.pnl_trade_count, 0);
  const topWinShare = numberOrFallback(
    row.top_win_share_pct_30d ?? row.topWinSharePct30d ?? row.top_win_share_pct,
    100
  );
  const drawdownToProfitRatio = profit > 0 ? maxDrawdown / profit : Infinity;

  const hardReject =
    profit <= 0 ||
    profitFactor < 1.25 ||
    markets < 15 ||
    wins < 15 ||
    trades < 25 ||
    medianEntry > 90 ||
    topWinShare > 35 ||
    drawdownToProfitRatio > 0.8;

  if (hardReject) {
    const reason = buildRejectReason({
      profit,
      profitFactor,
      markets,
      wins,
      trades,
      medianEntry,
      topWinShare,
      drawdownToProfitRatio,
    });
    return {
      eligible: false,
      tier: tierForScore({ score: 0, eligible: false, medianEntry }),
      copyQualityScore: 0,
      conservativeCopyEdgePct: null,
      conservativeWinRatePct: null,
      drawdownToProfitRatio: Number.isFinite(drawdownToProfitRatio) ? drawdownToProfitRatio : null,
      reason,
      explanation: explanationForResult({
        eligible: false,
        reason,
        medianEntry,
        profitFactor,
        markets,
        conservativeCopyEdgePct: null,
      }),
      flags: buildRiskFlags({
        medianEntry,
        avgEntry,
        topWinShare,
        drawdownToProfitRatio,
        profitFactor,
        markets,
        trades,
        conservativeCopyEdgePct: null,
      }),
    };
  }

  const conservativeWinRate = wilsonLowerBound(wins, markets, 1.28);
  const entryPrice = Math.max(0.05, medianEntry / 100);
  const conservativeCopyEdgePct = ((conservativeWinRate / entryPrice) - 1) * 100;
  const conservativeCopyEdgeScore = clamp01((conservativeCopyEdgePct + 5) / 25);
  const entryCopyabilityScore = scoreMedianEntry(medianEntry);
  const sampleReliabilityScore = 0.65 * clamp01(markets / 80) + 0.35 * clamp01(trades / 150);
  const riskScore = clamp01(1 - ((drawdownToProfitRatio - 0.05) / 0.70));
  const profitFactorScore = clamp01(Math.log(Math.max(1, profitFactor)) / Math.log(5));
  const roiScore = clamp01(roi / 35);
  const profitQualityScore = 0.65 * profitFactorScore + 0.35 * roiScore;
  const profitScaleScore = clamp01(Math.log1p(profit) / Math.log1p(100_000));
  const concentrationScore = clamp01(1 - ((topWinShare - 8) / 27));
  const copyQualityScore = 100 * (
    0.30 * conservativeCopyEdgeScore +
    0.20 * entryCopyabilityScore +
    0.15 * sampleReliabilityScore +
    0.12 * riskScore +
    0.10 * profitQualityScore +
    0.08 * profitScaleScore +
    0.05 * concentrationScore
  );
  const tier = tierForScore({ score: copyQualityScore, eligible: true, medianEntry });
  const flags = buildRiskFlags({
    medianEntry,
    avgEntry,
    topWinShare,
    drawdownToProfitRatio,
    profitFactor,
    markets,
    trades,
    conservativeCopyEdgePct,
  });

  return {
    eligible: true,
    tier,
    copyQualityScore,
    conservativeCopyEdgePct,
    conservativeWinRatePct: conservativeWinRate * 100,
    drawdownToProfitRatio,
    conservativeCopyEdgeScore,
    entryCopyabilityScore,
    sampleReliabilityScore,
    riskScore,
    profitQualityScore,
    profitScaleScore,
    concentrationScore,
    reason: 'Eligible',
    explanation: explanationForResult({
      eligible: true,
      medianEntry,
      profitFactor,
      markets,
      conservativeCopyEdgePct,
      flags,
    }),
    flags,
  };
}

export function tierForScore({ score, eligible, medianEntry }) {
  const number = Number(score);
  if (eligible && number >= 80) return 'core';
  if (eligible && number >= 70) return 'candidate';
  if (number >= 60 && Number(medianEntry) <= 82) return 'watchlist';
  if (number >= 50) return 'manual_review';
  return 'ignore';
}

export function scoreMedianEntry(medianEntry) {
  const number = Number(medianEntry);
  if (!Number.isFinite(number) || number <= 0) return 0;
  if (number <= 65) return 1;
  if (number <= 75) return lerp(1, 0.8, (number - 65) / 10);
  if (number <= 82) return lerp(0.8, 0.45, (number - 75) / 7);
  if (number <= 90) return lerp(0.45, 0.10, (number - 82) / 8);
  return 0;
}

export function wilsonLowerBound(wins, n, z = 1.28) {
  const count = Number(n);
  const winCount = Number(wins);
  if (!Number.isFinite(count) || count <= 0 || !Number.isFinite(winCount)) return 0;
  const phat = clamp01(winCount / count);
  const z2 = z * z;
  const denominator = 1 + z2 / count;
  const center = phat + z2 / (2 * count);
  const margin = z * Math.sqrt((phat * (1 - phat) / count) + (z2 / (4 * count * count)));
  return clamp01((center - margin) / denominator);
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function lerp(a, b, t) {
  return a + (b - a) * clamp01(t);
}

function buildRejectReason(metrics) {
  const reasons = [];
  if (metrics.profit <= 0) reasons.push('negative_or_zero_profit');
  if (metrics.profitFactor < 1.25) reasons.push('profit_factor_below_1_25');
  if (metrics.markets < 15) reasons.push('too_few_resolved_markets');
  if (metrics.wins < 15) reasons.push('too_few_winning_markets');
  if (metrics.trades < 25) reasons.push('too_few_pnl_trades');
  if (metrics.medianEntry > 90) reasons.push('median_entry_above_90c');
  if (metrics.topWinShare > 35) reasons.push('top_win_share_above_35_pct');
  if (metrics.drawdownToProfitRatio > 0.8) reasons.push('drawdown_too_large_relative_to_profit');
  return reasons.join(', ');
}

function buildRiskFlags(metrics) {
  const flags = [];
  if (metrics.medianEntry > 82) flags.push('execution_sensitive_high_median_entry');
  if (metrics.avgEntry > 82) flags.push('high_average_entry');
  if (metrics.topWinShare > 25) flags.push('concentrated_profit');
  if (metrics.drawdownToProfitRatio > 0.5) flags.push('large_drawdown_relative_to_profit');
  if (metrics.profitFactor < 1.75) flags.push('thin_profit_factor');
  if (metrics.markets < 25) flags.push('small_market_sample');
  if (metrics.trades < 35) flags.push('small_trade_sample');
  if (Number.isFinite(metrics.conservativeCopyEdgePct) && metrics.conservativeCopyEdgePct < 0) {
    flags.push('negative_conservative_copy_edge');
  }
  return flags;
}

function explanationForResult({
  eligible,
  reason,
  medianEntry,
  profitFactor,
  markets,
  conservativeCopyEdgePct,
  flags = [],
}) {
  if (!eligible) {
    return `Rejected: ${reason || 'failed copy quality gate'}. High raw win rate is not enough when copy asymmetry is poor.`;
  }
  const parts = [
    `Copy edge ${formatPct(conservativeCopyEdgePct)}`,
    `median entry ${formatCents(medianEntry)}`,
    `profit factor ${formatNumber(profitFactor)}`,
    `${markets} resolved markets`,
  ];
  if (flags.length) parts.push(`${flags.length} risk flag${flags.length === 1 ? '' : 's'}`);
  return parts.join(', ') + '.';
}

function numberOrFallback(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatPct(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number >= 0 ? '+' : ''}${number.toFixed(1)}%` : 'n/a';
}

function formatCents(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(1)}c` : 'n/a';
}

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : 'n/a';
}
