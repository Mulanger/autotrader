import { describe, expect, it } from 'vitest';
import { scoreCopyTrader, scoreMedianEntry, wilsonLowerBound } from '../server/copy-quality-score.js';

function baseRow(overrides = {}) {
  return {
    profitUsd30d: 10_000,
    roiPct30d: 22,
    profitFactor30d: 2.6,
    maxDrawdownUsd30d: -1_500,
    medianEntryCents30d: 62,
    avgEntryPriceCents30d: 64,
    distinctResolvedMarkets30d: 60,
    winCount30d: 48,
    pnlTradeCount30d: 90,
    topWinSharePct30d: 16,
    ...overrides,
  };
}

describe('copy quality scoring', () => {
  it('calculates a Wilson lower bound below the raw win rate', () => {
    const lower = wilsonLowerBound(48, 60, 1.28);
    expect(lower).toBeGreaterThan(0.70);
    expect(lower).toBeLessThan(0.80);
  });

  it('scores median entry copyability with high entries penalized', () => {
    expect(scoreMedianEntry(60)).toBe(1);
    expect(scoreMedianEntry(75)).toBeCloseTo(0.8, 4);
    expect(scoreMedianEntry(82)).toBeCloseTo(0.45, 4);
    expect(scoreMedianEntry(95)).toBe(0);
  });

  it('rejects high win-rate wallets with 95c median entries', () => {
    const score = scoreCopyTrader(baseRow({
      medianEntryCents30d: 95,
      avgEntryPriceCents30d: 95,
      winCount30d: 94,
      distinctResolvedMarkets30d: 100,
      pnlTradeCount30d: 120,
      profitFactor30d: 3.2,
    }));

    expect(score.eligible).toBe(false);
    expect(score.copyQualityScore).toBe(0);
    expect(score.reason).toContain('median_entry_above_90c');
  });

  it('promotes low-entry wallets with solid win rate and sample quality', () => {
    const score = scoreCopyTrader(baseRow({
      medianEntryCents30d: 60,
      avgEntryPriceCents30d: 61,
      winCount30d: 80,
      distinctResolvedMarkets30d: 100,
      pnlTradeCount30d: 140,
      profitUsd30d: 25_000,
      profitFactor30d: 4.1,
      topWinSharePct30d: 12,
    }));

    expect(score.eligible).toBe(true);
    expect(score.copyQualityScore).toBeGreaterThanOrEqual(70);
    expect(['candidate', 'core']).toContain(score.tier);
    expect(score.conservativeCopyEdgePct).toBeGreaterThan(10);
  });

  it('uses copyable edge and real fill rate for expected copy profit', () => {
    const score = scoreCopyTrader(baseRow({
      copyableProfitUsd30d: 8_000,
      copyableRoiPct30d: 18,
      copyableProfitFactor30d: 3.1,
      copyableMaxDrawdownUsd30d: -900,
      copyableMedianEntryCents30d: 50,
      copyableAvgEntryPriceCents30d: 51,
      copyableResolvedMarkets30d: 40,
      copyableWinCount30d: 32,
      copyablePnlTradeCount30d: 45,
      copyableTopWinSharePct30d: 10,
      copyableEdgeLowerBoundPct30d: 12,
      realAttemptCount30d: 20,
      realFillCount30d: 10,
      realFillRatePct30d: 50,
      realAvgSlippageCents30d: 1,
      copyStakeUsd: 10,
    }));

    expect(score.eligible).toBe(true);
    expect(score.edgeAfterSlippagePct).toBeCloseTo(10, 4);
    expect(score.expectedCopyProfitUsd).toBeCloseTo(0.5, 4);
    expect(score.fillFactor).toBeCloseTo(0.5, 4);
  });

  it('keeps missing fill-rate samples neutral instead of treating null as zero', () => {
    const score = scoreCopyTrader(baseRow({
      realAttemptCount30d: 0,
      realFillRatePct30d: null,
    }));

    expect(score.realFillRatePct30d).toBeNull();
    expect(score.fillFactor).toBeCloseTo(0.7, 4);
  });

  it('rejects copyable subsets with negative expected copy edge', () => {
    const score = scoreCopyTrader(baseRow({
      copyableEdgeLowerBoundPct30d: -2,
      copyableResolvedMarkets30d: 60,
      copyableWinCount30d: 48,
      copyablePnlTradeCount30d: 90,
    }));

    expect(score.eligible).toBe(false);
    expect(score.reason).toContain('negative_expected_copy_edge');
  });

  it('hard rejects top-win concentration above the gate', () => {
    const score = scoreCopyTrader(baseRow({ topWinSharePct30d: 42 }));
    expect(score.eligible).toBe(false);
    expect(score.reason).toContain('top_win_share_above_35_pct');
  });

  it('hard rejects weak profit factor', () => {
    const score = scoreCopyTrader(baseRow({ profitFactor30d: 1.05 }));
    expect(score.eligible).toBe(false);
    expect(score.reason).toContain('profit_factor_below_1_25');
  });
});
