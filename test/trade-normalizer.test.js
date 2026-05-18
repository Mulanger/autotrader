import { describe, expect, it } from 'vitest';
import { getTradeCurrentPriceCents, normalizeTrade } from '../server/trade-normalizer.js';

describe('trade normalizer', () => {
  it('normalizes Polywhale whale records', () => {
    const normalized = normalizeTrade({
      id: 'abc',
      side: 'buy',
      outcome: 'NO',
      usdSize: '123.45',
      shares: '200',
      priceCents: '62',
      timestamp: 1_779_120_000,
      market: {
        slug: 'market-slug',
        title: 'Market title',
        yesPriceCents: 38,
        noPriceCents: 62,
      },
      trader: {
        proxyWallet: '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD',
        displayName: 'Tester',
      },
    });

    expect(normalized.id).toBe('abc');
    expect(normalized.side).toBe('BUY');
    expect(normalized.trader.proxyWallet).toBe('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
    expect(normalized.usdSize).toBe(123.45);
    expect(normalized.market.slug).toBe('market-slug');
  });

  it('uses outcome-specific market price when available', () => {
    const yes = normalizeTrade({
      id: 'yes',
      side: 'BUY',
      outcome: 'YES',
      priceCents: 40,
      market: { title: 'Market', yesPriceCents: 45, noPriceCents: 55 },
      trader: { proxyWallet: '0x1111111111111111111111111111111111111111' },
    });
    const no = normalizeTrade({
      id: 'no',
      side: 'BUY',
      outcome: 'NO',
      priceCents: 40,
      market: { title: 'Market', yesPriceCents: 45, noPriceCents: 55 },
      trader: { proxyWallet: '0x1111111111111111111111111111111111111111' },
    });

    expect(getTradeCurrentPriceCents(yes)).toBe(45);
    expect(getTradeCurrentPriceCents(no)).toBe(55);
  });

  it('normalizes nested resolution blocks from the whale API', () => {
    const normalized = normalizeTrade({
      id: 'resolved',
      side: 'BUY',
      outcome: 'YES',
      priceCents: 50,
      market: { title: 'Market' },
      trader: { proxyWallet: '0x1111111111111111111111111111111111111111' },
      resolution: {
        status: 'resolved_win',
        winningOutcome: 'YES',
        payoutUsd: 20,
        pnlUsd: 10,
        resolvedAt: 1_779_120_000,
        closed: true,
      },
    });

    expect(normalized.resolution.status).toBe('resolved_win');
    expect(normalized.resolution.winningOutcome).toBe('YES');
    expect(normalized.resolution.pnlUsd).toBe(10);
    expect(normalized.resolution.closed).toBe(true);
    expect(normalized.resolution.resolvedAt).toBe('2026-05-18T16:00:00.000Z');
  });
});
