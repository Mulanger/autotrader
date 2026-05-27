import { describe, expect, it } from 'vitest';
import { buildCandidateMetrics, buildLeaderboardRows } from '../server/candidate-tracker/leaderboard.js';

describe('candidate leaderboard aggregation', () => {
  it('ranks realized BUY profit and excludes SELL pnl-null rows from P/L and form', () => {
    const rows = buildLeaderboardRows(
      [
        { wallet: '0xaaa', displayName: 'Alpha', lastSeenAt: '2026-05-22T00:00:00.000Z' },
        { wallet: '0xbbb', displayName: 'Beta', lastSeenAt: '2026-05-23T00:00:00.000Z' },
      ],
      [
        {
          wallet: '0xaaa',
          side: 'BUY',
          status: 'resolved_win',
          pnlUsd: 20,
          price: 0.42,
          usdSize: 42,
          shares: 100,
          resolvedAt: new Date().toISOString(),
          tradeTimestamp: new Date().toISOString(),
        },
        {
          wallet: '0xaaa',
          side: 'SELL',
          status: 'resolved_win',
          pnlUsd: null,
          price: 0.9,
          usdSize: 90,
          shares: 100,
          resolvedAt: new Date().toISOString(),
          tradeTimestamp: new Date().toISOString(),
        },
        {
          wallet: '0xaaa',
          side: 'BUY',
          status: 'open',
          pnlUsd: null,
          price: 0.48,
          usdSize: 48,
          shares: 100,
          tradeTimestamp: new Date().toISOString(),
        },
        {
          wallet: '0xbbb',
          side: 'BUY',
          status: 'resolved_loss',
          pnlUsd: -5,
          price: 0.6,
          usdSize: 60,
          shares: 100,
          resolvedAt: new Date().toISOString(),
          tradeTimestamp: new Date().toISOString(),
        },
      ]
    );

    expect(rows[0].wallet).toBe('0xaaa');
    expect(rows[0].allTimeProfitUsd).toBe(20);
    expect(rows[0].allTimePnlTradeCount).toBe(1);
    expect(rows[0].allTimeWinRatePct).toBe(100);
    expect(rows[0].avgEntryPriceCents30d).toBe(45);
    expect(rows[0].avgEntryTradeCount30d).toBe(2);
    expect(rows[0].resolvedDistinctTradeCount30d).toBe(1);
    expect(rows[0].winRatePctDistinct30d).toBe(100);
    expect(rows[0].recentFormResults).toEqual(['resolved_win']);
    expect(rows[0].metrics.roiPct).toBeCloseTo(47.62, 2);
    expect(rows[0].metrics.profitFactorDisplayCapHit).toBe(true);
    expect(rows[0].metrics.medianEntryCents).toBe(45);
    expect(rows[1].allTimeProfitUsd).toBe(-5);
  });

  it('calculates candidate metrics for normal wins/losses and drawdown path order', () => {
    const metrics = buildCandidateMetrics([
      trade('loss-newer', { status: 'resolved_loss', pnlUsd: -10, usdSize: 50, price: 0.5, resolvedAt: '2026-05-20T00:00:00.000Z' }),
      trade('win-oldest', { status: 'resolved_win', pnlUsd: 30, usdSize: 60, price: 0.6, resolvedAt: '2026-05-18T00:00:00.000Z' }),
      trade('loss-middle', { status: 'resolved_loss', pnlUsd: -20, usdSize: 40, price: 0.4, resolvedAt: '2026-05-19T00:00:00.000Z' }),
      trade('open', { status: 'open', pnlUsd: null, usdSize: 30, price: 0.3, resolvedAt: null }),
    ], { now: '2026-05-23T00:00:00.000Z' });

    expect(metrics.roiPct).toBe(0);
    expect(metrics.profitFactor).toBe(1);
    expect(metrics.maxDrawdownUsd).toBe(-30);
    expect(metrics.medianEntryCents).toBe(45);
    expect(metrics.avgTradeSizeUsd).toBe(45);
    expect(metrics.avgWinUsd).toBe(30);
    expect(metrics.avgLossUsd).toBe(-15);
    expect(metrics.recent7dTradeCount).toBe(3);
    expect(metrics.recent7dWinRatePct).toBeCloseTo(33.333, 3);
    expect(metrics.topWinSharePct).toBe(100);
  });

  it('handles no losses, no wins, zero deployed capital, and sparse recent data', () => {
    const noLosses = buildCandidateMetrics([
      trade('win-1', { status: 'resolved_win', pnlUsd: 10, usdSize: 0, price: 0.2, resolvedAt: '2026-05-01T00:00:00.000Z' }),
    ], { now: '2026-05-23T00:00:00.000Z' });
    const noWins = buildCandidateMetrics([
      trade('loss-1', { status: 'resolved_loss', pnlUsd: -10, usdSize: 50, price: 0.5, resolvedAt: '2026-05-01T00:00:00.000Z' }),
    ], { now: '2026-05-23T00:00:00.000Z' });

    expect(noLosses.roiPct).toBeNull();
    expect(noLosses.profitFactor).toBeNull();
    expect(noLosses.profitFactorDisplayCapHit).toBe(true);
    expect(noLosses.recent7dTradeCount).toBe(0);
    expect(noLosses.recent7dWinRatePct).toBeNull();

    expect(noWins.profitFactor).toBeNull();
    expect(noWins.profitFactorDisplayCapHit).toBe(false);
    expect(noWins.avgWinUsd).toBeNull();
    expect(noWins.topWinSharePct).toBeNull();
  });

  it('calculates even-count medians and top-win share', () => {
    const metrics = buildCandidateMetrics([
      trade('win-1', { status: 'resolved_win', pnlUsd: 10, usdSize: 20, price: 0.2 }),
      trade('win-2', { status: 'resolved_win', pnlUsd: 30, usdSize: 80, price: 0.8 }),
    ], { now: '2026-05-23T00:00:00.000Z' });

    expect(metrics.medianEntryCents).toBe(50);
    expect(metrics.topWinSharePct).toBe(75);
  });
});

function trade(id, overrides = {}) {
  return {
    id,
    wallet: '0xaaa',
    side: 'BUY',
    status: 'resolved_win',
    pnlUsd: 10,
    price: 0.5,
    usdSize: 50,
    shares: 100,
    resolvedAt: '2026-05-22T00:00:00.000Z',
    tradeTimestamp: '2026-05-21T00:00:00.000Z',
    ...overrides,
  };
}
