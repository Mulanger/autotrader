import { describe, expect, it } from 'vitest';
import { DEMO_STAKE_USD, DEMO_STARTING_CAPITAL_USD } from '../server/config.js';
import { createAppState, ingestTrade, restoreDurableState, serializeDurableState } from '../server/app-state.js';
import { applyCopyPoolSnapshot } from '../server/copy-pool.js';
import { applyShadowTraderSnapshot } from '../server/shadow-trader.js';

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
    expect(state.demo.cashUsd).toBe(DEMO_STARTING_CAPITAL_USD);
  });

  it('restores serialized state including seen trade IDs', () => {
    const state = createAppState();
    const wallet = state.watchedWallets[0];
    ingestTrade(state, trade(wallet, { id: 'restore-trade' }), 'websocket');

    const payload = serializeDurableState(state);
    const restored = createAppState();
    restoreDurableState(restored, payload);

    expect(restored.demo.cashUsd).toBe(DEMO_STARTING_CAPITAL_USD - DEMO_STAKE_USD);
    expect(restored.demo.openPositions).toHaveLength(1);
    expect(restored.seenTradeIds.has('restore-trade')).toBe(true);
    expect(restored.demo.copiedMarketKeys.size).toBe(1);
    expect(restored.demo.copiedMarketKeys.has('test-market')).toBe(true);
    expect(restored.demo.copiedTraderMarketKeys.size).toBe(1);
  });

  it('tops up an older persisted demo account to the configured starting capital', () => {
    const restored = createAppState();

    restoreDurableState(restored, {
      demo: {
        startingCapitalUsd: 100,
        cashUsd: 70,
        openPositions: [],
        closedPositions: [],
        decisions: [],
        copiedSourceTradeIds: [],
      },
      traders: {},
      allTrades: [],
      copiedFeed: [],
      seenTradeIds: [],
    });

    expect(restored.demo.startingCapitalUsd).toBe(DEMO_STARTING_CAPITAL_USD);
    expect(restored.demo.cashUsd).toBe(DEMO_STARTING_CAPITAL_USD - 30);
    expect(restored.demo.decisions[0].action).toBe('capital_adjusted');
  });

  it('copies future trades from an active auto-added wallet', () => {
    const state = createAppState();
    const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    applyCopyPoolSnapshot(state, {
      wallets: {
        [wallet]: {
          wallet,
          source: 'auto',
          status: 'active',
          protected: false,
          displayName: 'Auto Trader',
        },
      },
    });

    const event = ingestTrade(state, trade(wallet, { id: 'auto-copy', marketSlug: 'auto-market' }), 'candidate-live');

    expect(state.watchedWallets).toContain(wallet);
    expect(event.copyDecision.action).toBe('copied');
    expect(state.demo.openPositions).toHaveLength(1);
  });

  it('copies selected hybrid v1 shadow trades without adding them to the active demo copy list', () => {
    const state = createAppState();
    const wallet = '0xdddddddddddddddddddddddddddddddddddddddd';
    applyShadowTraderSnapshot(state, {
      selectedWallets: {
        [wallet]: {
          wallet,
          status: 'active',
          distinctResolvedTradeCount: 18,
          winRatePct: 72,
          avgEntryPriceCents30d: 50,
          meanEdge: 0.02,
          usdWeightedEdge: 0.01,
        },
      },
    });

    const event = ingestTrade(state, trade(wallet, { id: 'shadow-copy', marketSlug: 'shadow-market' }), 'candidate-live');

    expect(state.watchedWallets).not.toContain(wallet);
    expect(event.copyDecision.action).toBe('ignored');
    expect(event.shadowDecision.action).toBe('copied');
    expect(state.demo.openPositions).toHaveLength(0);
    expect(state.shadowTrader.portfolio.openPositions).toHaveLength(1);
    expect(state.shadowTrader.portfolio.openPositions[0].id).toBe('shadow-v1-shadow-copy');
    expect(state.shadowTrader.feed).toHaveLength(1);
  });

  it('stops copying removed auto wallets without closing existing positions', () => {
    const state = createAppState();
    const wallet = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    applyCopyPoolSnapshot(state, {
      wallets: {
        [wallet]: { wallet, source: 'auto', status: 'active', protected: false },
      },
    });
    ingestTrade(state, trade(wallet, { id: 'auto-first', marketSlug: 'first-market' }), 'candidate-live');

    applyCopyPoolSnapshot(state, {
      wallets: {
        [wallet]: { wallet, source: 'auto', status: 'removed', protected: false, reason: 'Win rate below threshold' },
      },
    });
    const event = ingestTrade(state, trade(wallet, { id: 'auto-second', marketSlug: 'second-market' }), 'candidate-live');

    expect(state.watchedWallets).not.toContain(wallet);
    expect(event.copyDecision.action).toBe('ignored');
    expect(state.demo.openPositions).toHaveLength(1);
    expect(state.demo.openPositions[0].sourceTradeId).toBe('auto-first');
  });

  it('keeps protected baseline wallets active even if a snapshot marks them removed', () => {
    const state = createAppState();
    const wallet = state.watchedWallets[0];

    applyCopyPoolSnapshot(state, {
      wallets: {
        [wallet]: { wallet, source: 'auto', status: 'removed', protected: false, reason: 'Should not remove baseline' },
      },
    });

    const event = ingestTrade(state, trade(wallet, { id: 'baseline-protected' }), 'websocket');

    expect(state.copyPool.wallets[wallet].protected).toBe(true);
    expect(state.copyPool.wallets[wallet].status).toBe('active');
    expect(event.copyDecision.action).toBe('copied');
  });

  it('rebuilds trader-market dedupe keys from older stored positions', () => {
    const state = createAppState();
    const wallet = state.watchedWallets[0];
    const restored = createAppState();

    restoreDurableState(restored, {
      demo: {
        cashUsd: 90,
        openPositions: [{
          id: 'demo-old',
          sourceTradeId: 'old',
          traderWallet: wallet,
          marketSlug: 'old-market',
          status: 'open',
          shares: 20,
          stakeUsd: 10,
          entryPriceCents: 50,
          currentPriceCents: 50,
        }],
        closedPositions: [],
        decisions: [],
        copiedSourceTradeIds: ['old'],
      },
      traders: state.traders,
      allTrades: [],
      copiedFeed: [],
      seenTradeIds: ['old'],
    });

    const event = ingestTrade(restored, trade(wallet, { id: 'repeat', marketSlug: 'old-market' }), 'websocket');

    expect(event.copyDecision.action).toBe('skipped');
    expect(event.copyDecision.reason).toMatch(/already copied/i);
    expect(restored.demo.openPositions).toHaveLength(1);
  });

  it('rebuilds copied market keys from older stored positions', () => {
    const state = createAppState();
    const wallet = state.watchedWallets[0];
    const otherWallet = '0xcccccccccccccccccccccccccccccccccccccccc';
    const restored = createAppState();

    restoreDurableState(restored, {
      demo: {
        cashUsd: 90,
        openPositions: [{
          id: 'demo-old',
          sourceTradeId: 'old',
          traderWallet: wallet,
          marketSlug: 'old-market',
          status: 'open',
          shares: 20,
          stakeUsd: 10,
          entryPriceCents: 50,
          currentPriceCents: 50,
        }],
        closedPositions: [],
        decisions: [],
        copiedSourceTradeIds: ['old'],
      },
      traders: state.traders,
      allTrades: [],
      copiedFeed: [],
      seenTradeIds: ['old'],
    });
    applyCopyPoolSnapshot(restored, {
      wallets: {
        [otherWallet]: { wallet: otherWallet, source: 'auto', status: 'active', protected: false },
      },
    });

    const event = ingestTrade(restored, trade(otherWallet, { id: 'other-wallet-repeat', marketSlug: 'old-market' }), 'candidate-live');

    expect(restored.demo.copiedMarketKeys.has('old-market')).toBe(true);
    expect(event.copyDecision.action).toBe('skipped');
    expect(event.copyDecision.reason).toMatch(/market already copied/i);
    expect(restored.demo.openPositions).toHaveLength(1);
  });

  it('prunes duplicate trader-market positions from restored durable state', () => {
    const state = createAppState();
    const wallet = state.watchedWallets[0];
    const restored = createAppState();

    restoreDurableState(restored, {
      demo: {
        cashUsd: 70,
        realizedPnlUsd: -20,
        copiedCount: 3,
        totalNotionalCopiedUsd: 30,
        openPositions: [
          {
            id: 'demo-open-duplicate',
            sourceTradeId: 'open-duplicate',
            traderWallet: wallet,
            marketSlug: 'duplicate-market',
            status: 'open',
            openedAt: '2026-05-19T11:00:00.000Z',
            shares: 14.7,
            stakeUsd: 10,
            entryPriceCents: 68,
            currentPriceCents: 68,
          },
        ],
        closedPositions: [
          {
            id: 'demo-first',
            sourceTradeId: 'first',
            traderWallet: wallet,
            marketSlug: 'duplicate-market',
            status: 'loss',
            openedAt: '2026-05-19T10:00:00.000Z',
            closedAt: '2026-05-19T12:00:00.000Z',
            shares: 14.7,
            stakeUsd: 10,
            entryPriceCents: 68,
            currentPriceCents: 68,
            exitValueUsd: 0,
            realizedPnlUsd: -10,
          },
          {
            id: 'demo-closed-duplicate',
            sourceTradeId: 'closed-duplicate',
            traderWallet: wallet,
            marketSlug: 'duplicate-market',
            status: 'loss',
            openedAt: '2026-05-19T10:30:00.000Z',
            closedAt: '2026-05-19T12:00:00.000Z',
            shares: 14.7,
            stakeUsd: 10,
            entryPriceCents: 68,
            currentPriceCents: 68,
            exitValueUsd: 0,
            realizedPnlUsd: -10,
          },
        ],
        decisions: [
          { id: 'first-copied', tradeId: 'first', action: 'copied', copyId: 'demo-first' },
          { id: 'open-copied', tradeId: 'open-duplicate', action: 'copied', copyId: 'demo-open-duplicate' },
          { id: 'closed-copied', tradeId: 'closed-duplicate', action: 'copied', copyId: 'demo-closed-duplicate' },
        ],
        copiedSourceTradeIds: ['first', 'open-duplicate', 'closed-duplicate'],
      },
      traders: state.traders,
      allTrades: [],
      copiedFeed: [],
      seenTradeIds: ['first', 'open-duplicate', 'closed-duplicate'],
    });

    expect(restored.demo.closedPositions.map((position) => position.id)).toEqual(['demo-first']);
    expect(restored.demo.openPositions).toHaveLength(0);
    expect(restored.demo.cashUsd).toBe(90);
    expect(restored.demo.realizedPnlUsd).toBe(-10);
    expect(restored.demo.copiedCount).toBe(1);
    expect(restored.demo.totalNotionalCopiedUsd).toBe(10);
    expect(restored.demo.decisions[0].action).toBe('repaired');
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

  it('reopens ambiguous binary winner settlements for team markets', () => {
    const state = createAppState();
    const restored = createAppState();
    const payload = {
      demo: {
        cashUsd: 80,
        realizedPnlUsd: -10,
        openPositions: [],
        closedPositions: [
          {
            id: 'demo-dallas',
            sourceTradeId: 'dallas',
            status: 'loss',
            settlementSource: 'polywhale-resolution',
            resolutionStatus: 'resolved_loss',
            winningOutcome: 'YES',
            stakeUsd: 10,
            shares: 17.24137931034483,
            outcome: 'Dallas Wings',
            marketSlug: 'wnba-dal-chi-2026-05-20',
            entryPriceCents: 58,
            currentPriceCents: 58,
            exitValueUsd: 0,
            realizedPnlUsd: -10,
          },
        ],
        decisions: [{ id: 'dallas-settled', tradeId: 'dallas', action: 'settled', copyId: 'demo-dallas' }],
        copiedSourceTradeIds: ['dallas'],
      },
      traders: state.traders,
      allTrades: [],
      copiedFeed: [],
      seenTradeIds: ['dallas'],
    };

    restoreDurableState(restored, payload);

    expect(restored.demo.openPositions).toHaveLength(1);
    expect(restored.demo.closedPositions).toHaveLength(0);
    expect(restored.demo.openPositions[0].resolutionRepairNote).toMatch(/cross-check/i);
    expect(restored.demo.realizedPnlUsd).toBeCloseTo(0, 5);
    expect(restored.demo.decisions[0].action).toBe('reopened');
  });
});
