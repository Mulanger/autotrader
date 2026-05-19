import { describe, expect, it } from 'vitest';
import { createDemoState, evaluateDemoCopy, settleDemoPosition } from '../server/demo-engine.js';

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

  it('tracks fee status and adjusts buy shares when fee data is available', () => {
    const demo = createDemoState();
    evaluateDemoCopy(demo, {
      ...trade({ priceCents: 50 }),
      fees: { feesEnabled: true, feeRateBps: 300 },
    });

    expect(demo.openPositions[0].grossShares).toBe(20);
    expect(demo.openPositions[0].entryFeeUsd).toBe(0.15);
    expect(demo.openPositions[0].shares).toBe(19.7);
  });

  it('does not copy the same source trade twice', () => {
    const demo = createDemoState();
    evaluateDemoCopy(demo, trade({ id: 'duplicate' }));
    const second = evaluateDemoCopy(demo, trade({ id: 'duplicate' }));

    expect(second).toBeNull();
    expect(demo.openPositions).toHaveLength(1);
    expect(demo.cashUsd).toBe(90);
  });

  it('does not close demo inventory on SELL because settlement waits for resolution', () => {
    const demo = createDemoState();
    evaluateDemoCopy(demo, trade({ id: 'open', priceCents: 50, yesPriceCents: 50 }));
    const sell = evaluateDemoCopy(demo, trade({ id: 'close', side: 'SELL', priceCents: 75, yesPriceCents: 75 }));

    expect(sell.action).toBe('skipped');
    expect(sell.reason).toMatch(/official market resolution/i);
    expect(demo.openPositions).toHaveLength(1);
    expect(demo.closedPositions).toHaveLength(0);
    expect(demo.cashUsd).toBe(90);
  });

  it('skips SELL without placing a demo close order', () => {
    const demo = createDemoState();
    const decision = evaluateDemoCopy(demo, trade({ side: 'SELL' }));

    expect(decision.action).toBe('skipped');
    expect(decision.reason).toMatch(/resolution/i);
    expect(demo.skippedCount).toBe(1);
  });

  it('settles an open position from an official win resolution', () => {
    const demo = createDemoState();
    evaluateDemoCopy(demo, trade({ id: 'open', priceCents: 50, yesPriceCents: 50 }));
    const closed = settleDemoPosition(demo, demo.openPositions[0].id, {
      status: 'win',
      exitPriceCents: 100,
      exitValueUsd: 20,
      realizedPnlUsd: 10,
      resolvedAt: '2026-05-18T12:00:00.000Z',
      resolutionStatus: 'resolved_win',
      winningOutcome: 'YES',
      settlementSource: 'test',
      sourceTradeId: 'open',
      reason: 'Official market resolution: won +$10.00',
    });

    expect(closed.status).toBe('win');
    expect(demo.openPositions).toHaveLength(0);
    expect(demo.closedPositions).toHaveLength(1);
    expect(demo.cashUsd).toBe(110);
    expect(demo.realizedPnlUsd).toBe(10);
    expect(demo.decisions[0].action).toBe('settled');
  });
});
