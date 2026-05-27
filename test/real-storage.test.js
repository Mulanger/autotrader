import { describe, expect, it } from 'vitest';
import { createMemoryRealStorage } from '../server/real/storage.js';

const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function attempt(overrides = {}) {
  return {
    id: `real-order-${overrides.sourceTradeId || 'trade-1'}`,
    sourceTradeId: overrides.sourceTradeId || 'trade-1',
    traderWallet: wallet,
    asset: 'token-1',
    marketTitle: 'Market',
    outcome: 'YES',
    sourcePriceCents: 50,
    minGuardCents: 46,
    maxGuardCents: 54,
    stakeUsd: 10,
    status: 'would_fill',
    reason: 'Dry-run FOK BUY would fill',
    vwapCents: 51,
    estimatedShares: 19.607843,
    checkedAt: '2026-05-27T12:00:00.000Z',
    sourceTradeTimestamp: '2026-05-27T12:00:00.000Z',
    ...overrides,
  };
}

describe('real memory storage', () => {
  it('adds, removes, and re-adds follows without duplicate active rows', async () => {
    const storage = createMemoryRealStorage();

    const first = await storage.followTrader({ wallet, displayName: 'Trader' });
    const duplicate = await storage.followTrader({ wallet, displayName: 'Trader renamed' });
    const removed = await storage.unfollowTrader(wallet);
    const readded = await storage.followTrader({ wallet });
    const state = await storage.getState();

    expect(first.activated).toBe(true);
    expect(duplicate.activated).toBe(false);
    expect(removed.status).toBe('removed');
    expect(readded.activated).toBe(true);
    expect(state.follows.filter((follow) => follow.wallet === wallet)).toHaveLength(1);
    expect(state.follows[0].status).toBe('active');
  });

  it('records a would-fill order and creates a dry-run position once', async () => {
    const storage = createMemoryRealStorage();
    await storage.followTrader({ wallet });
    const afterFollow = new Date(Date.now() + 1_000).toISOString();
    const followAttempt = attempt({
      checkedAt: afterFollow,
      sourceTradeTimestamp: afterFollow,
    });

    const first = await storage.recordOrderAttempt(followAttempt);
    const duplicate = await storage.recordOrderAttempt(followAttempt);
    const state = await storage.getState();

    expect(first.inserted).toBe(true);
    expect(duplicate.inserted).toBe(false);
    expect(state.orders).toHaveLength(1);
    expect(state.positions).toHaveLength(1);
    expect(state.summary.wouldFillCount).toBe(1);
    expect(state.follows[0].metrics.attemptedCount).toBe(1);
  });
});
