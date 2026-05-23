import { describe, expect, it } from 'vitest';
import { buildCandidateSettlement } from '../server/candidate-tracker/resolution.js';

function trade(overrides = {}) {
  return {
    id: 'candidate-1',
    side: 'BUY',
    outcome: 'Dallas Wings',
    outcomeIndex: 0,
    shares: 20,
    usdSize: 10,
    ...overrides,
  };
}

const resolution = {
  status: 'resolved',
  winningOutcome: 'Dallas Wings',
  winningOutcomeIndex: 0,
  resolvedAt: '2026-05-21T04:23:29.000Z',
  source: 'polymarket-gamma',
};

describe('candidate resolution semantics', () => {
  it('settles a BUY win using shares as payout and realized P/L', () => {
    const settlement = buildCandidateSettlement(trade(), resolution);

    expect(settlement.status).toBe('resolved_win');
    expect(settlement.payoutUsd).toBe(20);
    expect(settlement.pnlUsd).toBe(10);
  });

  it('settles a BUY loss as zero payout minus stake', () => {
    const settlement = buildCandidateSettlement(trade({ outcome: 'Chicago Sky', outcomeIndex: 1 }), resolution);

    expect(settlement.status).toBe('resolved_loss');
    expect(settlement.payoutUsd).toBe(0);
    expect(settlement.pnlUsd).toBe(-10);
  });

  it('tracks SELL rows without realized P/L', () => {
    const settlement = buildCandidateSettlement(trade({ side: 'SELL' }), resolution);

    expect(settlement.status).toBe('resolved_loss');
    expect(settlement.payoutUsd).toBe(10);
    expect(settlement.pnlUsd).toBeNull();
  });

  it('uses outcome index before labels for multi-outcome markets', () => {
    const settlement = buildCandidateSettlement(
      trade({ outcome: 'Ambiguous Label', outcomeIndex: 2, shares: 40, usdSize: 12 }),
      { ...resolution, winningOutcome: 'Other Label', winningOutcomeIndex: 2 }
    );

    expect(settlement.status).toBe('resolved_win');
    expect(settlement.pnlUsd).toBe(28);
  });
});
