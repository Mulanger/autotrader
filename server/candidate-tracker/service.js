import {
  AUTO_COPY_POOL_ENABLED,
  AUTO_COPY_POOL_INTERVAL_MS,
  AUTO_COPY_MAX_AEP_CENTS,
  AUTO_COPY_MIN_DISTINCT_MARKETS,
  AUTO_COPY_MIN_WIN_RATE_PCT,
  CANDIDATE_BACKFILL_DAYS,
  CANDIDATE_BACKFILL_MAX_PAGES,
  CANDIDATE_BACKFILL_MAX_OFFSET,
  CANDIDATE_BACKFILL_PAGE_LIMIT,
  CANDIDATE_MAX_USD,
  CANDIDATE_MIN_USD,
  CANDIDATE_POLL_INTERVAL_MS,
  CANDIDATE_POLL_LIMIT,
  CANDIDATE_POLL_MAX_PAGES,
  CANDIDATE_RESOLUTION_BATCH_SIZE,
  CANDIDATE_RESOLUTION_POLL_INTERVAL_MS,
  CANDIDATE_STALE_BACKFILL_MS,
  CANDIDATE_TRACKER_ENABLED,
  WATCHED_WALLETS,
} from '../config.js';
import { ingestTrade } from '../app-state.js';
import { applyCopyPoolSnapshot, defaultCopyPoolThresholds, isWalletWatched } from '../copy-pool.js';
import { fetchGammaResolution } from '../polymarket-client.js';
import { applyShadowTraderSnapshot, isShadowTraderWalletSelected, SHADOW_TRADER_STRATEGY } from '../shadow-trader.js';
import { fetchDataApiTrades, isDataApiOffsetLimitError } from './data-api-client.js';
import { candidateTradeToDemoTrade, normalizeCandidateTrade } from './normalizer.js';
import { buildCandidateSettlement } from './resolution.js';
import { createCandidateStorage } from './storage.js';

export function createCandidateTracker(state, broadcast, options = {}) {
  const enabled = options.enabled ?? CANDIDATE_TRACKER_ENABLED;
  const onStateChanged = options.onStateChanged || (() => {});
  const copyPoolEnabled = options.copyPoolEnabled ?? AUTO_COPY_POOL_ENABLED;
  const storageFactory = options.storageFactory || createCandidateStorage;
  const fetchTrades = options.fetchDataApiTrades || fetchDataApiTrades;
  const copyPoolThresholds = defaultCopyPoolThresholds({
    minDistinctResolvedMarkets: AUTO_COPY_MIN_DISTINCT_MARKETS,
    minWinRatePct: AUTO_COPY_MIN_WIN_RATE_PCT,
    maxAvgEntryPriceCents: AUTO_COPY_MAX_AEP_CENTS,
    windowDays: CANDIDATE_BACKFILL_DAYS,
  });
  let storage = null;
  let started = false;
  let pollTimer = null;
  let backfillTimer = null;
  let resolutionTimer = null;
  let copyPoolTimer = null;
  let pollRunning = false;
  let backfillRunning = false;
  let resolutionRunning = false;
  let copyPoolRunning = false;
  let pollBootstrapped = false;

  state.service.candidates = {
    enabled,
    status: enabled ? 'starting' : 'disabled',
    storageStatus: 'not_started',
    minUsd: CANDIDATE_MIN_USD,
    maxUsd: CANDIDATE_MAX_USD,
    backfillDays: CANDIDATE_BACKFILL_DAYS,
    lastPollAt: null,
    lastPollInserted: 0,
    lastBackfillAt: null,
    lastBackfillWallet: null,
    lastResolutionAt: null,
    lastResolutionChecked: 0,
    lastResolutionSettled: 0,
    lastResolutionBatchSize: 0,
    resolutionQueue: {
      openTradeCount: 0,
      eligibleOpenTradeCount: 0,
      oldestNextResolutionCheckAt: null,
      oldestEligibleTradeTimestamp: null,
    },
    copyPoolEnabled,
    copyPoolStatus: copyPoolEnabled ? 'starting' : 'disabled',
    copyPoolLastRunAt: null,
    copyPoolLastChangedCount: 0,
    copyPoolLastCopiedCount: 0,
    shadowTraderStatus: enabled ? 'starting' : 'disabled',
    shadowTraderStrategy: SHADOW_TRADER_STRATEGY,
    shadowTraderLastRunAt: null,
    shadowTraderSelectedWalletCount: 0,
    shadowTraderLastCopiedCount: 0,
    lastError: null,
  };

  async function start() {
    if (started) return;
    started = true;
    if (!enabled) return;

    try {
      storage = await storageFactory();
      const recoveredBackfills = await storage.recoverStaleBackfills?.(CANDIDATE_STALE_BACKFILL_MS);
      const seededBackfills = await storage.seedActiveCopyPoolBackfill?.(WATCHED_WALLETS);
      state.service.candidates.storageStatus = 'ready';
      state.service.candidates.status = 'ready';
      state.service.candidates.recoveredStaleBackfillCount = recoveredBackfills?.length || 0;
      state.service.candidates.seededActiveCopyPoolBackfillCount = seededBackfills?.length || 0;
      await runCopyPoolEvaluation();
      broadcast();
    } catch (error) {
      state.service.candidates.storageStatus = 'error';
      state.service.candidates.status = 'error';
      state.service.candidates.lastError = error.message;
      broadcast();
      return;
    }

    await runPoll();
    await runBackfill();
    await runResolution();
    await runCopyPoolEvaluation();

    pollTimer = setInterval(runPoll, CANDIDATE_POLL_INTERVAL_MS);
    backfillTimer = setInterval(runBackfill, Math.max(15_000, CANDIDATE_POLL_INTERVAL_MS));
    resolutionTimer = setInterval(runResolution, CANDIDATE_RESOLUTION_POLL_INTERVAL_MS);
    copyPoolTimer = setInterval(runCopyPoolEvaluation, AUTO_COPY_POOL_INTERVAL_MS);
  }

  async function close() {
    clearInterval(pollTimer);
    clearInterval(backfillTimer);
    clearInterval(resolutionTimer);
    clearInterval(copyPoolTimer);
    await storage?.close();
  }

  async function runPoll() {
    if (!storage || pollRunning) return;
    pollRunning = true;
    let inserted = 0;
    let copied = 0;
    let shadowCopied = 0;
    const canCopyNewLiveTrades = pollBootstrapped;
    let completed = false;
    try {
      state.service.candidates.status = 'polling';
      broadcast();

      for (let page = 0; page < CANDIDATE_POLL_MAX_PAGES; page += 1) {
        const offset = page * CANDIDATE_POLL_LIMIT;
        const rawTrades = await fetchTrades({ limit: CANDIDATE_POLL_LIMIT, offset });
        if (!rawTrades.length) break;

        for (const raw of rawTrades.slice().reverse()) {
          const trade = normalizeCandidateTrade(raw, { source: 'live' });
          if (!trade) continue;
          const result = await storage.upsertTrade(trade);
          if (result.insertedTrade) {
            inserted += 1;
            const shadowSelected = isShadowTraderWalletSelected(state, trade.wallet);
            if (canCopyNewLiveTrades && (isWalletWatched(state, trade.wallet) || shadowSelected)) {
              const demoTrade = candidateTradeToDemoTrade(trade);
              const event = demoTrade ? ingestTrade(state, demoTrade, 'candidate-live') : null;
              if (event?.copyDecision?.action === 'copied') copied += 1;
              if (event?.shadowDecision?.action === 'copied') {
                shadowCopied += 1;
              }
            }
          }
        }
      }

      state.service.candidates.status = 'ready';
      state.service.candidates.lastPollAt = new Date().toISOString();
      state.service.candidates.lastPollInserted = inserted;
      state.service.candidates.copyPoolLastCopiedCount = copied;
      state.service.candidates.shadowTraderLastCopiedCount = shadowCopied;
      state.service.candidates.lastError = null;
      if (copied || shadowCopied) onStateChanged();
      completed = true;
      broadcast();
    } catch (error) {
      state.service.candidates.status = 'error';
      state.service.candidates.lastError = error.message;
      broadcast();
    } finally {
      if (completed) pollBootstrapped = true;
      pollRunning = false;
    }
  }

  async function runBackfill() {
    if (!storage || backfillRunning) return;
    backfillRunning = true;
    try {
      const [wallet] = await storage.getQueuedBackfillTraders(1);
      if (!wallet) return;

      state.service.candidates.status = 'backfilling';
      state.service.candidates.lastBackfillWallet = wallet;
      broadcast();
      await storage.markBackfillRunning(wallet);

      const cutoff = new Date(Date.now() - CANDIDATE_BACKFILL_DAYS * 24 * 60 * 60 * 1000);
      let reachedCutoff = false;
      let partialReason = null;
      let inserted = 0;

      for (let page = 0; page < CANDIDATE_BACKFILL_MAX_PAGES && !reachedCutoff; page += 1) {
        const offset = page * CANDIDATE_BACKFILL_PAGE_LIMIT;
        if (offset > CANDIDATE_BACKFILL_MAX_OFFSET) {
          partialReason = `Stopped at Data API offset ${offset}; configured max is ${CANDIDATE_BACKFILL_MAX_OFFSET}`;
          break;
        }

        let rawTrades;
        try {
          rawTrades = await fetchTrades({ user: wallet, limit: CANDIDATE_BACKFILL_PAGE_LIMIT, offset });
        } catch (error) {
          if (page > 0 && isDataApiOffsetLimitError(error)) {
            partialReason = `Stopped after Data API rejected offset ${offset}`;
            break;
          }
          throw error;
        }
        if (!rawTrades.length) break;

        await storage.saveServiceState?.(`backfill:${wallet}`, {
          wallet,
          offset,
          page,
          status: 'running',
          inserted,
          updatedAt: new Date().toISOString(),
        });

        for (const raw of rawTrades.slice().reverse()) {
          const rawTimestamp = toUnixSeconds(raw.timestamp ?? raw.createdAt ?? raw.ts);
          if (rawTimestamp && rawTimestamp * 1000 < cutoff.getTime()) {
            reachedCutoff = true;
            continue;
          }
          const trade = normalizeCandidateTrade(raw, { source: 'backfill' });
          if (!trade) continue;
          const result = await storage.upsertTrade(trade);
          if (result.insertedTrade) inserted += 1;
        }
      }

      await storage.markBackfillComplete(wallet, cutoff.toISOString(), {
        partial: Boolean(partialReason),
        reason: partialReason,
      });
      await storage.saveServiceState?.(`backfill:${wallet}`, {
        wallet,
        status: partialReason ? 'partial' : 'done',
        inserted,
        partialReason,
        updatedAt: new Date().toISOString(),
      });
      await runCopyPoolEvaluation();
      state.service.candidates.status = 'ready';
      state.service.candidates.lastBackfillAt = new Date().toISOString();
      state.service.candidates.lastBackfillInserted = inserted;
      state.service.candidates.lastBackfillPartialReason = partialReason;
      state.service.candidates.lastError = null;
      broadcast();
    } catch (error) {
      state.service.candidates.status = 'error';
      state.service.candidates.lastError = error.message;
      if (state.service.candidates.lastBackfillWallet) {
        await storage.markBackfillFailed(state.service.candidates.lastBackfillWallet, error.message).catch(() => {});
      }
      broadcast();
    } finally {
      backfillRunning = false;
    }
  }

  async function runResolution() {
    if (!storage || resolutionRunning) return;
    resolutionRunning = true;
    let checked = 0;
    let settled = 0;
    try {
      state.service.candidates.status = 'resolving';
      broadcast();
      const queueMetrics = await storage.getResolutionQueueMetrics?.();
      if (queueMetrics) state.service.candidates.resolutionQueue = queueMetrics;
      const batchSize = resolutionBatchSize(queueMetrics);
      state.service.candidates.lastResolutionBatchSize = batchSize;
      const trades = await storage.getOpenTrades(batchSize);

      for (const trade of trades) {
        checked += 1;
        const resolution = await fetchGammaResolution({
          conditionId: trade.conditionId,
          slug: trade.marketSlug,
        });
        const settlement = buildCandidateSettlement(trade, resolution);
        if (settlement) {
          await storage.saveResolvedTrade(trade.id, settlement, {
            ...resolution,
            conditionId: trade.conditionId,
            marketSlug: trade.marketSlug,
          });
          settled += 1;
        } else {
          await storage.markResolutionChecked(trade.id, nextResolutionCheckAt());
        }
      }

      state.service.candidates.status = 'ready';
      state.service.candidates.lastResolutionAt = new Date().toISOString();
      state.service.candidates.lastResolutionChecked = checked;
      state.service.candidates.lastResolutionSettled = settled;
      state.service.candidates.resolutionQueue = (await storage.getResolutionQueueMetrics?.()) || state.service.candidates.resolutionQueue;
      state.service.candidates.lastError = null;
      if (settled) await runCopyPoolEvaluation();
      broadcast();
    } catch (error) {
      state.service.candidates.status = 'error';
      state.service.candidates.lastError = error.message;
      broadcast();
    } finally {
      resolutionRunning = false;
    }
  }

  async function runCopyPoolEvaluation() {
    if (!storage || copyPoolRunning) return;
    if (!copyPoolEnabled) {
      state.service.candidates.copyPoolStatus = 'disabled';
      return;
    }

    copyPoolRunning = true;
    try {
      state.service.candidates.copyPoolStatus = 'evaluating';
      broadcast();
      const result = await storage.evaluateCopyPool({
        baselineWallets: WATCHED_WALLETS,
        thresholds: copyPoolThresholds,
      });
      applyCopyPoolSnapshot(state, result.snapshot);
      const shadowSnapshot = await storage.evaluateShadowTrader?.({
        windowDays: CANDIDATE_BACKFILL_DAYS,
      });
      if (shadowSnapshot) {
        applyShadowTraderSnapshot(state, shadowSnapshot);
        state.service.candidates.shadowTraderStatus = 'ready';
        state.service.candidates.shadowTraderLastRunAt = shadowSnapshot.lastEvaluatedAt;
        state.service.candidates.shadowTraderSelectedWalletCount = shadowSnapshot.selectedWalletCount;
      }
      state.service.candidates.copyPoolStatus = 'ready';
      state.service.candidates.copyPoolLastRunAt = new Date().toISOString();
      state.service.candidates.copyPoolLastChangedCount = result.changed.length;
      state.service.candidates.lastError = null;
      onStateChanged();
      broadcast();
    } catch (error) {
      state.service.candidates.copyPoolStatus = 'error';
      state.service.candidates.lastError = error.message;
      broadcast();
    } finally {
      copyPoolRunning = false;
    }
  }

  async function getLeaderboard(params = {}) {
    if (!enabled) return inactivePayload('disabled');
    if (!storage) return inactivePayload(state.service.candidates.status || 'starting');
    const [rows, summary, copyPool] = await Promise.all([
      storage.getLeaderboard(params),
      storage.getSummary(),
      storage.getCopyPoolSnapshot({ thresholds: copyPoolThresholds }),
    ]);
    return {
      ok: true,
      enabled: true,
      status: state.service.candidates.status,
      updatedAt: new Date().toISOString(),
      summary,
      rows,
      copyPool,
    };
  }

  async function getTrader(wallet, params = {}) {
    if (!enabled || !storage) return null;
    return storage.getTrader(wallet, params);
  }

  return {
    start,
    close,
    getLeaderboard,
    getTrader,
    runPoll,
    runBackfill,
    runResolution,
    runCopyPoolEvaluation,
  };
}

function inactivePayload(status) {
  return {
    ok: true,
    enabled: false,
    status,
    updatedAt: new Date().toISOString(),
    summary: {
      traderCount: 0,
      tradeCount: 0,
      openTradeCount: 0,
      resolvedTradeCount: 0,
      queuedBackfillCount: 0,
      runningBackfillCount: 0,
    },
    rows: [],
  };
}

function nextResolutionCheckAt() {
  return new Date(Date.now() + 5 * 60 * 1000).toISOString();
}

export function resolutionBatchSize(queueMetrics = {}) {
  const eligible = Number(queueMetrics?.eligibleOpenTradeCount || 0);
  const dynamic = eligible ? Math.ceil(eligible / 10) : CANDIDATE_RESOLUTION_BATCH_SIZE;
  return Math.min(1_000, Math.max(CANDIDATE_RESOLUTION_BATCH_SIZE, dynamic));
}

function toUnixSeconds(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}
