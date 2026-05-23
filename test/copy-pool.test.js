import { describe, expect, it } from 'vitest';
import { buildCopyPoolMetrics } from '../server/copy-pool.js';

const NOW = '2026-05-23T00:00:00.000Z';

function trade(index, overrides = {}) {
  const price = overrides.price ?? 0.5;
  const shares = overrides.shares ?? 2_000;
  return {
    id: `trade-${index}`,
    wallet: '0xaaa',
    side: 'BUY',
    status: overrides.status || 'resolved_win',
    conditionId: overrides.conditionId || `condition-${index}`,
    marketSlug: overrides.marketSlug || `market-${index}`,
    shares,
    usdSize: overrides.usdSize ?? price * shares,
    tradeTimestamp: overrides.tradeTimestamp || '2026-05-22T00:00:00.000Z',
    resolvedAt: overrides.resolvedAt || '2026-05-22T12:00:00.000Z',
  };
}

function metrics(trades, thresholdOverrides = {}) {
  return buildCopyPoolMetrics(trades, {
    now: NOW,
    thresholds: {
      windowDays: 30,
      minDistinctResolvedMarkets: 15,
      minWinRatePct: 75,
      maxAvgEntryPriceCents: 75,
      ...thresholdOverrides,
    },
  });
}

describe('copy pool eligibility', () => {
  it('passes with at least 15 resolved distinct BUY markets and fails with 14', () => {
    const fifteen = Array.from({ length: 15 }, (_, index) => trade(index, { price: 0.5 }));
    const fourteen = fifteen.slice(0, 14);

    expect(metrics(fifteen).eligible).toBe(true);
    expect(metrics(fourteen).eligible).toBe(false);
    expect(metrics(fourteen).reason).toMatch(/Needs 15/i);
  });

  it('counts repeated entries on one market once', () => {
    const repeated = [
      trade(1, { conditionId: 'same-market', price: 0.5 }),
      trade(2, { conditionId: 'same-market', price: 0.45 }),
      ...Array.from({ length: 13 }, (_, index) => trade(index + 3, { price: 0.5 })),
    ];

    const result = metrics(repeated);

    expect(result.distinctResolvedTradeCount).toBe(14);
    expect(result.eligible).toBe(false);
  });

  it('passes at exactly 75% win rate and fails below it', () => {
    const exactly = Array.from({ length: 16 }, (_, index) => {
      return trade(index, { status: index < 12 ? 'resolved_win' : 'resolved_loss', price: 0.5 });
    });
    const below = exactly.map((item, index) => index === 11 ? { ...item, status: 'resolved_loss' } : item);

    expect(metrics(exactly).winRatePct).toBe(75);
    expect(metrics(exactly).eligible).toBe(true);
    expect(metrics(below).winRatePct).toBeCloseTo(68.75, 5);
    expect(metrics(below).eligible).toBe(false);
  });

  it('requires trailing 30-day AEP below 75c', () => {
    const below = Array.from({ length: 15 }, (_, index) => trade(index, { price: 0.749 }));
    const atLimit = Array.from({ length: 15 }, (_, index) => trade(index, { price: 0.75 }));

    expect(metrics(below).avgEntryPriceCents30d).toBeCloseTo(74.9, 5);
    expect(metrics(below).eligible).toBe(true);
    expect(metrics(atLimit).avgEntryPriceCents30d).toBe(75);
    expect(metrics(atLimit).eligible).toBe(false);
  });
});
