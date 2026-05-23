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
        { wallet: '0xaaa', side: 'BUY', status: 'resolved_win', pnlUsd: 20, resolvedAt: '2026-05-22T01:00:00.000Z' },
        { wallet: '0xaaa', side: 'SELL', status: 'resolved_win', pnlUsd: null, resolvedAt: '2026-05-22T02:00:00.000Z' },
        { wallet: '0xbbb', side: 'BUY', status: 'resolved_loss', pnlUsd: -5, resolvedAt: '2026-05-22T03:00:00.000Z' },
      ]
    );

    expect(rows[0].wallet).toBe('0xaaa');
    expect(rows[0].allTimeProfitUsd).toBe(20);
    expect(rows[0].allTimePnlTradeCount).toBe(1);
    expect(rows[0].allTimeWinRatePct).toBe(100);
    expect(rows[0].recentFormResults).toEqual(['resolved_win']);
    expect(rows[1].allTimeProfitUsd).toBe(-5);
  });
});
