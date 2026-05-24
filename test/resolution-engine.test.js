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
      conditionId: overrides.conditionId || null,
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

  it('uses a Polymarket fallback resolution when the whale trade is still open', async () => {
    const demo = createDemoState();
    evaluateDemoCopy(demo, trade({ id: 'copy-1', outcome: 'Thunder', priceCents: 68 }));
    const state = { demo };

    const result = await reconcileOpenDemoPositions(
      state,
      async (id) => trade({
        id,
        outcome: 'Thunder',
        priceCents: 68,
        marketSlug: 'nba-sas-okc-2026-05-20',
        resolution: { status: 'open', pnlUsd: null },
      }),
      async () => ({
        status: 'resolved',
        winningOutcome: 'Thunder',
        resolvedAt: '2026-05-21T03:00:00.000Z',
        source: 'polymarket-gamma',
        closed: true,
      })
    );

    expect(result.settled).toHaveLength(1);
    expect(demo.openPositions).toHaveLength(0);
    expect(demo.closedPositions[0].status).toBe('win');
    expect(demo.closedPositions[0].settlementSource).toBe('polymarket-gamma');
  });

  it('cross-checks ambiguous binary Polywhale losses against Gamma before settling team markets', async () => {
    const demo = createDemoState();
    evaluateDemoCopy(demo, trade({
      id: 'dallas-copy',
      outcome: 'Dallas Wings',
      marketSlug: 'wnba-dal-chi-2026-05-20',
      conditionId: '0x1849',
      priceCents: 58,
    }));
    const state = { demo };

    const result = await reconcileOpenDemoPositions(
      state,
      async (id) => trade({
        id,
        outcome: 'Dallas Wings',
        marketSlug: 'wnba-dal-chi-2026-05-20',
        conditionId: '0x1849',
        priceCents: 58,
        resolution: {
          status: 'resolved_loss',
          winningOutcome: 'YES',
          pnlUsd: -14553.7776,
          resolvedAt: '2026-05-21T04:25:15.000Z',
        },
      }),
      async ({ conditionId }) => ({
        status: 'resolved',
        winningOutcome: 'Dallas Wings',
        resolvedAt: '2026-05-21T04:23:29.000Z',
        source: 'polymarket-gamma',
        closed: true,
        conditionId,
      })
    );

    expect(result.settled).toHaveLength(1);
    expect(demo.openPositions).toHaveLength(0);
    expect(demo.closedPositions[0].status).toBe('win');
    expect(demo.closedPositions[0].settlementSource).toBe('polymarket-gamma');
  });

  it('settles candidate-sourced positions from Gamma when the whale fetch 404s', async () => {
    const demo = createDemoState();
    evaluateDemoCopy(demo, trade({
      id: 'candidate-6117',
      outcome: 'Team Falcons',
      marketSlug: 'team-falcons-vs-legacy',
      conditionId: '0xabc123',
      priceCents: 56,
    }));
    const state = { demo };

    const result = await reconcileOpenDemoPositions(
      state,
      async () => {
        throw new Error('404 Not Found for candidate-6117');
      },
      async ({ conditionId, slug }) => {
        expect(conditionId).toBe('0xabc123');
        expect(slug).toBe('team-falcons-vs-legacy');
        return {
          status: 'resolved',
          winningOutcome: 'Legacy',
          resolvedAt: '2026-05-24T13:22:41.000Z',
          source: 'polymarket-gamma',
          closed: true,
          conditionId,
        };
      }
    );

    expect(result.errors).toHaveLength(0);
    expect(result.settled).toHaveLength(1);
    expect(demo.openPositions).toHaveLength(0);
    expect(demo.closedPositions[0].status).toBe('loss');
    expect(demo.closedPositions[0].resolutionFetchStatus).toBe('failed');
    expect(demo.closedPositions[0].resolutionDiagnostic).toBe('settled_from_gamma');
    expect(demo.closedPositions[0].settlementSource).toBe('polymarket-gamma');
  });

  it('settles ambiguous binary Polywhale losses as losses when Gamma confirms another team won', async () => {
    const demo = createDemoState();
    evaluateDemoCopy(demo, trade({
      id: 'thunder-copy',
      outcome: 'Thunder',
      marketSlug: 'nba-sas-okc-2026-05-18',
      conditionId: '0x8246',
      priceCents: 68,
    }));
    const state = { demo };

    const result = await reconcileOpenDemoPositions(
      state,
      async (id) => trade({
        id,
        outcome: 'Thunder',
        marketSlug: 'nba-sas-okc-2026-05-18',
        conditionId: '0x8246',
        priceCents: 68,
        resolution: {
          status: 'resolved_loss',
          winningOutcome: 'YES',
          pnlUsd: -10000,
          resolvedAt: '2026-05-19T08:14:30.000Z',
        },
      }),
      async ({ conditionId }) => ({
        status: 'resolved',
        winningOutcome: 'Spurs',
        resolvedAt: '2026-05-19T08:14:30.000Z',
        source: 'polymarket-gamma',
        closed: true,
        conditionId,
      })
    );

    expect(result.settled).toHaveLength(1);
    expect(demo.openPositions).toHaveLength(0);
    expect(demo.closedPositions[0].status).toBe('loss');
    expect(demo.closedPositions[0].winningOutcome).toBe('Spurs');
    expect(demo.closedPositions[0].settlementSource).toBe('polymarket-gamma');
  });

  it('keeps candidate positions open when Gamma is proposed but not officially closed', async () => {
    const demo = createDemoState();
    evaluateDemoCopy(demo, trade({
      id: 'candidate-proposed',
      outcome: 'T1',
      marketSlug: 't1-handicap',
      conditionId: '0xproposed',
      priceCents: 63,
    }));
    const state = { demo };

    const result = await reconcileOpenDemoPositions(
      state,
      async () => {
        throw new Error('404 Not Found for candidate-proposed');
      },
      async () => ({
        status: 'open',
        rawStatus: 'gamma_proposed',
        winningOutcome: null,
        resolvedAt: null,
        source: 'polymarket-gamma',
        closed: false,
        proposed: true,
      })
    );

    expect(result.settled).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(demo.openPositions).toHaveLength(1);
    expect(demo.openPositions[0].resolutionStatus).toBe('open');
    expect(demo.openPositions[0].resolutionFetchStatus).toBe('failed');
    expect(demo.openPositions[0].resolutionDiagnostic).toBe('gamma_proposed');
  });

  it('does not settle ambiguous binary team outcomes as losses without a market cross-check', () => {
    const demo = createDemoState();
    evaluateDemoCopy(demo, trade({ outcome: 'Dallas Wings', priceCents: 58 }));

    const settlement = buildSettlementForPosition(demo.openPositions[0], trade({
      outcome: 'Dallas Wings',
      resolution: {
        status: 'resolved_loss',
        winningOutcome: 'YES',
        pnlUsd: -14553.7776,
        resolvedAt: '2026-05-21T04:25:15.000Z',
      },
    }));

    expect(settlement).toBeNull();
  });
});
