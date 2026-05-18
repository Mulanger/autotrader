import { describe, expect, it } from 'vitest';
import { createAppState, ingestTrade, restoreDurableState, serializeDurableState } from '../server/app-state.js';

function trade(wallet, overrides = {}) {
  return {
    id: overrides.id || 'trade-1',
    side: overrides.side || 'BUY',
    outcome: overrides.outcome || 'YES',
    usdSize: overrides.usdSize ?? 1000,
    shares: overrides.shares ?? 1000,
    priceCents: overrides.priceCents ?? 50,
    timestamp: overrides.timestamp ?? 1_779_120_000,
    market: {
      slug: overrides.marketSlug || 'test-market',
      title: 'Test market',
      icon: null,
      yesPriceCents: overrides.priceCents ?? 50,
      noPriceCents: 50,
    },
    trader: {
      proxyWallet: wallet,
      displayName: 'Trader',
    },
    resolution: { status: 'open', pnlUsd: null },
  };
}

describe('app state', () => {
  it('keeps unrelated whales out of the copy feed', () => {
    const state = createAppState();
    ingestTrade(state, trade('0x0000000000000000000000000000000000000001'), 'websocket');

    expect(state.allTrades).toHaveLength(1);
    expect(state.copiedFeed).toHaveLength(0);
    expect(state.demo.copiedCount).toBe(0);
  });

  it('observes watched bootstrap trades without copying them', () => {
    const state = createAppState();
    const wallet = state.watchedWallets[0];
    ingestTrade(state, trade(wallet), 'bootstrap', { copyEligible: false });

    expect(state.copiedFeed).toHaveLength(1);
    expect(state.copiedFeed[0].copyDecision.action).toBe('observed');
    expect(state.demo.openPositions).toHaveLength(0);
    expect(state.demo.cashUsd).toBe(100);
  });

  it('restores serialized state including seen trade IDs', () => {
    const state = createAppState();
    const wallet = state.watchedWallets[0];
    ingestTrade(state, trade(wallet, { id: 'restore-trade' }), 'websocket');

    const payload = serializeDurableState(state);
    const restored = createAppState();
    restoreDurableState(restored, payload);

    expect(restored.demo.cashUsd).toBe(90);
    expect(restored.demo.openPositions).toHaveLength(1);
    expect(restored.seenTradeIds.has('restore-trade')).toBe(true);
  });
});
