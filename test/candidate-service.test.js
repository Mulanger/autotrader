import { describe, expect, it } from 'vitest';
import { createAppState } from '../server/app-state.js';
import { createCandidateTracker, resolutionBatchSize } from '../server/candidate-tracker/service.js';

function rawTrade(offset) {
  return {
    proxyWallet: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    side: 'BUY',
    asset: `asset-${offset}`,
    conditionId: `condition-${offset}`,
    size: 3_000,
    price: 0.5,
    timestamp: Math.floor(Date.now() / 1000),
    title: `Market ${offset}`,
    outcome: 'YES',
    transactionHash: `0x${String(offset).padStart(64, '0')}`,
  };
}

function fakeStorage(overrides = {}) {
  const calls = {
    complete: [],
    serviceState: [],
    recovered: false,
  };
  return {
    calls,
    upsertTrade: async () => ({ insertedTrade: true }),
    getQueuedBackfillTraders: async () => ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    recoverStaleBackfills: async () => {
      calls.recovered = true;
      return ['0xstale'];
    },
    markBackfillRunning: async () => {},
    markBackfillComplete: async (...args) => calls.complete.push(args),
    markBackfillFailed: async () => {},
    saveServiceState: async (...args) => calls.serviceState.push(args),
    getResolutionQueueMetrics: async () => ({ openTradeCount: 0, eligibleOpenTradeCount: 0 }),
    getOpenTrades: async () => [],
    markResolutionChecked: async () => {},
    saveResolvedTrade: async () => {},
    close: async () => {},
    ...overrides,
  };
}

describe('candidate tracker service', () => {
  it('marks backfill partial when Data API rejects a deep offset after successful pages', async () => {
    const state = createAppState();
    const storage = fakeStorage();
    const seenCalls = [];
    const tracker = createCandidateTracker(state, () => {}, {
      enabled: true,
      copyPoolEnabled: false,
      storageFactory: async () => storage,
      fetchDataApiTrades: async ({ offset = 0, user, filterType, filterAmount }) => {
        if (!user) return [];
        seenCalls.push({ offset, filterType, filterAmount });
        if (offset === 500) {
          const error = new Error('400 Bad Request for /trades?offset=500');
          error.status = 400;
          error.url = '/trades?offset=500';
          throw error;
        }
        return [rawTrade(offset)];
      },
    });

    await tracker.start();
    await tracker.close();

    expect(seenCalls).toEqual([
      { offset: 0, filterType: 'CASH', filterAmount: 1000 },
      { offset: 500, filterType: 'CASH', filterAmount: 1000 },
    ]);
    expect(storage.calls.complete[0][2]).toEqual({
      partial: true,
      reason: 'Stopped after Data API rejected offset 500',
    });
    expect(storage.calls.serviceState.at(-1)[1].status).toBe('partial');
  });

  it('recovers stale running backfills on startup', async () => {
    const state = createAppState();
    const storage = fakeStorage({ getQueuedBackfillTraders: async () => [] });
    const tracker = createCandidateTracker(state, () => {}, {
      enabled: true,
      copyPoolEnabled: false,
      storageFactory: async () => storage,
      fetchDataApiTrades: async () => [],
    });

    await tracker.start();
    await tracker.close();

    expect(storage.calls.recovered).toBe(true);
    expect(state.service.candidates.recoveredStaleBackfillCount).toBe(1);
  });

  it('seeds active copy-pool wallets for normal candidate backfill on startup', async () => {
    const state = createAppState();
    const calls = {};
    const storage = fakeStorage({
      getQueuedBackfillTraders: async () => [],
      seedActiveCopyPoolBackfill: async (wallets) => {
        calls.seedWallets = wallets;
        return ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'];
      },
    });
    const tracker = createCandidateTracker(state, () => {}, {
      enabled: true,
      copyPoolEnabled: false,
      storageFactory: async () => storage,
      fetchDataApiTrades: async () => [],
    });

    await tracker.start();
    await tracker.close();

    expect(calls.seedWallets.length).toBeGreaterThan(0);
    expect(state.service.candidates.seededActiveCopyPoolBackfillCount).toBe(1);
  });

  it('serves cached real copy quality scores when candidate workers are disabled', async () => {
    const state = createAppState();
    const storage = fakeStorage({
      recoverStaleBackfills: async () => {
        throw new Error('disabled mode should not recover backfills');
      },
      seedActiveCopyPoolBackfill: async () => {
        throw new Error('disabled mode should not seed backfills');
      },
      getRealCopyQualityLeaderboard: async () => ({
        ok: true,
        summary: {
          total: 2,
          scored: 2,
          eligible: 1,
          core: 1,
          candidate: 0,
          watchlist: 0,
          manualReview: 0,
          ignore: 1,
          lastScoredAt: '2026-05-28T00:00:00.000Z',
        },
        rows: [{ wallet: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', score: 91 }],
      }),
      getRealCopyQualityScore: async () => ({ wallet: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', score: 91 }),
    });
    const tracker = createCandidateTracker(state, () => {}, {
      enabled: false,
      storageFactory: async () => storage,
      fetchDataApiTrades: async () => {
        throw new Error('disabled mode should not poll trades');
      },
    });

    await tracker.start();
    const payload = await tracker.getRealCopyQualityLeaderboard();
    const row = await tracker.getRealCopyQualityScore('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    await tracker.close();

    expect(state.service.candidates.status).toBe('disabled');
    expect(state.service.candidates.storageStatus).toBe('ready');
    expect(state.service.realCopyQuality.status).toBe('cached');
    expect(payload.enabled).toBe(false);
    expect(payload.cached).toBe(true);
    expect(payload.rows).toHaveLength(1);
    expect(payload.summary.scored).toBe(2);
    expect(row.score).toBe(91);
  });

  it('scales candidate resolution batches for large due queues', () => {
    expect(resolutionBatchSize({ eligibleOpenTradeCount: 0 })).toBe(250);
    expect(resolutionBatchSize({ eligibleOpenTradeCount: 900 })).toBe(250);
    expect(resolutionBatchSize({ eligibleOpenTradeCount: 20_000 })).toBe(1000);
  });
});
