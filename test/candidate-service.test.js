import { describe, expect, it } from 'vitest';
import { createAppState } from '../server/app-state.js';
import { createCandidateTracker, resolutionBatchSize } from '../server/candidate-tracker/service.js';

function rawTrade(offset, overrides = {}) {
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
    ...overrides,
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

  it('runs low-cost maintenance while global candidate polling is disabled', async () => {
    const state = createAppState();
    const calls = {
      fetches: [],
      upserts: [],
      serviceState: [],
      resolutionLimits: [],
      scoringScopes: [],
      copyPoolRuns: 0,
      locked: false,
    };
    const nowSeconds = Math.floor(Date.now() / 1000);
    const storage = fakeStorage({
      getRealCopyQualityLeaderboard: async () => ({
        ok: true,
        summary: { total: 0, scored: 0, eligible: 0 },
        rows: [],
      }),
      getServiceState: async () => null,
      saveServiceState: async (...args) => calls.serviceState.push(args),
      getMaintenanceWallets: async ({ scope, baselineWallets }) => {
        calls.scope = scope;
        calls.baselineCount = baselineWallets.length;
        return [
          '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        ];
      },
      withMaintenanceLock: async (callback) => {
        calls.locked = true;
        return { acquired: true, result: await callback() };
      },
      upsertTrade: async (trade) => {
        calls.upserts.push(trade);
        return { insertedTrade: calls.upserts.length === 1 };
      },
      getOpenTrades: async (limit) => {
        calls.resolutionLimits.push(limit);
        return [];
      },
      evaluateCopyPool: async () => {
        calls.copyPoolRuns += 1;
        return { changed: [], snapshot: {} };
      },
      recalculateRealCopyQuality: async ({ scope }) => {
        calls.scoringScopes.push(scope);
        return { ok: true, scored: 2, summary: { total: 2, scored: 2, eligible: 1 } };
      },
    });
    const tracker = createCandidateTracker(state, () => {}, {
      enabled: false,
      maintenanceEnabled: true,
      maintenanceRunOnStart: false,
      maintenancePageLimit: 3,
      maintenanceMaxPagesPerWallet: 2,
      maintenanceResolutionMaxTrades: 25,
      storageFactory: async () => storage,
      fetchDataApiTrades: async (params) => {
        calls.fetches.push(params);
        if (!params.user) throw new Error('global polling should not run during maintenance');
        if (params.user === '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') {
          throw new Error('wallet fetch failed');
        }
        if (params.offset > 0) return [rawTrade(99)];
        return [
          rawTrade(1, { timestamp: nowSeconds, size: 3_000, price: 0.5 }),
          rawTrade(2, { timestamp: nowSeconds, size: 30_000, price: 0.5 }),
          rawTrade(3, { timestamp: nowSeconds - 72 * 60 * 60, size: 3_000, price: 0.5 }),
        ];
      },
    });

    await tracker.start();
    const summary = await tracker.runMaintenance({ force: true });
    await tracker.close();

    expect(state.service.candidates.status).toBe('disabled');
    expect(calls.locked).toBe(true);
    expect(calls.scope).toBe('active_scored');
    expect(calls.baselineCount).toBeGreaterThan(0);
    expect(calls.fetches).toHaveLength(2);
    expect(calls.fetches.every((call) => call.user)).toBe(true);
    expect(calls.fetches[0]).toMatchObject({
      user: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      limit: 3,
      offset: 0,
      filterType: 'CASH',
      filterAmount: 1000,
    });
    expect(calls.upserts).toHaveLength(1);
    expect(calls.upserts[0].source).toBe('maintenance');
    expect(calls.upserts[0].usdSize).toBe(1500);
    expect(calls.resolutionLimits).toEqual([25]);
    expect(calls.copyPoolRuns).toBe(1);
    expect(calls.scoringScopes).toEqual(['active_scored']);
    expect(calls.serviceState.map(([key]) => key)).toEqual([
      'maintenance:last_fetch',
      'maintenance:last_score',
      'maintenance:last_run',
    ]);
    expect(summary.status).toBe('partial');
    expect(summary.insertedTradeCount).toBe(1);
    expect(summary.errorCount).toBe(1);
    expect(state.service.candidates.maintenanceLastWalletCount).toBe(2);
    expect(state.service.candidates.maintenanceLastInsertedTradeCount).toBe(1);
    expect(state.service.candidates.maintenanceLastScoredWalletCount).toBe(2);
  });

  it('skips startup maintenance when the last successful run is still fresh', async () => {
    const state = createAppState();
    const calls = { fetches: 0 };
    const storage = fakeStorage({
      getRealCopyQualityLeaderboard: async () => ({
        ok: true,
        summary: { total: 1, scored: 1, eligible: 1 },
        rows: [],
      }),
      getServiceState: async () => ({
        payload: {
          status: 'done',
          finishedAt: new Date().toISOString(),
          lookbackHours: 96,
          walletCount: 2,
          insertedTradeCount: 4,
          scoredWalletCount: 2,
        },
      }),
      withMaintenanceLock: async (callback) => ({ acquired: true, result: await callback() }),
    });
    const tracker = createCandidateTracker(state, () => {}, {
      enabled: false,
      maintenanceEnabled: true,
      maintenanceIntervalMs: 24 * 60 * 60_000,
      storageFactory: async () => storage,
      fetchDataApiTrades: async () => {
        calls.fetches += 1;
        throw new Error('fresh maintenance should not fetch trades');
      },
    });

    await tracker.start();
    await tracker.close();

    expect(calls.fetches).toBe(0);
    expect(state.service.candidates.maintenanceStatus).toBe('ready');
    expect(state.service.candidates.maintenanceLastWalletCount).toBe(2);
    expect(state.service.candidates.maintenanceLastInsertedTradeCount).toBe(4);
  });

  it('runs fetch catch-up when the last completed maintenance fetch is stale', async () => {
    const state = createAppState();
    const calls = {
      fetches: [],
      upserts: [],
      serviceState: [],
    };
    const nowSeconds = Math.floor(Date.now() / 1000);
    const storage = fakeStorage({
      getRealCopyQualityLeaderboard: async () => ({
        ok: true,
        summary: { total: 1, scored: 1, eligible: 1 },
        rows: [],
      }),
      getServiceState: async (key) => {
        if (key === 'maintenance:last_score') {
          return {
            payload: {
              status: 'done',
              scoringStatus: 'done',
              scoredAt: new Date().toISOString(),
              scoredWalletCount: 1,
            },
          };
        }
        return {
          payload: {
            status: 'done',
            finishedAt: new Date(Date.now() - 96 * 60 * 60_000).toISOString(),
            lookbackHours: 48,
          },
        };
      },
      saveServiceState: async (...args) => calls.serviceState.push(args),
      getMaintenanceWallets: async () => ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      withMaintenanceLock: async (callback) => ({ acquired: true, result: await callback() }),
      upsertTrade: async (trade) => {
        calls.upserts.push(trade);
        return { insertedTrade: true };
      },
      getOpenTrades: async () => [],
      evaluateCopyPool: async () => ({ changed: [], snapshot: {} }),
      recalculateRealCopyQuality: async () => ({ ok: true, scored: 1, summary: { total: 1, scored: 1 } }),
    });
    const tracker = createCandidateTracker(state, () => {}, {
      enabled: false,
      maintenanceEnabled: true,
      maintenanceLookbackHours: 48,
      maintenanceStartupCatchupHours: 96,
      maintenanceMaxPagesPerWallet: 2,
      storageFactory: async () => storage,
      fetchDataApiTrades: async (params) => {
        calls.fetches.push(params);
        return params.offset === 0
          ? [rawTrade(72, { timestamp: nowSeconds - 72 * 60 * 60, size: 3_000, price: 0.5 })]
          : [];
      },
    });

    await tracker.start();
    await tracker.close();

    expect(calls.fetches[0]).toMatchObject({
      user: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      filterType: 'CASH',
      filterAmount: 1000,
    });
    expect(calls.upserts).toHaveLength(1);
    expect(calls.serviceState[0]).toEqual([
      'maintenance:last_fetch',
      expect.objectContaining({
        status: 'done',
        lookbackHours: 96,
        maxPagesPerWallet: 4,
        insertedTradeCount: 1,
        scoringStatus: 'skipped',
      }),
    ]);
    expect(calls.serviceState.at(-1)[1]).toMatchObject({
      status: 'done',
      lookbackHours: 96,
      maxPagesPerWallet: 4,
      insertedTradeCount: 1,
      scoringStatus: 'skipped',
    });
  });

  it('runs daily maintenance fetch without scoring while scoring interval is fresh', async () => {
    const state = createAppState();
    const calls = {
      fetches: [],
      upserts: [],
      serviceState: [],
      copyPoolRuns: 0,
      scoringRuns: 0,
    };
    const nowSeconds = Math.floor(Date.now() / 1000);
    const storage = fakeStorage({
      getRealCopyQualityLeaderboard: async () => ({
        ok: true,
        summary: { total: 1, scored: 1, eligible: 1 },
        rows: [],
      }),
      getServiceState: async (key) => {
        if (key === 'maintenance:last_score') {
          return {
            payload: {
              status: 'done',
              scoringStatus: 'done',
              scoredAt: new Date().toISOString(),
              scoredWalletCount: 1,
            },
          };
        }
        return {
          payload: {
            status: 'done',
            finishedAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString(),
            lookbackHours: 48,
          },
        };
      },
      saveServiceState: async (...args) => calls.serviceState.push(args),
      getMaintenanceWallets: async () => ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      withMaintenanceLock: async (callback) => ({ acquired: true, result: await callback() }),
      upsertTrade: async (trade) => {
        calls.upserts.push(trade);
        return { insertedTrade: true };
      },
      getOpenTrades: async () => [],
      evaluateCopyPool: async () => {
        calls.copyPoolRuns += 1;
        return { changed: [], snapshot: {} };
      },
      recalculateRealCopyQuality: async () => {
        calls.scoringRuns += 1;
        return { ok: true, scored: 1, summary: { total: 1, scored: 1 } };
      },
    });
    const tracker = createCandidateTracker(state, () => {}, {
      enabled: false,
      maintenanceEnabled: true,
      maintenanceRunOnStart: false,
      maintenanceIntervalMs: 24 * 60 * 60_000,
      maintenanceScoringIntervalMs: 5 * 24 * 60 * 60_000,
      storageFactory: async () => storage,
      fetchDataApiTrades: async (params) => {
        calls.fetches.push(params);
        if (params.offset > 0) return [];
        return [rawTrade(1, { timestamp: nowSeconds, size: 3_000, price: 0.5 })];
      },
    });

    await tracker.start();
    const summary = await tracker.runMaintenance();
    await tracker.close();

    expect(calls.fetches).toHaveLength(2);
    expect(calls.upserts).toHaveLength(1);
    expect(calls.copyPoolRuns).toBe(0);
    expect(calls.scoringRuns).toBe(0);
    expect(calls.serviceState.map(([key]) => key)).toEqual(['maintenance:last_fetch', 'maintenance:last_run']);
    expect(summary).toMatchObject({
      status: 'done',
      fetchStatus: 'done',
      scoringStatus: 'skipped',
      scoredWalletCount: 1,
    });
    expect(state.service.candidates.maintenanceLastScoredWalletCount).toBe(1);
  });

  it('runs scoring without fetching when only the scoring interval has elapsed', async () => {
    const state = createAppState();
    const calls = {
      fetches: 0,
      serviceState: [],
      copyPoolRuns: 0,
      scoringRuns: 0,
    };
    const storage = fakeStorage({
      getRealCopyQualityLeaderboard: async () => ({
        ok: true,
        summary: { total: 1, scored: 1, eligible: 1 },
        rows: [],
      }),
      getServiceState: async (key) => {
        if (key === 'maintenance:last_score') {
          return {
            payload: {
              status: 'done',
              scoringStatus: 'done',
              scoredAt: new Date(Date.now() - 6 * 24 * 60 * 60_000).toISOString(),
              scoredWalletCount: 1,
            },
          };
        }
        return {
          payload: {
            status: 'done',
            finishedAt: new Date().toISOString(),
            lookbackHours: 48,
          },
        };
      },
      saveServiceState: async (...args) => calls.serviceState.push(args),
      getMaintenanceWallets: async () => {
        throw new Error('fresh fetch should not load wallets');
      },
      withMaintenanceLock: async (callback) => ({ acquired: true, result: await callback() }),
      getOpenTrades: async () => [],
      evaluateCopyPool: async () => {
        calls.copyPoolRuns += 1;
        return { changed: [], snapshot: {} };
      },
      recalculateRealCopyQuality: async () => {
        calls.scoringRuns += 1;
        return { ok: true, scored: 1, summary: { total: 1, scored: 1 } };
      },
    });
    const tracker = createCandidateTracker(state, () => {}, {
      enabled: false,
      maintenanceEnabled: true,
      maintenanceRunOnStart: false,
      maintenanceIntervalMs: 24 * 60 * 60_000,
      maintenanceScoringIntervalMs: 5 * 24 * 60 * 60_000,
      storageFactory: async () => storage,
      fetchDataApiTrades: async () => {
        calls.fetches += 1;
        throw new Error('fresh fetch should not request trades');
      },
    });

    await tracker.start();
    const summary = await tracker.runMaintenance();
    await tracker.close();

    expect(calls.fetches).toBe(0);
    expect(calls.copyPoolRuns).toBe(1);
    expect(calls.scoringRuns).toBe(1);
    expect(calls.serviceState.map(([key]) => key)).toEqual(['maintenance:last_score', 'maintenance:last_run']);
    expect(summary).toMatchObject({
      status: 'done',
      fetchStatus: 'skipped',
      scoringStatus: 'done',
      scoredWalletCount: 1,
    });
  });

  it('scales candidate resolution batches for large due queues', () => {
    expect(resolutionBatchSize({ eligibleOpenTradeCount: 0 })).toBe(250);
    expect(resolutionBatchSize({ eligibleOpenTradeCount: 900 })).toBe(250);
    expect(resolutionBatchSize({ eligibleOpenTradeCount: 20_000 })).toBe(1000);
  });
});
