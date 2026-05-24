import { describe, expect, it } from 'vitest';
import { DEMO_STAKE_USD, DEMO_STARTING_CAPITAL_USD } from '../server/config.js';
import { createDemoState, evaluateDemoCopy, settleDemoPosition } from '../server/demo-engine.js';

const CASH_AFTER_ONE_COPY = DEMO_STARTING_CAPITAL_USD - DEMO_STAKE_USD;

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
      conditionId: overrides.conditionId || null,
      title: 'Test market',
      icon: null,
      polymarketUrl: 'https://polymarket.com/test',
      yesPriceCents: overrides.yesPriceCents ?? overrides.priceCents ?? 50,
      noPriceCents: overrides.noPriceCents ?? 50,
    },
    trader: {
      proxyWallet: overrides.wallet || '0x531b33c5e7b8c2610917f883a13a1b8b1a706022',
      displayName: 'Trader',
    },
  };
}

describe('demo copy engine', () => {
  it('opens a fixed-stake demo position on BUY', () => {
    const demo = createDemoState();
    const decision = evaluateDemoCopy(demo, trade({ priceCents: 50, conditionId: '0xcondition' }));

    expect(decision.action).toBe('copied');
    expect(demo.cashUsd).toBe(CASH_AFTER_ONE_COPY);
    expect(demo.openPositions).toHaveLength(1);
    expect(demo.openPositions[0].shares).toBe(20);
    expect(demo.openPositions[0].marketKey).toBe('0xcondition');
    expect(demo.openPositions[0].marketConditionId).toBe('0xcondition');
    expect(demo.copiedSourceTradeIds.has('trade-1')).toBe(true);
    expect(demo.copiedMarketKeys.has('0xcondition')).toBe(true);
  });

  it('copies BUY trades priced at the 75c max entry boundary', () => {
    const demo = createDemoState();
    const decision = evaluateDemoCopy(demo, trade({ priceCents: 75 }));

    expect(decision.action).toBe('copied');
    expect(demo.openPositions).toHaveLength(1);
    expect(demo.openPositions[0].entryPriceCents).toBe(75);
  });

  it('skips BUY trades above the 75c max entry rule', () => {
    const demo = createDemoState();
    const decision = evaluateDemoCopy(demo, trade({ priceCents: 76 }));

    expect(decision.action).toBe('skipped');
    expect(decision.reason).toMatch(/above 75\.0c max/i);
    expect(demo.openPositions).toHaveLength(0);
    expect(demo.cashUsd).toBe(DEMO_STARTING_CAPITAL_USD);
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
    expect(demo.cashUsd).toBe(CASH_AFTER_ONE_COPY);
  });

  it('copies only the first eligible BUY from the same trader on the same market', () => {
    const demo = createDemoState();
    const first = evaluateDemoCopy(demo, trade({ id: 'first', marketSlug: 'repeat-market', priceCents: 69 }));
    const second = evaluateDemoCopy(demo, trade({ id: 'second', marketSlug: 'repeat-market', priceCents: 68 }));

    expect(first.action).toBe('copied');
    expect(second.action).toBe('skipped');
    expect(second.reason).toMatch(/already copied/i);
    expect(demo.openPositions).toHaveLength(1);
    expect(demo.cashUsd).toBe(CASH_AFTER_ONE_COPY);
  });

  it('copies only the first eligible BUY on the same market across traders', () => {
    const demo = createDemoState();
    evaluateDemoCopy(demo, trade({ id: 'first', marketSlug: 'shared-market', priceCents: 69 }));
    const second = evaluateDemoCopy(demo, trade({
      id: 'second',
      marketSlug: 'shared-market',
      priceCents: 68,
      wallet: '0x1887879a1bda615e88f280b582514c7d54e2678a',
    }));

    expect(second.action).toBe('skipped');
    expect(second.reason).toMatch(/market already copied/i);
    expect(demo.openPositions).toHaveLength(1);
    expect(demo.cashUsd).toBe(CASH_AFTER_ONE_COPY);
  });

  it('treats shared condition IDs as the same copied market', () => {
    const demo = createDemoState();
    evaluateDemoCopy(demo, trade({
      id: 'first',
      marketSlug: 'team-a-market',
      conditionId: '0xshared',
      outcome: 'Team A',
      priceCents: 55,
    }));
    const second = evaluateDemoCopy(demo, trade({
      id: 'second',
      marketSlug: 'team-b-market',
      conditionId: '0xshared',
      outcome: 'Team B',
      priceCents: 45,
      wallet: '0x1887879a1bda615e88f280b582514c7d54e2678a',
    }));

    expect(second.action).toBe('skipped');
    expect(second.reason).toMatch(/market already copied/i);
    expect(demo.openPositions).toHaveLength(1);
  });

  it('can copy a later lower-priced entry if the first trade was skipped by max price', () => {
    const demo = createDemoState();
    const expensive = evaluateDemoCopy(demo, trade({ id: 'expensive', marketSlug: 'same-market', priceCents: 94 }));
    const eligible = evaluateDemoCopy(demo, trade({ id: 'eligible', marketSlug: 'same-market', priceCents: 69 }));

    expect(expensive.action).toBe('skipped');
    expect(eligible.action).toBe('copied');
    expect(demo.openPositions).toHaveLength(1);
  });

  it('does not close demo inventory on SELL because settlement waits for resolution', () => {
    const demo = createDemoState();
    evaluateDemoCopy(demo, trade({ id: 'open', priceCents: 50, yesPriceCents: 50 }));
    const sell = evaluateDemoCopy(demo, trade({ id: 'close', side: 'SELL', priceCents: 75, yesPriceCents: 75 }));

    expect(sell.action).toBe('skipped');
    expect(sell.reason).toMatch(/official market resolution/i);
    expect(demo.openPositions).toHaveLength(1);
    expect(demo.closedPositions).toHaveLength(0);
    expect(demo.cashUsd).toBe(CASH_AFTER_ONE_COPY);
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
    expect(demo.cashUsd).toBe(DEMO_STARTING_CAPITAL_USD + 10);
    expect(demo.realizedPnlUsd).toBe(10);
    expect(demo.decisions[0].action).toBe('settled');
  });
});
