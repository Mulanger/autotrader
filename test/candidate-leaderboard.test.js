import { describe, expect, it } from 'vitest';
import { buildLeaderboardRows } from '../server/candidate-tracker/leaderboard.js';

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
    expect(rows[1].allTimeProfitUsd).toBe(-5);
  });
});
