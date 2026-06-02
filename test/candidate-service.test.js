import { describe, expect, it } from 'vitest';
import { createAppState } from '../server/app-state.js';
import { createCandidateTracker, resolutionBatchSize } from '../server/candidate-tracker/service.js';
import { applyShadowTraderSnapshot } from '../server/shadow-trader.js';

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

  it('reuses the real copy quality leaderboard query briefly between page loads', async () => {
    const state = createAppState();
    let queryCount = 0;
    const storage = fakeStorage({
      getRealCopyQualityLeaderboard: async () => {
        queryCount += 1;
        return {
          ok: true,
          summary: { total: 1, scored: 1, eligible: 1 },
          rows: [{ wallet: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', score: 91 }],
        };
      },
    });
    const tracker = createCandidateTracker(state, () => {}, {
      enabled: false,
      storageFactory: async () => storage,
      fetchDataApiTrades: async () => [],
      realCopyQualityLeaderboardCacheMs: 60_000,
    });

    await tracker.start();
    queryCount = 0;
    const first = await tracker.getRealCopyQualityLeaderboard({ eligible: true, sort: 'expectedProfit' });
    const second = await tracker.getRealCopyQualityLeaderboard({ eligible: true, sort: 'expectedProfit' });
    await tracker.close();

    expect(queryCount).toBe(1);
    expect(first.cacheHit).toBeUndefined();
    expect(second.cacheHit).toBe(true);
    expect(second.rows).toHaveLength(1);
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
      getMaintenanceWallets: async ({ scope, baselineWallets, observedLimit }) => {
        calls.scope = scope;
        calls.baselineCount = baselineWallets.length;
        calls.observedLimit = observedLimit;
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
      maintenanceObservedLimit: 11,
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
    expect(calls.scope).toBe('followed_plus_top');
    expect(calls.baselineCount).toBeGreaterThan(0);
    expect(calls.observedLimit).toBe(11);
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
    expect(calls.copyPoolRuns).toBe(0);
    expect(calls.scoringScopes).toEqual(['followed_plus_top']);
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

  it('stops maintenance wallet fetches at the configured request budget', async () => {
    const state = createAppState();
    const calls = { fetches: [] };
    const nowSeconds = Math.floor(Date.now() / 1000);
    const storage = fakeStorage({
      getRealCopyQualityLeaderboard: async () => ({
        ok: true,
        summary: { total: 0, scored: 0, eligible: 0 },
        rows: [],
      }),
      getServiceState: async () => null,
      saveServiceState: async () => {},
      getMaintenanceWallets: async () => [
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      ],
      withMaintenanceLock: async (callback) => ({ acquired: true, result: await callback() }),
      upsertTrade: async () => ({ insertedTrade: true }),
      getOpenTrades: async () => [],
      evaluateCopyPool: async () => ({ changed: [], snapshot: {} }),
      recalculateRealCopyQuality: async () => ({ ok: true, scored: 0, summary: { total: 0, scored: 0 } }),
    });
    const tracker = createCandidateTracker(state, () => {}, {
      enabled: false,
      maintenanceEnabled: true,
      maintenanceRunOnStart: false,
      maintenanceRequestBudget: 2,
      maintenancePageLimit: 2,
      maintenanceMaxPagesPerWallet: 4,
      shadowPollingEnabled: false,
      copyPoolEnabled: false,
      storageFactory: async () => storage,
      fetchDataApiTrades: async (params) => {
        calls.fetches.push(params);
        return [
          rawTrade(calls.fetches.length, { proxyWallet: params.user, timestamp: nowSeconds, size: 3_000, price: 0.5 }),
        ];
      },
    });

    await tracker.start();
    const summary = await tracker.runMaintenance({ force: true });
    await tracker.close();

    expect(calls.fetches).toHaveLength(2);
    expect(calls.fetches.every((call) => call.user && !call.side)).toBe(true);
    expect(summary.requestBudget).toBe(2);
    expect(summary.requestBudgetExhausted).toBe(true);
    expect(summary.requestCount).toBe(2);
    expect(state.service.candidates.maintenanceLastRequestBudgetExhausted).toBe(true);
  });

  it('observes selected shadow wallets during maintenance fetches', async () => {
    const state = createAppState();
    const wallet = '0xcccccccccccccccccccccccccccccccccccccccc';
    const nowSeconds = Math.floor(Date.now() / 1000);
    applyShadowTraderSnapshot(state, {
      lastEvaluatedAt: new Date((nowSeconds - 60 * 60) * 1000).toISOString(),
      selectedWallets: {
        [wallet]: { wallet, status: 'active', shadowRank: 1, expectedCopyProfitUsd: 1.5 },
      },
    });

    const calls = { fetches: [], upserts: [] };
    const storage = fakeStorage({
      getRealCopyQualityLeaderboard: async () => ({
        ok: true,
        summary: { total: 0, scored: 0, eligible: 0 },
        rows: [],
      }),
      getServiceState: async () => null,
      saveServiceState: async () => {},
      getMaintenanceWallets: async () => [],
      withMaintenanceLock: async (callback) => ({ acquired: true, result: await callback() }),
      upsertTrade: async (trade) => {
        calls.upserts.push(trade);
        return { insertedTrade: false };
      },
      recalculateRealCopyQuality: async () => ({ ok: true, scored: 0, summary: { scored: 0 } }),
    });
    const tracker = createCandidateTracker(state, () => {}, {
      enabled: false,
      maintenanceEnabled: true,
      maintenanceRunOnStart: false,
      shadowPollingEnabled: false,
      maintenancePageLimit: 10,
      copyPoolEnabled: false,
      storageFactory: async () => storage,
      fetchDataApiTrades: async (params) => {
        calls.fetches.push(params);
        if (params.offset > 0) return [];
        return [
          rawTrade(20, { proxyWallet: wallet, timestamp: nowSeconds, price: 0.5, size: 3_000 }),
          rawTrade(21, { proxyWallet: wallet, timestamp: nowSeconds - 2 * 60 * 60, price: 0.5, size: 3_000 }),
        ];
      },
    });

    await tracker.start();
    const summary = await tracker.runMaintenance({ force: true });
    await tracker.close();

    expect(calls.fetches.map((call) => [call.user, call.offset])).toEqual([[wallet, 0], [wallet, 10]]);
    expect(calls.upserts).toHaveLength(2);
    expect(summary.shadowSelectedWalletCount).toBe(1);
    expect(summary.shadowObservedTradeCount).toBe(1);
    expect(summary.shadowCopiedTradeCount).toBe(1);
    expect(state.shadowTrader.feed).toHaveLength(1);
    expect(state.shadowTrader.feed[0].source).toBe('shadow-maintenance');
    expect(state.shadowTrader.portfolio.openPositions).toHaveLength(1);
  });

  it('polls only selected shadow wallets while global candidate polling is disabled', async () => {
    const state = createAppState();
    state.watchedWallets = [];
    const walletA = '0xcccccccccccccccccccccccccccccccccccccccc';
    const walletB = '0xdddddddddddddddddddddddddddddddddddddddd';
    const nowSeconds = Math.floor(Date.now() / 1000);
    const selectedAt = new Date((nowSeconds - 60 * 60) * 1000).toISOString();
    applyShadowTraderSnapshot(state, {
      lastEvaluatedAt: selectedAt,
      selectedWallets: {
        [walletA]: { wallet: walletA, status: 'active', selectedAt, shadowRank: 1 },
        [walletB]: { wallet: walletB, status: 'active', selectedAt, shadowRank: 2 },
      },
    });

    const calls = { fetches: [], upserts: [] };
    const storage = fakeStorage({
      getRealCopyQualityLeaderboard: async () => ({ ok: true, summary: { total: 0, scored: 0, eligible: 0 }, rows: [] }),
      getServiceState: async () => null,
      upsertTrade: async (trade) => {
        calls.upserts.push(trade);
        return { insertedTrade: true };
      },
    });
    const tracker = createCandidateTracker(state, () => {}, {
      enabled: false,
      maintenanceEnabled: false,
      shadowPollingEnabled: true,
      shadowRunOnStart: false,
      shadowPollLimit: 5,
      setInterval: () => 'shadow-timer',
      clearInterval: () => {},
      copyPoolEnabled: false,
      storageFactory: async () => storage,
      fetchDataApiTrades: async (params) => {
        calls.fetches.push(params);
        if (params.user === walletA) {
          return [rawTrade(30, { proxyWallet: walletA, timestamp: nowSeconds, price: 0.5, size: 3_000 })];
        }
        if (params.user === walletB) {
          return [rawTrade(31, { proxyWallet: walletB, timestamp: nowSeconds, price: 0.5, size: 3_000 })];
        }
        throw new Error(`unexpected wallet ${params.user}`);
      },
    });

    await tracker.start();
    const summary = await tracker.runShadowPoll();
    await tracker.close();

    expect(state.service.candidates.status).toBe('disabled');
    expect(state.service.candidates.shadowPollingEnabled).toBe(true);
    expect(calls.fetches.map((call) => call.user)).toEqual([walletA, walletB]);
    expect(calls.fetches.every((call) => call.side === 'BUY')).toBe(true);
    expect(calls.fetches.every((call) => call.limit === 5)).toBe(true);
    expect(calls.fetches.every((call) => call.filterType === 'CASH' && call.filterAmount === 1000)).toBe(true);
    expect(summary).toMatchObject({ ok: true, walletCount: 2, checked: 2, copied: 2 });
    expect(calls.upserts).toHaveLength(2);
    expect(state.shadowTrader.feed).toHaveLength(2);
    expect(state.shadowTrader.portfolio.openPositions).toHaveLength(2);
  });

  it('ignores selected shadow wallet trades before selectedAt', async () => {
    const state = createAppState();
    state.watchedWallets = [];
    const wallet = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const nowSeconds = Math.floor(Date.now() / 1000);
    const selectedAt = new Date((nowSeconds - 60 * 60) * 1000).toISOString();
    applyShadowTraderSnapshot(state, {
      lastEvaluatedAt: selectedAt,
      selectedWallets: {
        [wallet]: { wallet, status: 'active', selectedAt, shadowRank: 1 },
      },
    });

    const storage = fakeStorage({
      getRealCopyQualityLeaderboard: async () => ({ ok: true, summary: { total: 0, scored: 0, eligible: 0 }, rows: [] }),
      getServiceState: async () => null,
    });
    const tracker = createCandidateTracker(state, () => {}, {
      enabled: false,
      maintenanceEnabled: false,
      shadowPollingEnabled: true,
      shadowRunOnStart: false,
      setInterval: () => 'shadow-timer',
      clearInterval: () => {},
      copyPoolEnabled: false,
      storageFactory: async () => storage,
      fetchDataApiTrades: async () => [
        rawTrade(40, { proxyWallet: wallet, timestamp: nowSeconds - 2 * 60 * 60, price: 0.5, size: 3_000 }),
      ],
    });

    await tracker.start();
    const summary = await tracker.runShadowPoll();
    await tracker.close();

    expect(summary).toMatchObject({ ok: true, walletCount: 1, checked: 0, copied: 0, skippedOld: 1 });
    expect(state.service.candidates.shadowLastPollChecked).toBe(0);
    expect(state.service.candidates.shadowLastPollCopied).toBe(0);
    expect(state.shadowTrader.feed).toHaveLength(0);
    expect(state.shadowTrader.portfolio.openPositions).toHaveLength(0);
  });

  it('paper-copies new selected-wallet BUY trades without creating real follows or orders', async () => {
    const state = createAppState();
    state.watchedWallets = [];
    const wallet = '0xffffffffffffffffffffffffffffffffffffffff';
    const nowSeconds = Math.floor(Date.now() / 1000);
    const selectedAt = new Date((nowSeconds - 60 * 60) * 1000).toISOString();
    applyShadowTraderSnapshot(state, {
      lastEvaluatedAt: selectedAt,
      selectedWallets: {
        [wallet]: { wallet, status: 'active', selectedAt, shadowRank: 1 },
      },
    });

    const storage = fakeStorage({
      getRealCopyQualityLeaderboard: async () => ({ ok: true, summary: { total: 0, scored: 0, eligible: 0 }, rows: [] }),
      getServiceState: async () => null,
    });
    const tracker = createCandidateTracker(state, () => {}, {
      enabled: false,
      maintenanceEnabled: false,
      shadowPollingEnabled: true,
      shadowRunOnStart: false,
      setInterval: () => 'shadow-timer',
      clearInterval: () => {},
      copyPoolEnabled: false,
      storageFactory: async () => storage,
      fetchDataApiTrades: async () => [
        rawTrade(50, { proxyWallet: wallet, timestamp: nowSeconds, price: 0.5, size: 3_000 }),
      ],
    });

    await tracker.start();
    const summary = await tracker.runShadowPoll();
    await tracker.close();

    expect(summary).toMatchObject({ ok: true, walletCount: 1, checked: 1, copied: 1 });
    expect(state.shadowTrader.feed).toHaveLength(1);
    expect(state.shadowTrader.feed[0].source).toBe('shadow-live');
    expect(state.shadowTrader.feed[0].shadowDecision.action).toBe('copied');
    expect(state.shadowTrader.portfolio.openPositions).toHaveLength(1);
    expect(state.real.follows).toHaveLength(0);
    expect(state.real.orders).toHaveLength(0);
    expect(state.real.positions).toHaveLength(0);
  });

  it('does not fetch selected shadow wallets when shadow polling is disabled', async () => {
    const state = createAppState();
    const wallet = '0xcccccccccccccccccccccccccccccccccccccccc';
    applyShadowTraderSnapshot(state, {
      selectedWallets: {
        [wallet]: { wallet, status: 'active', selectedAt: new Date().toISOString(), shadowRank: 1 },
      },
    });
    const storage = fakeStorage({
      getRealCopyQualityLeaderboard: async () => ({ ok: true, summary: { total: 0, scored: 0, eligible: 0 }, rows: [] }),
    });
    let fetchCount = 0;
    const tracker = createCandidateTracker(state, () => {}, {
      enabled: false,
      maintenanceEnabled: false,
      shadowPollingEnabled: false,
      copyPoolEnabled: false,
      storageFactory: async () => storage,
      fetchDataApiTrades: async () => {
        fetchCount += 1;
        return [];
      },
    });

    await tracker.start();
    const summary = await tracker.runShadowPoll();
    await tracker.close();

    expect(summary).toMatchObject({ ok: true, status: 'disabled', checked: 0, copied: 0 });
    expect(fetchCount).toBe(0);
    expect(state.service.candidates.shadowPollStatus).toBe('disabled');
  });

  it('does not run legacy copy-pool promotion when copy-pool evaluation is disabled', async () => {
    const state = createAppState();
    let evaluateCount = 0;
    const storage = fakeStorage({
      getRealCopyQualityLeaderboard: async () => ({ ok: true, summary: { total: 0, scored: 0, eligible: 0 }, rows: [] }),
      evaluateCopyPool: async () => {
        evaluateCount += 1;
        throw new Error('copy pool should be disabled');
      },
    });
    const tracker = createCandidateTracker(state, () => {}, {
      enabled: false,
      maintenanceEnabled: false,
      shadowPollingEnabled: false,
      copyPoolEnabled: false,
      storageFactory: async () => storage,
      fetchDataApiTrades: async () => [],
    });

    await tracker.start();
    await tracker.runCopyPoolEvaluation();
    await tracker.close();

    expect(evaluateCount).toBe(0);
    expect(state.service.candidates.copyPoolStatus).toBe('disabled');
  });

  it('runs bounded discovery while global candidate polling is disabled', async () => {
    const state = createAppState();
    const walletA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const walletB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const nowSeconds = Math.floor(Date.now() / 1000);
    const calls = {
      fetches: [],
      discoveryUpserts: [],
      normalUpserts: 0,
      signals: [],
      marks: [],
      scoringWallets: [],
      serviceState: [],
      locked: false,
    };
    const storage = fakeStorage({
      getRealCopyQualityLeaderboard: async () => ({ ok: true, summary: { total: 0, scored: 0, eligible: 0 }, rows: [] }),
      getServiceState: async () => null,
      saveServiceState: async (...args) => calls.serviceState.push(args),
      withMaintenanceLock: async (callback) => {
        calls.locked = true;
        return { acquired: true, result: await callback() };
      },
      upsertTrade: async () => {
        calls.normalUpserts += 1;
        throw new Error('discovery should not use queued backfill upsert');
      },
      upsertDiscoveryTrade: async (trade) => {
        calls.discoveryUpserts.push(trade);
        return { insertedTrade: true, newTrader: true };
      },
      saveDiscoverySignals: async (signals) => {
        calls.signals.push(...signals);
        return signals.map((signal) => signal.wallet);
      },
      markDiscoveryWallets: async (wallets, status, options) => {
        calls.marks.push({ wallets, status, options });
        return wallets;
      },
      recalculateRealCopyQuality: async ({ wallet }) => {
        calls.scoringWallets.push(wallet);
        return { ok: true, scored: 1, summary: { total: 1, scored: 1, eligible: 1 } };
      },
      getRealCopyQualityScore: async (wallet) => ({
        wallet,
        eligible: true,
        copyableResolvedMarkets30d: 24,
        copyablePnlTradeCount30d: 24,
        copyableWinCount30d: 16,
      }),
    });
    const tracker = createCandidateTracker(state, () => {}, {
      enabled: false,
      maintenanceEnabled: false,
      discoveryEnabled: true,
      discoveryRunOnStart: false,
      discoveryGlobalPages: 2,
      discoveryMaxStage1Wallets: 1,
      discoveryMaxDeepBackfills: 1,
      discoveryRequestBudget: 5,
      maintenancePageLimit: 2,
      shadowPollingEnabled: false,
      copyPoolEnabled: false,
      storageFactory: async () => storage,
      fetchDataApiTrades: async (params) => {
        calls.fetches.push(params);
        if (!params.user && params.offset === 0) {
          return [
            rawTrade(1, { proxyWallet: walletA, conditionId: 'a-1', eventSlug: 'event-a', timestamp: nowSeconds, price: 0.5 }),
            rawTrade(2, { proxyWallet: walletA, conditionId: 'a-2', eventSlug: 'event-b', timestamp: nowSeconds, price: 0.55 }),
            rawTrade(3, { proxyWallet: walletB, conditionId: 'b-1', eventSlug: 'event-c', timestamp: nowSeconds, price: 0.5 }),
          ];
        }
        if (!params.user && params.offset === 500) return [];
        if (params.user === walletA && params.offset === 0) {
          return [
            rawTrade(4, { proxyWallet: walletA, conditionId: 'a-3', eventSlug: 'event-a', timestamp: nowSeconds, price: 0.5 }),
            rawTrade(5, { proxyWallet: walletA, conditionId: 'a-4', eventSlug: 'event-b', timestamp: nowSeconds, price: 0.55 }),
          ];
        }
        if (params.user === walletA && params.offset === 2) return [];
        throw new Error(`unexpected fetch ${JSON.stringify(params)}`);
      },
    });

    await tracker.start();
    const summary = await tracker.runDiscovery({ force: true });
    await tracker.close();

    expect(state.service.candidates.status).toBe('disabled');
    expect(calls.locked).toBe(true);
    expect(calls.normalUpserts).toBe(0);
    expect(calls.fetches.slice(0, 2)).toEqual([
      expect.objectContaining({ side: 'BUY', filterType: 'CASH', filterAmount: 1000, offset: 0 }),
      expect.objectContaining({ side: 'BUY', filterType: 'CASH', filterAmount: 1000, offset: 500 }),
    ]);
    expect(calls.fetches.length).toBeLessThanOrEqual(5);
    expect(calls.fetches.filter((call) => !call.user)).toHaveLength(2);
    expect(calls.fetches.filter((call) => call.user === walletA)).toHaveLength(3);
    expect(calls.discoveryUpserts.every((trade) => trade.source.startsWith('discovery'))).toBe(true);
    expect(calls.signals.map((signal) => signal.wallet)).toContain(walletA);
    expect(calls.marks.map((mark) => mark.status)).toEqual(['stage1_promoted', 'deep_promoted', 'scored']);
    expect(calls.scoringWallets).toEqual([walletA]);
    expect(calls.serviceState.at(-1)).toEqual([
      'discovery:last_run',
      expect.objectContaining({
        status: 'done',
        requestBudget: 5,
        requestCount: 5,
        walletsSeen: 2,
        stage1Promoted: 1,
        deepPromoted: 1,
        scored: 1,
      }),
    ]);
    expect(summary).toMatchObject({
      ok: true,
      status: 'done',
      requestBudget: 5,
      requestCount: 5,
      walletsSeen: 2,
      stage1Promoted: 1,
      deepPromoted: 1,
      scored: 1,
    });
    expect(state.real.follows).toHaveLength(0);
    expect(state.real.orders).toHaveLength(0);
    expect(state.real.positions).toHaveLength(0);
  });

  it('stops discovery at the configured request budget', async () => {
    const state = createAppState();
    const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const nowSeconds = Math.floor(Date.now() / 1000);
    const calls = { fetches: [], marks: [] };
    const storage = fakeStorage({
      getRealCopyQualityLeaderboard: async () => ({ ok: true, summary: { total: 0, scored: 0, eligible: 0 }, rows: [] }),
      getServiceState: async () => null,
      saveServiceState: async () => {},
      withMaintenanceLock: async (callback) => ({ acquired: true, result: await callback() }),
      upsertDiscoveryTrade: async () => ({ insertedTrade: true }),
      saveDiscoverySignals: async (signals) => signals.map((signal) => signal.wallet),
      markDiscoveryWallets: async (wallets, status) => {
        calls.marks.push({ wallets, status });
        return wallets;
      },
      recalculateRealCopyQuality: async () => {
        throw new Error('budgeted discovery should not reach scoring');
      },
    });
    const tracker = createCandidateTracker(state, () => {}, {
      enabled: false,
      maintenanceEnabled: false,
      discoveryEnabled: true,
      discoveryRunOnStart: false,
      discoveryGlobalPages: 5,
      discoveryMaxStage1Wallets: 5,
      discoveryMaxDeepBackfills: 5,
      discoveryRequestBudget: 2,
      maintenancePageLimit: 2,
      shadowPollingEnabled: false,
      copyPoolEnabled: false,
      storageFactory: async () => storage,
      fetchDataApiTrades: async (params) => {
        calls.fetches.push(params);
        if (!params.user) {
          return [
            rawTrade(10 + params.offset, { proxyWallet: wallet, conditionId: `m-${params.offset}`, eventSlug: 'event-a', timestamp: nowSeconds, price: 0.5 }),
            rawTrade(11 + params.offset, { proxyWallet: wallet, conditionId: `n-${params.offset}`, eventSlug: 'event-b', timestamp: nowSeconds, price: 0.55 }),
          ];
        }
        throw new Error('wallet fetch should be skipped after budget is spent');
      },
    });

    await tracker.start();
    const summary = await tracker.runDiscovery({ force: true });
    await tracker.close();

    expect(calls.fetches).toHaveLength(2);
    expect(calls.fetches.every((call) => !call.user && call.side === 'BUY')).toBe(true);
    expect(summary.requestCount).toBe(2);
    expect(summary.deepPromoted).toBe(0);
    expect(summary.scored).toBe(0);
    expect(calls.marks.map((mark) => mark.status)).toEqual(['stage1_promoted', 'rejected']);
  });

  it('does not reprocess discovery wallets that storage keeps on cooldown', async () => {
    const state = createAppState();
    const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const nowSeconds = Math.floor(Date.now() / 1000);
    const calls = { fetches: [], marks: [] };
    const storage = fakeStorage({
      getRealCopyQualityLeaderboard: async () => ({ ok: true, summary: { total: 0, scored: 0, eligible: 0 }, rows: [] }),
      getServiceState: async () => null,
      saveServiceState: async () => {},
      withMaintenanceLock: async (callback) => ({ acquired: true, result: await callback() }),
      upsertDiscoveryTrade: async () => ({ insertedTrade: true }),
      saveDiscoverySignals: async () => [],
      markDiscoveryWallets: async (wallets, status) => {
        calls.marks.push({ wallets, status });
        return wallets;
      },
      recalculateRealCopyQuality: async () => {
        throw new Error('cooldown wallet should not be scored');
      },
    });
    const tracker = createCandidateTracker(state, () => {}, {
      enabled: false,
      maintenanceEnabled: false,
      discoveryEnabled: true,
      discoveryRunOnStart: false,
      discoveryGlobalPages: 1,
      discoveryMaxStage1Wallets: 5,
      discoveryMaxDeepBackfills: 5,
      discoveryRequestBudget: 10,
      maintenancePageLimit: 2,
      shadowPollingEnabled: false,
      copyPoolEnabled: false,
      storageFactory: async () => storage,
      fetchDataApiTrades: async (params) => {
        calls.fetches.push(params);
        if (!params.user) {
          return [
            rawTrade(20, { proxyWallet: wallet, conditionId: 'cooldown-1', eventSlug: 'event-a', timestamp: nowSeconds, price: 0.5 }),
            rawTrade(21, { proxyWallet: wallet, conditionId: 'cooldown-2', eventSlug: 'event-b', timestamp: nowSeconds, price: 0.55 }),
          ];
        }
        throw new Error('cooldown wallet should not be backfilled');
      },
    });

    await tracker.start();
    const summary = await tracker.runDiscovery({ force: true });
    await tracker.close();

    expect(calls.fetches).toHaveLength(1);
    expect(calls.fetches[0].user).toBeUndefined();
    expect(calls.marks).toHaveLength(0);
    expect(summary.stage1Promoted).toBe(0);
    expect(summary.deepPromoted).toBe(0);
    expect(summary.scored).toBe(0);
  });

  it('only deep-backfills discovery wallets returned by storage after known-wallet dedup', async () => {
    const state = createAppState();
    const knownWallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const newWallet = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const nowSeconds = Math.floor(Date.now() / 1000);
    const calls = { fetches: [], marks: [], scoringWallets: [] };
    const storage = fakeStorage({
      getRealCopyQualityLeaderboard: async () => ({ ok: true, summary: { total: 0, scored: 0, eligible: 0 }, rows: [] }),
      getServiceState: async () => null,
      saveServiceState: async () => {},
      withMaintenanceLock: async (callback) => ({ acquired: true, result: await callback() }),
      upsertDiscoveryTrade: async () => ({ insertedTrade: true }),
      saveDiscoverySignals: async () => [newWallet],
      markDiscoveryWallets: async (wallets, status) => {
        calls.marks.push({ wallets, status });
        return wallets;
      },
      recalculateRealCopyQuality: async ({ wallet }) => {
        calls.scoringWallets.push(wallet);
        return { ok: true, scored: 1, summary: { total: 1, scored: 1, eligible: 1 } };
      },
      getRealCopyQualityScore: async (wallet) => ({
        wallet,
        eligible: true,
        copyableResolvedMarkets30d: 24,
        copyablePnlTradeCount30d: 24,
        copyableWinCount30d: 16,
      }),
    });
    const tracker = createCandidateTracker(state, () => {}, {
      enabled: false,
      maintenanceEnabled: false,
      discoveryEnabled: true,
      discoveryRunOnStart: false,
      discoveryGlobalPages: 1,
      discoveryMaxStage1Wallets: 10,
      discoveryMaxDeepBackfills: 10,
      discoveryRequestBudget: 10,
      maintenancePageLimit: 2,
      shadowPollingEnabled: false,
      copyPoolEnabled: false,
      storageFactory: async () => storage,
      fetchDataApiTrades: async (params) => {
        calls.fetches.push(params);
        if (!params.user) {
          return [
            rawTrade(30, { proxyWallet: knownWallet, conditionId: 'known-1', eventSlug: 'event-a', timestamp: nowSeconds, price: 0.5 }),
            rawTrade(31, { proxyWallet: knownWallet, conditionId: 'known-2', eventSlug: 'event-b', timestamp: nowSeconds, price: 0.55 }),
            rawTrade(32, { proxyWallet: newWallet, conditionId: 'new-1', eventSlug: 'event-a', timestamp: nowSeconds, price: 0.5 }),
            rawTrade(33, { proxyWallet: newWallet, conditionId: 'new-2', eventSlug: 'event-b', timestamp: nowSeconds, price: 0.55 }),
          ];
        }
        if (params.user === newWallet) {
          return params.offset === 0
            ? [
                rawTrade(34, { proxyWallet: newWallet, conditionId: 'new-3', eventSlug: 'event-a', timestamp: nowSeconds, price: 0.5 }),
                rawTrade(35, { proxyWallet: newWallet, conditionId: 'new-4', eventSlug: 'event-b', timestamp: nowSeconds, price: 0.55 }),
              ]
            : [];
        }
        throw new Error(`known wallet should not be backfilled: ${JSON.stringify(params)}`);
      },
    });

    await tracker.start();
    const summary = await tracker.runDiscovery({ force: true });
    await tracker.close();

    expect(calls.fetches.some((call) => call.user === knownWallet)).toBe(false);
    expect(calls.fetches.some((call) => call.user === newWallet)).toBe(true);
    expect(calls.scoringWallets).toEqual([newWallet]);
    expect(calls.marks.map((mark) => mark.status)).toEqual(['stage1_promoted', 'deep_promoted', 'scored']);
    expect(summary).toMatchObject({
      walletsSeen: 2,
      walletsHeld: 1,
      stage1Promoted: 1,
      deepPromoted: 1,
      scored: 1,
    });
  });

  it('observes promising discovery wallets that are not scoreable yet', async () => {
    const state = createAppState();
    const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const nowSeconds = Math.floor(Date.now() / 1000);
    const calls = { marks: [] };
    const storage = fakeStorage({
      getRealCopyQualityLeaderboard: async () => ({ ok: true, summary: { total: 0, scored: 0, eligible: 0 }, rows: [] }),
      getServiceState: async () => null,
      saveServiceState: async () => {},
      withMaintenanceLock: async (callback) => ({ acquired: true, result: await callback() }),
      upsertDiscoveryTrade: async () => ({ insertedTrade: true }),
      saveDiscoverySignals: async (signals) => signals.map((signal) => signal.wallet),
      markDiscoveryWallets: async (wallets, status, options) => {
        calls.marks.push({ wallets, status, options });
        return wallets;
      },
      recalculateRealCopyQuality: async () => ({ ok: true, scored: 1, summary: { total: 1, scored: 1, eligible: 0 } }),
      getRealCopyQualityScore: async () => ({
        wallet,
        eligible: false,
        reason: 'too_few_copyable_markets, too_few_copyable_wins',
        copyableResolvedMarkets30d: 5,
        copyablePnlTradeCount30d: 5,
        copyableWinCount30d: 2,
      }),
    });
    const tracker = createCandidateTracker(state, () => {}, {
      enabled: false,
      maintenanceEnabled: false,
      discoveryEnabled: true,
      discoveryRunOnStart: false,
      discoveryGlobalPages: 1,
      discoveryMaxStage1Wallets: 1,
      discoveryMaxDeepBackfills: 1,
      discoveryRequestBudget: 10,
      discoveryObserveIntervalMs: 60_000,
      maintenancePageLimit: 2,
      shadowPollingEnabled: false,
      copyPoolEnabled: false,
      storageFactory: async () => storage,
      fetchDataApiTrades: async (params) => {
        if (!params.user) {
          return [
            rawTrade(40, { proxyWallet: wallet, conditionId: 'thin-1', eventSlug: 'event-a', timestamp: nowSeconds, price: 0.5 }),
            rawTrade(41, { proxyWallet: wallet, conditionId: 'thin-2', eventSlug: 'event-b', timestamp: nowSeconds, price: 0.55 }),
          ];
        }
        if (params.user === wallet) {
          return params.offset === 0
            ? [
                rawTrade(42, { proxyWallet: wallet, conditionId: 'thin-3', eventSlug: 'event-a', timestamp: nowSeconds, price: 0.5 }),
                rawTrade(43, { proxyWallet: wallet, conditionId: 'thin-4', eventSlug: 'event-b', timestamp: nowSeconds, price: 0.55 }),
              ]
            : [];
        }
        throw new Error(`unexpected fetch ${JSON.stringify(params)}`);
      },
    });

    await tracker.start();
    const summary = await tracker.runDiscovery({ force: true });
    await tracker.close();

    expect(calls.marks.map((mark) => mark.status)).toEqual(['stage1_promoted', 'deep_promoted', 'observe']);
    expect(calls.marks.at(-1).options).toEqual(expect.objectContaining({
      rejectReason: 'Promising signal, waiting for more resolved markets',
      cooldownUntil: expect.any(String),
    }));
    expect(summary).toMatchObject({
      scored: 0,
      observed: 1,
      rejected: 0,
    });
    expect(state.service.candidates.discoveryLastObserved).toBe(1);
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
    expect(calls.copyPoolRuns).toBe(0);
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
