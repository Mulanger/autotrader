import { describe, expect, it } from 'vitest';
import { evaluateDryRunFokBuy } from '../server/real/quote-engine.js';

const trade = { priceCents: 50 };

describe('real dry-run quote engine', () => {
  it('passes a $10 FOK BUY when asks inside the guard have enough notional', () => {
    const result = evaluateDryRunFokBuy({
      trade,
      stakeUsd: 10,
      guardCents: 4,
      orderBook: {
        hash: 'book-1',
        asks: [
          { price: '0.51', size: '10' },
          { price: '0.52', size: '10' },
        ],
      },
    });

    expect(result.status).toBe('would_fill');
    expect(result.stakeUsd).toBe(10);
    expect(result.bestAskCents).toBe(51);
    expect(result.worstAskCents).toBe(52);
    expect(result.estimatedShares).toBeGreaterThan(19);
  });

  it('rejects when the best ask is above source plus guard', () => {
    const result = evaluateDryRunFokBuy({
      trade,
      stakeUsd: 10,
      guardCents: 4,
      orderBook: { asks: [{ price: '0.55', size: '100' }] },
    });

    expect(result.status).toBe('rejected');
    expect(result.reasonCode).toBe('above_price_guard');
  });

  it('rejects when the best ask is below source minus guard precheck', () => {
    const result = evaluateDryRunFokBuy({
      trade,
      stakeUsd: 10,
      guardCents: 4,
      orderBook: { asks: [{ price: '0.45', size: '100' }] },
    });

    expect(result.status).toBe('rejected');
    expect(result.reasonCode).toBe('below_price_guard');
  });

  it('rejects when liquidity inside the guard cannot fill the full stake', () => {
    const result = evaluateDryRunFokBuy({
      trade,
      stakeUsd: 10,
      guardCents: 4,
      orderBook: {
        asks: [
          { price: '0.51', size: '2' },
          { price: '0.52', size: '2' },
        ],
      },
    });

    expect(result.status).toBe('rejected');
    expect(result.reasonCode).toBe('insufficient_liquidity');
    expect(result.notionalAvailableUsd).toBeCloseTo(2.06);
  });
});
