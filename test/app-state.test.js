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

  it('reopens premature resolution settlements saved with open status', () => {
    const state = createAppState();
    const restored = createAppState();
    const payload = {
      demo: {
        cashUsd: 100.63829787234043,
        realizedPnlUsd: 0.6382978723404253,
        openPositions: [],
        closedPositions: [
          {
            id: 'demo-bad',
            sourceTradeId: 'bad',
            status: 'win',
            settlementSource: 'polywhale-resolution',
            resolutionStatus: 'open',
            stakeUsd: 10,
            shares: 10.638297872340425,
            entryPriceCents: 94,
            currentPriceCents: 94,
            exitValueUsd: 10.638297872340425,
            realizedPnlUsd: 0.6382978723404253,
          },
        ],
        decisions: [{ id: 'bad-settled', tradeId: 'bad', action: 'settled', copyId: 'demo-bad' }],
        copiedSourceTradeIds: ['bad'],
      },
      traders: state.traders,
      allTrades: [],
      copiedFeed: [],
      seenTradeIds: ['bad'],
    };

    restoreDurableState(restored, payload);

    expect(restored.demo.openPositions).toHaveLength(1);
    expect(restored.demo.closedPositions).toHaveLength(0);
    expect(restored.demo.cashUsd).toBeCloseTo(90, 5);
    expect(restored.demo.realizedPnlUsd).toBeCloseTo(0, 5);
    expect(restored.demo.decisions[0].action).toBe('reopened');
  });
});
