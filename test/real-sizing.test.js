import { describe, expect, it } from 'vitest';
import {
  buildExposureGroups,
  calculateSizingSignal,
  createTraderSizingService,
  labelSizingMultiple,
} from '../server/real/sizing.js';

const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function trade({
  side = 'BUY',
  conditionId = 'condition-1',
  outcome = 'YES',
  outcomeIndex = 0,
  price = 0.5,
  size = 100,
  timestamp = 1,
} = {}) {
  return {
    proxyWallet: wallet,
    side,
    conditionId,
    outcome,
    outcomeIndex,
    price,
    size,
    timestamp,
    title: conditionId,
  };
}

function request(overrides = {}) {
  return {
    id: 'order-1',
    wallet,
    conditionId: 'target',
    outcome: 'YES',
    outcomeIndex: 0,
    sourcePriceCents: 50,
    ...overrides,
  };
}

describe('real trader sizing', () => {
  it('tracks split buys, sells, full exits, and separate outcomes', () => {
    const groups = buildExposureGroups([
      trade({ conditionId: 'market-1', outcome: 'YES', outcomeIndex: 0, size: 100, price: 0.4, timestamp: 1 }),
      trade({ conditionId: 'market-1', outcome: 'YES', outcomeIndex: 0, size: 50, price: 0.5, timestamp: 2 }),
      trade({ conditionId: 'market-1', outcome: 'YES', outcomeIndex: 0, side: 'SELL', size: 80, price: 0.6, timestamp: 3 }),
      trade({ conditionId: 'market-1', outcome: 'YES', outcomeIndex: 0, side: 'SELL', size: 200, price: 0.7, timestamp: 4 }),
      trade({ conditionId: 'market-1', outcome: 'NO', outcomeIndex: 1, size: 25, price: 0.2, timestamp: 5 }),
    ]);

    const yes = groups.find((group) => group.key === 'condition:market-1|idx:0');
    const no = groups.find((group) => group.key === 'condition:market-1|idx:1');

    expect(groups).toHaveLength(2);
    expect(yes.netShares).toBe(0);
    expect(yes.peakExposureUsd).toBe(75);
    expect(no.netShares).toBe(25);
    expect(no.peakExposureUsd).toBe(5);
  });

  it('uses the median prior-market peak exposure as the usual unit', () => {
    const signal = calculateSizingSignal({
      item: request(),
      minBaselineMarkets: 3,
      trades: [
        trade({ conditionId: 'a', size: 200, price: 0.5, timestamp: 1 }),
        trade({ conditionId: 'b', size: 400, price: 0.5, timestamp: 2 }),
        trade({ conditionId: 'c', size: 800, price: 0.5, timestamp: 3 }),
        trade({ conditionId: 'target', size: 1000, price: 0.5, timestamp: 4 }),
      ],
    });

    expect(signal.status).toBe('ok');
    expect(signal.usualUnitUsd).toBe(200);
    expect(signal.currentExposureUsd).toBe(500);
    expect(signal.multiple).toBe(2.5);
    expect(signal.label).toBe('high conviction');
  });

  it('returns neutral insufficient-history states for sparse baselines', () => {
    const signal = calculateSizingSignal({
      item: request(),
      minBaselineMarkets: 5,
      trades: [
        trade({ conditionId: 'a', size: 200, price: 0.5, timestamp: 1 }),
        trade({ conditionId: 'target', size: 1000, price: 0.5, timestamp: 2 }),
      ],
    });

    expect(signal.status).toBe('insufficient_history');
    expect(signal.tone).toBe('neutral');
    expect(signal.multiple).toBeNull();
  });

  it('labels sizing multiples by conviction band', () => {
    expect(labelSizingMultiple(0.2).label).toBe('probe/small');
    expect(labelSizingMultiple(1).label).toBe('normal');
    expect(labelSizingMultiple(2).label).toBe('conviction');
    expect(labelSizingMultiple(3).label).toBe('high conviction');
    expect(labelSizingMultiple(6).label).toBe('extreme/outsized');
  });

  it('returns per-item failures without failing the whole batch', async () => {
    const service = createTraderSizingService({
      minBaselineMarkets: 1,
      now: () => Date.parse('2026-06-04T00:00:00.000Z'),
      fetchTrades: async ({ user }) => {
        if (user === wallet) {
          return [
            trade({ conditionId: 'a', size: 200, price: 0.5, timestamp: Date.parse('2026-06-01T00:00:00.000Z') / 1000 }),
            trade({ conditionId: 'target', size: 500, price: 0.5, timestamp: Date.parse('2026-06-02T00:00:00.000Z') / 1000 }),
          ];
        }
        throw new Error('Data API unavailable');
      },
    });

    const payload = await service.getBatchSizing([
      request(),
      request({
        id: 'order-2',
        wallet: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        conditionId: 'target-2',
      }),
    ]);

    expect(payload.ok).toBe(true);
    expect(payload.items).toHaveLength(2);
    expect(payload.items[0].status).toBe('ok');
    expect(payload.items[1].status).toBe('error');
  });
});
