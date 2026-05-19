import { describe, expect, it } from 'vitest';
import { classifyGammaMarket } from '../server/polymarket-client.js';

describe('polymarket gamma classifier', () => {
  it('keeps active markets open', () => {
    const resolution = classifyGammaMarket({
      active: true,
      closed: false,
      acceptingOrders: true,
      outcomes: '["Spurs","Thunder"]',
      outcomePrices: '["0.325","0.675"]',
    });

    expect(resolution.status).toBe('open');
    expect(resolution.closed).toBe(false);
  });

  it('resolves arbitrary named outcome markets when final prices are authoritative', () => {
    const resolution = classifyGammaMarket({
      active: false,
      closed: true,
      acceptingOrders: false,
      outcomes: '["Spurs","Thunder"]',
      outcomePrices: '["0","1"]',
      updatedAt: '2026-05-21T03:00:00.000Z',
    });

    expect(resolution.status).toBe('resolved');
    expect(resolution.winningOutcome).toBe('Thunder');
    expect(resolution.resolvedAt).toBe('2026-05-21T03:00:00.000Z');
  });

  it('leaves closed markets unsettled until final prices pick one winner', () => {
    const resolution = classifyGammaMarket({
      active: false,
      closed: true,
      acceptingOrders: false,
      outcomes: '["Yes","No"]',
      outcomePrices: '["0.5","0.5"]',
    });

    expect(resolution.status).toBe('closed');
    expect(resolution.winningOutcome).toBeNull();
  });
});
