import { describe, expect, it } from 'vitest';
import { makeCandidateTradeId, normalizeCandidateTrade } from '../server/candidate-tracker/normalizer.js';

function rawTrade(overrides = {}) {
  return {
    proxyWallet: '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD',
    side: 'BUY',
    asset: '123',
    conditionId: '0xcondition',
    size: 2_000,
    price: 0.5,
    timestamp: 1_779_538_333,
    title: 'Test market',
    slug: 'test-market',
    eventSlug: 'test-event',
    outcome: 'Yes',
    outcomeIndex: 0,
    name: 'Trader',
    pseudonym: 'Signal-Desk',
    profileImage: 'https://example.com/avatar.png',
    transactionHash: '0xtx',
    ...overrides,
  };
}

describe('candidate trade normalizer', () => {
  it('normalizes a Polymarket Data API trade inside the configured USD band', () => {
    const trade = normalizeCandidateTrade(rawTrade(), { minUsd: 1_000, maxUsd: 10_000, source: 'live' });

    expect(trade.wallet).toBe('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
    expect(trade.side).toBe('BUY');
    expect(trade.usdSize).toBe(1_000);
    expect(trade.priceCents).toBe(50);
    expect(trade.outcomeIndex).toBe(0);
    expect(trade.source).toBe('live');
    expect(trade.polymarketUrl).toBe('https://polymarket.com/event/test-event');
  });

  it('keeps the lower boundary and excludes the upper boundary', () => {
    const lower = normalizeCandidateTrade(rawTrade({ size: 2_000, price: 0.5 }), { minUsd: 1_000, maxUsd: 10_000 });
    const upper = normalizeCandidateTrade(rawTrade({ size: 20_000, price: 0.5 }), { minUsd: 1_000, maxUsd: 10_000 });

    expect(lower).not.toBeNull();
    expect(upper).toBeNull();
  });

  it('creates stable dedupe ids from transaction and fill fields', () => {
    const parts = {
      transactionHash: '0xtx',
      wallet: '0xwallet',
      asset: '123',
      side: 'BUY',
      outcomeIndex: 0,
      timestamp: 1_779_538_333,
      shares: 2_000,
      price: 0.5,
    };

    expect(makeCandidateTradeId(parts)).toBe(makeCandidateTradeId({ ...parts }));
    expect(makeCandidateTradeId(parts)).not.toBe(makeCandidateTradeId({ ...parts, price: 0.51 }));
  });
});
