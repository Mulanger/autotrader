import { describe, expect, it } from 'vitest';
import {
  buildPrimaryStrategies,
  calculateCopiedPnl,
  runWalkForwardBacktest,
  scoreWallets,
} from '../scripts/backtest-copy-gates.js';

function buy(index, overrides = {}) {
  return {
    id: `trade-${index}`,
    wallet: overrides.wallet || '0xaaa',
    condition_id: overrides.conditionId || `condition-${index}`,
    market_slug: overrides.marketSlug || `market-${index}`,
    event_slug: overrides.eventSlug || `event-${index}`,
    side: 'BUY',
    status: overrides.status || 'resolved_win',
    price: overrides.price ?? 0.5,
    usd_size: overrides.usdSize ?? 100,
    shares: overrides.shares ?? 200,
    pnl_usd: overrides.pnlUsd ?? 100,
    trade_timestamp: overrides.tradeTimestamp || '2026-01-01T00:00:00.000Z',
    resolved_at: overrides.resolvedAt || '2026-01-02T00:00:00.000Z',
  };
}

describe('copy-gate backtest helpers', () => {
  it('includes the requested hybrid gates in the primary comparison', () => {
    const strategies = buildPrimaryStrategies({
      AUTO_COPY_MIN_DISTINCT_MARKETS: '15',
      AUTO_COPY_MIN_WIN_RATE_PCT: '75',
      AUTO_COPY_MAX_AEP_CENTS: '75',
    });

    expect(strategies.map((strategy) => strategy.name)).toEqual([
      'old_gate',
      'hybrid_gate_v1',
      'hybrid_gate_v2',
      'hybrid_gate_v3',
      'edge_gate_loose',
      'edge_gate_strict',
    ]);
    expect(strategies.find((strategy) => strategy.name === 'hybrid_gate_v1')).toMatchObject({
      type: 'hybrid',
      minResolved: 15,
      minWinRatePct: 70,
      maxAvgEntryPriceCents: 75,
      minMeanEdge: 0,
      minUsdWeightedEdge: 0,
      edgeComparison: 'gt',
    });
  });

  it('uses resolved_at rather than trade_timestamp for training scores', () => {
    const asofMs = Date.parse('2026-02-01T00:00:00.000Z');
    const scores = scoreWallets(
      [
        buy(1, {
          tradeTimestamp: '2026-01-10T00:00:00.000Z',
          resolvedAt: '2026-02-02T00:00:00.000Z',
        }),
      ],
      asofMs,
      { trainDays: 30 }
    );

    expect(scores.get('0xaaa').nResolved).toBe(0);
  });

  it('calculates fixed-stake copied PnL from entry price', () => {
    expect(calculateCopiedPnl('resolved_win', 0.25, 10)).toBe(30);
    expect(calculateCopiedPnl('resolved_loss', 0.25, 10)).toBe(-10);
  });

  it('runs a walk-forward strategy and copies the first wallet-market trade once', () => {
    const trainingTrades = Array.from({ length: 15 }, (_, index) => {
      return buy(index, {
        tradeTimestamp: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
        resolvedAt: `2026-01-${String(index + 2).padStart(2, '0')}T00:00:00.000Z`,
        price: 0.5,
        usdSize: 50,
        shares: 100,
      });
    });
    const rows = [
      ...trainingTrades,
      buy(100, {
        conditionId: 'same-future-market',
        tradeTimestamp: '2026-01-18T00:00:00.000Z',
        resolvedAt: '2026-01-25T00:00:00.000Z',
        price: 0.5,
      }),
      buy(101, {
        conditionId: 'same-future-market',
        tradeTimestamp: '2026-01-19T00:00:00.000Z',
        resolvedAt: '2026-01-25T00:00:00.000Z',
        price: 0.45,
      }),
      buy(102, {
        conditionId: 'new-future-market',
        tradeTimestamp: '2026-01-20T00:00:00.000Z',
        resolvedAt: '2026-01-26T00:00:00.000Z',
        price: 0.5,
      }),
      buy(200, {
        wallet: '0xbbbb',
        tradeTimestamp: '2026-01-30T00:00:00.000Z',
        resolvedAt: '2026-02-01T00:00:00.000Z',
        price: 0.5,
      }),
    ];

    const result = runWalkForwardBacktest(
      rows,
      [
        {
          name: 'old_gate',
          type: 'old',
          minResolved: 15,
          minWinRatePct: 75,
          maxAvgEntryPriceCents: 75,
        },
      ],
      {
        trainDays: 15,
        testDays: 7,
        stepDays: 1,
        stakeUsd: 10,
        maxCopyPriceCents: 75,
      }
    );

    expect(result.copies.map((copy) => copy.tradeId)).toEqual(['trade-100', 'trade-102']);
    expect(result.strategySummaries[0].copiedTradeCount).toBe(2);
  });
});
