import { describe, expect, it } from 'vitest';
import { createDemoState, evaluateDemoCopy } from '../server/demo-engine.js';

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
  };
}

describe('demo copy engine', () => {
  it('opens a fixed-stake demo position on BUY', () => {
    const demo = createDemoState();
    const decision = evaluateDemoCopy(demo, trade({ priceCents: 50 }));

    expect(decision.action).toBe('copied');
    expect(demo.cashUsd).toBe(90);
    expect(demo.openPositions).toHaveLength(1);
    expect(demo.openPositions[0].shares).toBe(20);
    expect(demo.copiedSourceTradeIds.has('trade-1')).toBe(true);
  });

  it('does not copy the same source trade twice', () => {
    const demo = createDemoState();
    evaluateDemoCopy(demo, trade({ id: 'duplicate' }));
    const second = evaluateDemoCopy(demo, trade({ id: 'duplicate' }));

    expect(second).toBeNull();
    expect(demo.openPositions).toHaveLength(1);
    expect(demo.cashUsd).toBe(90);
  });

  it('closes matching inventory on SELL and realizes pnl', () => {
    const demo = createDemoState();
    evaluateDemoCopy(demo, trade({ id: 'open', priceCents: 50, yesPriceCents: 50 }));
    const close = evaluateDemoCopy(demo, trade({ id: 'close', side: 'SELL', priceCents: 75, yesPriceCents: 75 }));

    expect(close.action).toBe('copied');
    expect(demo.openPositions).toHaveLength(0);
    expect(demo.closedPositions).toHaveLength(1);
    expect(demo.closedPositions[0].status).toBe('win');
    expect(demo.realizedPnlUsd).toBeCloseTo(5, 5);
    expect(demo.cashUsd).toBeCloseTo(105, 5);
  });

  it('skips SELL when there is no matching inventory', () => {
    const demo = createDemoState();
    const decision = evaluateDemoCopy(demo, trade({ side: 'SELL' }));

    expect(decision.action).toBe('skipped');
    expect(decision.reason).toMatch(/no matching inventory/i);
    expect(demo.skippedCount).toBe(1);
  });
});
