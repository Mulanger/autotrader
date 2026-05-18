import { describe, expect, it } from 'vitest';
import { createDemoState, evaluateDemoCopy } from '../server/demo-engine.js';
import { buildSettlementForPosition, reconcileOpenDemoPositions } from '../server/resolution-engine.js';

function trade(overrides = {}) {
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
      polymarketUrl: 'https://polymarket.com/test',
      yesPriceCents: overrides.yesPriceCents ?? overrides.priceCents ?? 50,
      noPriceCents: overrides.noPriceCents ?? 50,
    },
    trader: {
      proxyWallet: '0x531b33c5e7b8c2610917f883a13a1b8b1a706022',
      displayName: 'Trader',
    },
    resolution: overrides.resolution || { status: 'open', pnlUsd: null },
  };
}

describe('resolution engine', () => {
  it('builds a win settlement from resolved_win status', () => {
    const demo = createDemoState();
    evaluateDemoCopy(demo, trade({ priceCents: 50 }));

    const settlement = buildSettlementForPosition(demo.openPositions[0], trade({
      resolution: {
        status: 'resolved_win',
        winningOutcome: 'YES',
        resolvedAt: '2026-05-18T12:00:00.000Z',
      },
    }));

    expect(settlement.status).toBe('win');
    expect(settlement.exitValueUsd).toBe(20);
    expect(settlement.realizedPnlUsd).toBe(10);
  });

  it('builds a loss settlement from resolved_loss status', () => {
    const demo = createDemoState();
    evaluateDemoCopy(demo, trade({ priceCents: 50 }));

    const settlement = buildSettlementForPosition(demo.openPositions[0], trade({
      resolution: {
        status: 'resolved_loss',
        winningOutcome: 'NO',
        resolvedAt: '2026-05-18T12:00:00.000Z',
      },
    }));

    expect(settlement.status).toBe('loss');
    expect(settlement.exitValueUsd).toBe(0);
    expect(settlement.realizedPnlUsd).toBe(-10);
  });

  it('refunds invalid markets', () => {
    const demo = createDemoState();
    evaluateDemoCopy(demo, trade({ priceCents: 50 }));

    const settlement = buildSettlementForPosition(demo.openPositions[0], trade({
      resolution: {
        status: 'invalid',
        resolvedAt: '2026-05-18T12:00:00.000Z',
      },
    }));

    expect(settlement.status).toBe('invalid');
    expect(settlement.exitValueUsd).toBe(10);
    expect(settlement.realizedPnlUsd).toBe(0);
  });

  it('does not settle open resolutions with null pnl', () => {
    const demo = createDemoState();
    evaluateDemoCopy(demo, trade({ priceCents: 50 }));

    const settlement = buildSettlementForPosition(demo.openPositions[0], trade({
      resolution: {
        status: 'open',
        winningOutcome: null,
        pnlUsd: null,
      },
    }));

    expect(settlement).toBeNull();
  });

  it('reconciles open positions and settles each source trade once', async () => {
    const demo = createDemoState();
    evaluateDemoCopy(demo, trade({ id: 'copy-1', priceCents: 50 }));
    const state = { demo };

    const result = await reconcileOpenDemoPositions(state, async (id) => trade({
      id,
      priceCents: 100,
      resolution: {
        status: 'resolved_win',
        winningOutcome: 'YES',
        resolvedAt: '2026-05-18T12:00:00.000Z',
      },
    }));

    expect(result.changed).toBe(true);
    expect(result.checked).toBe(1);
    expect(result.settled).toHaveLength(1);
    expect(demo.openPositions).toHaveLength(0);
    expect(demo.closedPositions).toHaveLength(1);
  });
});
