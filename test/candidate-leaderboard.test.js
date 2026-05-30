import { describe, expect, it } from 'vitest';
import {
  buildCandidateMetrics,
  buildCandidateMonthlyPerformance,
  buildLeaderboardRows,
} from '../server/candidate-tracker/leaderboard.js';

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
    expect(rows[0].monthlyPerformance).toHaveLength(3);
    expect(rows[0].monthlyPerformance[0].label).toBe('Last 30D');
    expect(rows[1].allTimeProfitUsd).toBe(-5);
  });

  it('splits candidate month cards into independent 30-day windows', () => {
    const windows = buildCandidateMonthlyPerformance([
      trade('latest-win', {
        status: 'resolved_win',
        pnlUsd: 20,
        usdSize: 50,
        shares: 100,
        tradeTimestamp: '2026-05-20T00:00:00.000Z',
        resolvedAt: '2026-05-21T00:00:00.000Z',
      }),
      trade('middle-loss', {
        status: 'resolved_loss',
        pnlUsd: -25,
        usdSize: 100,
        shares: 200,
        tradeTimestamp: '2026-04-10T00:00:00.000Z',
        resolvedAt: '2026-04-11T00:00:00.000Z',
      }),
      trade('old-win', {
        status: 'resolved_win',
        pnlUsd: 60,
        usdSize: 120,
        shares: 200,
        tradeTimestamp: '2026-03-01T00:00:00.000Z',
        resolvedAt: '2026-03-02T00:00:00.000Z',
      }),
    ], { now: '2026-05-23T00:00:00.000Z' });

    expect(windows.map((window) => window.label)).toEqual(['Last 30D', '30-60D', '60-90D']);
    expect(windows[0].profitUsd).toBe(20);
    expect(windows[0].winRatePct).toBe(100);
    expect(windows[1].profitUsd).toBe(-25);
    expect(windows[1].winRatePct).toBe(0);
    expect(windows[2].avgEntryPriceCents).toBe(60);
    expect(windows[2].roiPct).toBe(50);
  });

  it('keeps the 10 newest resolved BUY results for recent form', () => {
    const statuses = Array.from({ length: 12 }, (_, index) => (
      index % 2 === 0 ? 'resolved_win' : 'resolved_loss'
    ));
    const rows = buildLeaderboardRows(
      [{ wallet: '0xaaa', displayName: 'Alpha' }],
      statuses.map((status, index) => trade(`form-${index}`, {
        status,
        resolvedAt: `2026-05-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
        tradeTimestamp: `2026-05-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
      }))
    );

    expect(rows[0].recentFormResults).toEqual(statuses.slice().reverse().slice(0, 10));
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
