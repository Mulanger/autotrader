import {
  AUTO_COPY_POOL_ENABLED,
  AUTO_COPY_POOL_INTERVAL_MS,
  AUTO_COPY_MAX_AEP_CENTS,
  AUTO_COPY_MIN_DISTINCT_MARKETS,
  AUTO_COPY_MIN_WIN_RATE_PCT,
  CANDIDATE_ACCEPTED_HISTORY_DAYS,
  CANDIDATE_BACKFILL_DAYS,
  CANDIDATE_BACKFILL_MAX_PAGES,
  CANDIDATE_BACKFILL_MAX_OFFSET,
  CANDIDATE_BACKFILL_PAGE_LIMIT,
  CANDIDATE_MAINTENANCE_ENABLED,
  CANDIDATE_MAINTENANCE_INTERVAL_MS,
  CANDIDATE_MAINTENANCE_LOOKBACK_HOURS,
  CANDIDATE_MAINTENANCE_MAX_PAGES_PER_WALLET,
  CANDIDATE_MAINTENANCE_PAGE_LIMIT,
  CANDIDATE_MAINTENANCE_RESOLUTION_MAX_TRADES,
  CANDIDATE_MAINTENANCE_SCORING_INTERVAL_MS,
  CANDIDATE_MAINTENANCE_SCOPE,
  CANDIDATE_MAINTENANCE_STARTUP_CATCHUP_HOURS,
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
import { applyCopyPoolSnapshot, defaultCopyPoolThresholds, isWalletWatched, normalizeWallet } from '../copy-pool.js';
import { fetchGammaResolution } from '../polymarket-client.js';
import { applyShadowTraderSnapshot, isShadowTraderWalletSelected, SHADOW_TRADER_STRATEGY } from '../shadow-trader.js';
import { fetchDataApiTrades, isDataApiOffsetLimitError } from './data-api-client.js';
import { candidateTradeToDemoTrade, normalizeCandidateTrade } from './normalizer.js';
import { buildCandidateSettlement } from './resolution.js';
import { createCandidateStorage } from './storage.js';

const MAINTENANCE_STATE_KEY = 'maintenance:last_run';
const MAINTENANCE_FETCH_STATE_KEY = 'maintenance:last_fetch';
const MAINTENANCE_SCORING_STATE_KEY = 'maintenance:last_score';
const HOUR_MS = 60 * 60_000;

export function createCandidateTracker(state, broadcast, options = {}) {
  const enabled = options.enabled ?? CANDIDATE_TRACKER_ENABLED;
  const maintenanceEnabled = options.maintenanceEnabled ?? CANDIDATE_MAINTENANCE_ENABLED;
  const realCopyQualityActive = enabled || maintenanceEnabled;
  const maintenanceIntervalMs = Number(options.maintenanceIntervalMs ?? CANDIDATE_MAINTENANCE_INTERVAL_MS);
  const maintenanceScoringIntervalMs = Number(
    options.maintenanceScoringIntervalMs ?? CANDIDATE_MAINTENANCE_SCORING_INTERVAL_MS
  );
  const maintenanceLookbackHours = Number(options.maintenanceLookbackHours ?? CANDIDATE_MAINTENANCE_LOOKBACK_HOURS);
  const maintenanceStartupCatchupHours = Number(
    options.maintenanceStartupCatchupHours ?? CANDIDATE_MAINTENANCE_STARTUP_CATCHUP_HOURS
  );
  const maintenanceScope = normalizeMaintenanceScope(options.maintenanceScope ?? CANDIDATE_MAINTENANCE_SCOPE);
  const maintenancePageLimit = Number(options.maintenancePageLimit ?? CANDIDATE_MAINTENANCE_PAGE_LIMIT);
  const maintenanceMaxPagesPerWallet = Number(
    options.maintenanceMaxPagesPerWallet ?? CANDIDATE_MAINTENANCE_MAX_PAGES_PER_WALLET
  );
  const maintenanceResolutionMaxTrades = Number(
    options.maintenanceResolutionMaxTrades ?? CANDIDATE_MAINTENANCE_RESOLUTION_MAX_TRADES
  );
  const maintenanceRunOnStart = options.maintenanceRunOnStart ?? true;
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
  let maintenanceTimer = null;
  let pollRunning = false;
  let backfillRunning = false;
  let resolutionRunning = false;
  let copyPoolRunning = false;
  let realCopyQualityRunning = false;
  let maintenanceRunning = false;
  let pollBootstrapped = false;

  state.service.candidates = {
    enabled,
    status: enabled ? 'starting' : 'disabled',
    storageStatus: 'not_started',
    minUsd: CANDIDATE_MIN_USD,
    maxUsd: CANDIDATE_MAX_USD,
    backfillDays: CANDIDATE_BACKFILL_DAYS,
    acceptedHistoryDays: CANDIDATE_ACCEPTED_HISTORY_DAYS,
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
    copyPoolStatus: enabled && copyPoolEnabled ? 'starting' : 'disabled',
    copyPoolLastRunAt: null,
    copyPoolLastChangedCount: 0,
    copyPoolLastCopiedCount: 0,
    shadowTraderStatus: enabled ? 'starting' : 'disabled',
    shadowTraderStrategy: SHADOW_TRADER_STRATEGY,
    shadowTraderLastRunAt: null,
    shadowTraderSelectedWalletCount: 0,
    shadowTraderLastCopiedCount: 0,
    maintenanceEnabled,
    maintenanceStatus: maintenanceEnabled ? 'starting' : 'disabled',
    maintenanceScope,
    maintenanceIntervalMs,
    maintenanceScoringIntervalMs,
    maintenanceLookbackHours,
    maintenanceStartupCatchupHours,
    maintenanceLastRunAt: null,
    maintenanceLastStartedAt: null,
    maintenanceLastFinishedAt: null,
    maintenanceLastScoringAt: null,
    maintenanceLastWalletCount: 0,
    maintenanceLastRequestCount: 0,
    maintenanceLastInsertedTradeCount: 0,
    maintenanceLastResolvedTradeCount: 0,
    maintenanceLastScoredWalletCount: 0,
    maintenanceLastErrorCount: 0,
    maintenanceLastError: null,
    lastError: null,
  };
  state.service.realCopyQuality = {
    enabled: realCopyQualityActive,
    status: realCopyQualityActive ? 'starting' : 'disabled',
    lastBackfillAt: null,
    lastScoredAt: null,
    queuedWalletCount: 0,
    scoredWalletCount: 0,
    eligibleWalletCount: 0,
    coreWalletCount: 0,
    candidateWalletCount: 0,
    watchlistWalletCount: 0,
    lastError: null,
  };

  async function start() {
    if (started) return;
    started = true;
    if (!enabled) {
      await startCachedRealCopyQuality();
      await startMaintenanceTimer();
      return;
    }

    try {
      storage = await storageFactory();
      const recoveredBackfills = await storage.recoverStaleBackfills?.(CANDIDATE_STALE_BACKFILL_MS);
      const seededBackfills = await storage.seedActiveCopyPoolBackfill?.(WATCHED_WALLETS, {
        historyDays: CANDIDATE_ACCEPTED_HISTORY_DAYS,
      });
      state.service.candidates.storageStatus = 'ready';
      state.service.candidates.status = 'ready';
      state.service.realCopyQuality.status = 'ready';
      state.service.candidates.recoveredStaleBackfillCount = recoveredBackfills?.length || 0;
      state.service.candidates.seededActiveCopyPoolBackfillCount = seededBackfills?.length || 0;
      await runCopyPoolEvaluation();
      broadcast();
    } catch (error) {
      state.service.candidates.storageStatus = 'error';
      state.service.candidates.status = 'error';
      state.service.realCopyQuality.status = 'error';
      state.service.realCopyQuality.lastError = error.message;
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
    await startMaintenanceTimer();
  }

  async function startCachedRealCopyQuality() {
    state.service.candidates.status = 'disabled';
    state.service.candidates.copyPoolStatus = 'disabled';
    state.service.candidates.shadowTraderStatus = 'disabled';
    try {
      storage = await storageFactory();
      state.service.candidates.storageStatus = 'ready';
      state.service.realCopyQuality.status = 'cached';
      const payload = await storage.getRealCopyQualityLeaderboard?.({ limit: 1, eligible: null });
      applyRealCopyQualitySummary(payload?.summary, payload?.summary?.total || 0);
      await hydrateMaintenanceState();
      state.service.realCopyQuality.lastError = null;
    } catch (error) {
      storage = null;
      state.service.candidates.storageStatus = 'unavailable';
      state.service.candidates.lastError = error.message;
      state.service.realCopyQuality.status = 'disabled';
      state.service.realCopyQuality.lastError = error.message;
    }
    broadcast();
  }

  async function hydrateMaintenanceState() {
    if (!storage?.getServiceState) return;
    const [lastRun, lastFetch, lastScoring] = await Promise.all([
      storage.getServiceState(MAINTENANCE_STATE_KEY).catch(() => null),
      storage.getServiceState(MAINTENANCE_FETCH_STATE_KEY).catch(() => null),
      storage.getServiceState(MAINTENANCE_SCORING_STATE_KEY).catch(() => null),
    ]);
    const legacyPayload = lastRun?.payload;
    applyMaintenanceSummary(lastFetch?.payload || legacyPayload);
    applyMaintenanceScoringSummary(lastScoring?.payload || (hasScoringSummary(legacyPayload) ? legacyPayload : null));
  }

  async function startMaintenanceTimer() {
    if (!maintenanceEnabled) {
      state.service.candidates.maintenanceStatus = 'disabled';
      return;
    }
    if (!storage) {
      state.service.candidates.maintenanceStatus = 'unavailable';
      return;
    }

    await hydrateMaintenanceState();
    state.service.candidates.maintenanceStatus = 'ready';
    if (maintenanceRunOnStart) await runMaintenance();

    if (!maintenanceTimer) {
      maintenanceTimer = setInterval(runMaintenance, Math.max(60_000, maintenanceIntervalMs));
    }
  }

  async function close() {
    clearInterval(pollTimer);
    clearInterval(backfillTimer);
    clearInterval(resolutionTimer);
    clearInterval(copyPoolTimer);
    clearInterval(maintenanceTimer);
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
        const rawTrades = await fetchTrades({
          limit: CANDIDATE_POLL_LIMIT,
          offset,
          filterType: 'CASH',
          filterAmount: CANDIDATE_MIN_USD,
        });
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
      const historyDays = backfillDaysForWallet(wallet);

      state.service.candidates.status = 'backfilling';
      state.service.candidates.lastBackfillWallet = wallet;
      broadcast();
      await storage.markBackfillRunning(wallet);

      const cutoff = new Date(Date.now() - historyDays * 24 * 60 * 60 * 1000);
      let reachedCutoff = false;
      let reachedEnd = false;
      let partialReason = null;
      let inserted = 0;
      let oldestFetchedTimestamp = null;

      for (let page = 0; page < CANDIDATE_BACKFILL_MAX_PAGES && !reachedCutoff; page += 1) {
        const offset = page * CANDIDATE_BACKFILL_PAGE_LIMIT;
        if (offset > CANDIDATE_BACKFILL_MAX_OFFSET) {
          partialReason = `Stopped at Data API offset ${offset}; configured max is ${CANDIDATE_BACKFILL_MAX_OFFSET}`;
          break;
        }

        let rawTrades;
        try {
          rawTrades = await fetchTrades({
            user: wallet,
            limit: CANDIDATE_BACKFILL_PAGE_LIMIT,
            offset,
            filterType: 'CASH',
            filterAmount: CANDIDATE_MIN_USD,
          });
        } catch (error) {
          if (page > 0 && isDataApiOffsetLimitError(error)) {
            partialReason = `Stopped after Data API rejected offset ${offset}`;
            break;
          }
          throw error;
        }
        if (!rawTrades.length) {
          reachedEnd = true;
          break;
        }

        await storage.saveServiceState?.(`backfill:${wallet}`, {
          wallet,
          historyDays,
          offset,
          page,
          status: 'running',
          inserted,
          updatedAt: new Date().toISOString(),
        });

        for (const raw of rawTrades.slice().reverse()) {
          const rawTimestamp = toUnixSeconds(raw.timestamp ?? raw.createdAt ?? raw.ts);
          if (rawTimestamp && (!oldestFetchedTimestamp || rawTimestamp < oldestFetchedTimestamp)) {
            oldestFetchedTimestamp = rawTimestamp;
          }
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

      if (!reachedCutoff && !reachedEnd && !partialReason) {
        partialReason = `Stopped after ${CANDIDATE_BACKFILL_MAX_PAGES} Data API pages before reaching cutoff`;
      }

      const coveredSince = partialReason && oldestFetchedTimestamp
        ? new Date(oldestFetchedTimestamp * 1000).toISOString()
        : cutoff.toISOString();

      await storage.markBackfillComplete(wallet, coveredSince, {
        partial: Boolean(partialReason),
        reason: partialReason,
      });
      await storage.saveServiceState?.(`backfill:${wallet}`, {
        wallet,
        status: partialReason ? 'partial' : 'done',
        historyDays,
        coveredSince,
        reachedCutoff,
        reachedEnd,
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

  async function runResolution({ maxTrades = null, evaluateCopyPoolOnSettle = true } = {}) {
    if (!storage || resolutionRunning) return;
    resolutionRunning = true;
    let checked = 0;
    let settled = 0;
    try {
      state.service.candidates.status = 'resolving';
      broadcast();
      const queueMetrics = await storage.getResolutionQueueMetrics?.();
      if (queueMetrics) state.service.candidates.resolutionQueue = queueMetrics;
      const batchSize = maxTrades
        ? Math.max(1, Math.min(10_000, Number(maxTrades)))
        : resolutionBatchSize(queueMetrics);
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
      if (settled && evaluateCopyPoolOnSettle) await runCopyPoolEvaluation();
      broadcast();
      return { checked, settled };
    } catch (error) {
      state.service.candidates.status = 'error';
      state.service.candidates.lastError = error.message;
      broadcast();
      return { checked, settled, error: error.message };
    } finally {
      resolutionRunning = false;
    }
  }

  async function runMaintenance({ force = false, forceScoring = false } = {}) {
    if (!storage || !maintenanceEnabled || maintenanceRunning) return null;
    maintenanceRunning = true;
    try {
      state.service.candidates.maintenanceStatus = 'running';
      state.service.candidates.maintenanceLastStartedAt = new Date().toISOString();
      state.service.candidates.maintenanceLastError = null;
      broadcast();

      const runWithDueCheck = async () => {
        const plan = await planMaintenanceRun({ force, forceScoring });
        if (!plan.fetchDue && !plan.scoringDue) {
          state.service.candidates.maintenanceStatus = 'ready';
          return {
            ok: true,
            status: 'skipped',
            reason: 'Maintenance fetch and scoring intervals have not elapsed',
            fetchReason: plan.fetchReason,
            scoringReason: plan.scoringReason,
            nextRunAt: plan.nextFetchAt,
            nextFetchAt: plan.nextFetchAt,
            nextScoringAt: plan.nextScoringAt,
            updatedAt: new Date().toISOString(),
          };
        }
        return executeMaintenance(plan);
      };

      const lockResult = storage.withMaintenanceLock
        ? await storage.withMaintenanceLock(runWithDueCheck)
        : { acquired: true, result: await runWithDueCheck() };

      if (!lockResult.acquired) {
        const summary = {
          ok: true,
          status: 'locked',
          reason: 'Another candidate maintenance run is already active',
          updatedAt: new Date().toISOString(),
        };
        state.service.candidates.maintenanceStatus = 'locked';
        return summary;
      }

      return lockResult.result;
    } catch (error) {
      state.service.candidates.maintenanceStatus = 'error';
      state.service.candidates.maintenanceLastError = error.message;
      state.service.candidates.lastError = error.message;
      broadcast();
      return { ok: false, status: 'error', error: error.message, updatedAt: new Date().toISOString() };
    } finally {
      maintenanceRunning = false;
      broadcast();
    }
  }

  async function planMaintenanceRun({ force = false, forceScoring = false } = {}) {
    if (force) {
      return {
        fetchDue: true,
        scoringDue: true,
        fetchReason: 'Forced maintenance run',
        scoringReason: 'Forced maintenance run',
        lookbackHours: maintenanceLookbackHours,
      };
    }
    const [fetchDue, scoringDue] = await Promise.all([isMaintenanceFetchDue(), isMaintenanceScoringDue()]);
    return {
      fetchDue: fetchDue.due,
      scoringDue: forceScoring || scoringDue.due,
      fetchReason: fetchDue.reason,
      scoringReason: forceScoring ? 'Forced scoring run' : scoringDue.reason,
      lookbackHours: fetchDue.lookbackHours || maintenanceLookbackHours,
      nextFetchAt: fetchDue.nextRunAt,
      nextScoringAt: scoringDue.nextRunAt,
    };
  }

  async function isMaintenanceFetchDue() {
    if (!storage?.getServiceState) return { due: true, reason: 'No persisted maintenance state reader' };
    const lastRun = await readMaintenanceState(MAINTENANCE_FETCH_STATE_KEY);
    applyMaintenanceSummary(lastRun?.payload);
    const payload = lastRun?.payload || {};
    if (payload.status !== 'done') {
      return {
        due: true,
        reason: 'No completed maintenance fetch',
        lookbackHours: Math.max(maintenanceLookbackHours, maintenanceStartupCatchupHours),
      };
    }
    const lastFinishedAt = Date.parse(payload.finishedAt || payload.updatedAt || lastRun?.updatedAt);
    if (!Number.isFinite(lastFinishedAt)) return { due: true, reason: 'Completed fetch has no timestamp' };
    const elapsedMs = Date.now() - lastFinishedAt;
    if (elapsedMs >= maintenanceIntervalMs) {
      return {
        due: true,
        reason: 'Maintenance fetch interval elapsed',
        lookbackHours: lookbackHoursForElapsedMs(elapsedMs),
      };
    }
    return {
      due: false,
      reason: 'Maintenance fetch interval has not elapsed',
      nextRunAt: new Date(lastFinishedAt + maintenanceIntervalMs).toISOString(),
    };
  }

  async function isMaintenanceScoringDue() {
    if (!storage?.getServiceState) return { due: true, reason: 'No persisted maintenance state reader' };
    const lastRun = await readMaintenanceState(MAINTENANCE_SCORING_STATE_KEY, { requireScoring: true });
    applyMaintenanceScoringSummary(lastRun?.payload);
    const payload = lastRun?.payload || {};
    if (!hasScoringSummary(payload)) {
      return { due: true, reason: 'No completed maintenance scoring run' };
    }
    const lastFinishedAt = Date.parse(payload.scoredAt || payload.finishedAt || payload.updatedAt || lastRun?.updatedAt);
    if (!Number.isFinite(lastFinishedAt)) return { due: true, reason: 'Completed scoring run has no timestamp' };
    const elapsedMs = Date.now() - lastFinishedAt;
    if (elapsedMs >= maintenanceScoringIntervalMs) {
      return { due: true, reason: 'Maintenance scoring interval elapsed' };
    }
    return {
      due: false,
      reason: 'Maintenance scoring interval has not elapsed',
      nextRunAt: new Date(lastFinishedAt + maintenanceScoringIntervalMs).toISOString(),
    };
  }

  async function executeMaintenance({
    fetchDue = true,
    scoringDue = true,
    fetchReason = null,
    scoringReason = null,
    lookbackHours = maintenanceLookbackHours,
  } = {}) {
    const startedAt = new Date().toISOString();
    const candidateStatusBefore = state.service.candidates.status;
    const runFetch = fetchDue !== false;
    const runScoring = scoringDue !== false;
    const runLookbackHours = Math.max(1, Number(lookbackHours) || maintenanceLookbackHours);
    const maxPagesForRun = maintenancePagesForLookback(runLookbackHours);
    const cutoff = new Date(Date.now() - runLookbackHours * 60 * 60_000);
    const wallets = runFetch
      ? await storage.getMaintenanceWallets?.({
          scope: maintenanceScope,
          baselineWallets: WATCHED_WALLETS,
        })
      : [];
    const walletList = runFetch && Array.isArray(wallets) ? wallets.map(normalizeWallet).filter(Boolean) : [];
    const errors = [];
    let requestCount = 0;
    let rawTradeCount = 0;
    let normalizedTradeCount = 0;
    let insertedTradeCount = 0;

    if (runFetch) {
      for (const wallet of walletList) {
        try {
          let reachedCutoff = false;
          for (let page = 0; page < maxPagesForRun && !reachedCutoff; page += 1) {
            const offset = page * Math.max(1, maintenancePageLimit);
            requestCount += 1;
            const rawTrades = await fetchTrades({
              user: wallet,
              limit: Math.max(1, maintenancePageLimit),
              offset,
              filterType: 'CASH',
              filterAmount: CANDIDATE_MIN_USD,
            });
            if (!rawTrades.length) break;
            rawTradeCount += rawTrades.length;

            for (const raw of rawTrades.slice().reverse()) {
              const rawTimestamp = toUnixSeconds(raw.timestamp ?? raw.createdAt ?? raw.ts);
              if (rawTimestamp && rawTimestamp * 1000 < cutoff.getTime()) {
                reachedCutoff = true;
                continue;
              }
              const trade = normalizeCandidateTrade(raw, { source: 'maintenance' });
              if (!trade) continue;
              normalizedTradeCount += 1;
              const result = await storage.upsertTrade(trade);
              if (result.insertedTrade) insertedTradeCount += 1;
            }
          }
        } catch (error) {
          errors.push({ wallet, error: error.message });
        }
      }
    }

    const resolution = await runResolution({
      maxTrades: maintenanceResolutionMaxTrades,
      evaluateCopyPoolOnSettle: false,
    });
    const copyPoolResult = runScoring ? await runCopyPoolEvaluation({ scoreRealCopyQuality: false }) : null;
    if (runScoring && copyPoolResult?.ok === false) {
      errors.push({ phase: 'copy_pool', error: copyPoolResult.error || 'Copy-pool evaluation failed' });
    }
    const scoring = runScoring ? await runRealCopyQualityScoring({ scope: maintenanceScope }) : null;
    if (runScoring && scoring?.ok === false) {
      errors.push({ phase: 'scoring', error: scoring.error || 'Real copy-quality scoring failed' });
    }
    const finishedAt = new Date().toISOString();
    const scoredWalletCount = runScoring
      ? Number(scoring?.scored || 0)
      : Number(state.service.candidates.maintenanceLastScoredWalletCount || 0);
    const summary = {
      ok: errors.length === 0,
      status: errors.length ? 'partial' : 'done',
      scope: maintenanceScope,
      fetchStatus: runFetch ? 'done' : 'skipped',
      scoringStatus: runScoring ? (scoring?.ok === false ? 'error' : 'done') : 'skipped',
      fetchReason,
      scoringReason,
      lookbackHours: runLookbackHours,
      maxPagesPerWallet: maxPagesForRun,
      cutoffAt: cutoff.toISOString(),
      startedAt,
      finishedAt,
      walletCount: walletList.length,
      requestCount,
      rawTradeCount,
      normalizedTradeCount,
      insertedTradeCount,
      resolvedTradeCount: Number(resolution?.settled || 0),
      resolutionCheckedCount: Number(resolution?.checked || 0),
      copyPoolChangedCount: Array.isArray(copyPoolResult?.changed) ? copyPoolResult.changed.length : 0,
      scoredWalletCount,
      scoredAt: runScoring ? finishedAt : state.service.candidates.maintenanceLastScoringAt,
      errorCount: errors.length,
      errors: errors.slice(0, 10),
      updatedAt: finishedAt,
    };
    if (runFetch) await storage.saveServiceState?.(MAINTENANCE_FETCH_STATE_KEY, summary);
    if (runScoring) await storage.saveServiceState?.(MAINTENANCE_SCORING_STATE_KEY, summary);
    await storage.saveServiceState?.(MAINTENANCE_STATE_KEY, summary);
    applyMaintenanceSummary(summary);
    if (runScoring) applyMaintenanceScoringSummary(summary);
    state.service.candidates.maintenanceStatus = errors.length ? 'partial' : 'ready';
    state.service.candidates.maintenanceLastError = errors[0]?.error || null;
    if (!enabled) state.service.candidates.status = candidateStatusBefore || 'disabled';
    state.service.candidates.lastError = null;
    return summary;
  }

  function maintenancePagesForLookback(lookbackHours) {
    const basePages = Math.max(1, maintenanceMaxPagesPerWallet);
    const baseLookback = Math.max(1, maintenanceLookbackHours);
    return Math.max(basePages, Math.ceil((lookbackHours / baseLookback) * basePages));
  }

  async function readMaintenanceState(key, { requireScoring = false } = {}) {
    const current = await storage.getServiceState(key).catch(() => null);
    if (current?.payload && (!requireScoring || hasScoringSummary(current.payload))) return current;
    const legacy = key === MAINTENANCE_STATE_KEY
      ? null
      : await storage.getServiceState(MAINTENANCE_STATE_KEY).catch(() => null);
    if (!legacy?.payload) return current || legacy;
    if (requireScoring && !hasScoringSummary(legacy.payload)) return current;
    return legacy;
  }

  function lookbackHoursForElapsedMs(elapsedMs) {
    const elapsedHours = Math.ceil(Math.max(0, elapsedMs) / HOUR_MS);
    const catchupLimit = Math.max(maintenanceLookbackHours, maintenanceStartupCatchupHours);
    return Math.max(maintenanceLookbackHours, Math.min(catchupLimit, elapsedHours));
  }

  async function runCopyPoolEvaluation({ scoreRealCopyQuality = true } = {}) {
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
      await storage.seedActiveCopyPoolBackfill?.(WATCHED_WALLETS, {
        historyDays: CANDIDATE_ACCEPTED_HISTORY_DAYS,
      });
      applyCopyPoolSnapshot(state, result.snapshot);
      await runShadowTraderEvaluation();
      if (scoreRealCopyQuality) await runRealCopyQualityScoring({ scope: 'active_copy_pool' });
      state.service.candidates.copyPoolStatus = 'ready';
      state.service.candidates.copyPoolLastRunAt = new Date().toISOString();
      state.service.candidates.copyPoolLastChangedCount = result.changed.length;
      state.service.candidates.lastError = null;
      onStateChanged();
      broadcast();
      return result;
    } catch (error) {
      state.service.candidates.copyPoolStatus = 'error';
      state.service.candidates.lastError = error.message;
      broadcast();
      return { ok: false, error: error.message };
    } finally {
      copyPoolRunning = false;
    }
  }

  async function runShadowTraderEvaluation() {
    if (!storage?.evaluateShadowTrader) {
      state.service.candidates.shadowTraderStatus = 'unavailable';
      return { ok: false, error: 'Shadow trader evaluation is unavailable' };
    }
    try {
      state.service.candidates.shadowTraderStatus = 'evaluating';
      broadcast();
      const shadowSnapshot = await storage.evaluateShadowTrader({
        windowDays: CANDIDATE_BACKFILL_DAYS,
      });
      if (shadowSnapshot) {
        applyShadowTraderSnapshot(state, shadowSnapshot);
        state.service.candidates.shadowTraderStatus = 'ready';
        state.service.candidates.shadowTraderLastRunAt = shadowSnapshot.lastEvaluatedAt;
        state.service.candidates.shadowTraderSelectedWalletCount = shadowSnapshot.selectedWalletCount;
        state.service.candidates.lastError = null;
        onStateChanged();
        broadcast();
      }
      return {
        ok: true,
        strategy: shadowSnapshot?.strategy || null,
        selectedWalletCount: shadowSnapshot?.selectedWalletCount || 0,
        candidatesScoredCount: shadowSnapshot?.candidatesScoredCount || 0,
        lastEvaluatedAt: shadowSnapshot?.lastEvaluatedAt || null,
      };
    } catch (error) {
      state.service.candidates.shadowTraderStatus = 'error';
      state.service.candidates.lastError = error.message;
      broadcast();
      return { ok: false, error: error.message };
    }
  }

  async function runRealCopyQualityScoring({ scope = 'active_copy_pool', wallet = null } = {}) {
    if (!storage || realCopyQualityRunning) return state.service.realCopyQuality;
    realCopyQualityRunning = true;
    try {
      state.service.realCopyQuality.status = 'scoring';
      broadcast();
      const result = await storage.recalculateRealCopyQuality?.({
        scope: wallet ? 'wallet' : scope,
        wallet,
        baselineWallets: WATCHED_WALLETS,
      });
      applyRealCopyQualitySummary(result?.summary, result?.summary?.total || result?.scored || 0);
      state.service.realCopyQuality.status = 'ready';
      state.service.realCopyQuality.lastScoredAt = new Date().toISOString();
      state.service.realCopyQuality.lastError = null;
      broadcast();
      return result;
    } catch (error) {
      state.service.realCopyQuality.status = 'error';
      state.service.realCopyQuality.lastError = error.message;
      broadcast();
      return { ok: false, error: error.message };
    } finally {
      realCopyQualityRunning = false;
    }
  }

  function backfillDaysForWallet(wallet) {
    const normalized = normalizeWallet(wallet);
    const entry = normalized ? state.copyPool?.wallets?.[normalized] : null;
    if (entry?.status === 'active') {
      return Math.max(CANDIDATE_BACKFILL_DAYS, CANDIDATE_ACCEPTED_HISTORY_DAYS);
    }
    return CANDIDATE_BACKFILL_DAYS;
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

  async function getRealCopyQualityLeaderboard(params = {}) {
    if (!storage) return inactiveRealCopyQualityPayload(state.service.realCopyQuality?.status || 'starting');
    const payload = await storage.getRealCopyQualityLeaderboard(params);
    applyRealCopyQualitySummary(payload.summary, payload.summary?.total || 0);
    return {
      ...payload,
      enabled: realCopyQualityActive,
      cached: !realCopyQualityActive,
      status: realCopyQualityActive ? state.service.realCopyQuality.status : 'cached',
      updatedAt: new Date().toISOString(),
    };
  }

  async function getRealCopyQualityScore(wallet) {
    if (!storage) return null;
    return storage.getRealCopyQualityScore(wallet);
  }

  async function recalculateRealCopyQuality(params = {}) {
    if (!storage) return inactiveRealCopyQualityPayload('disabled');
    return runRealCopyQualityScoring(params);
  }

  function applyRealCopyQualitySummary(summary = {}, queuedWalletCount = 0) {
    const service = state.service.realCopyQuality || {};
    service.queuedWalletCount = queuedWalletCount;
    service.scoredWalletCount = Number(summary.scored || 0);
    service.eligibleWalletCount = Number(summary.eligible || 0);
    service.coreWalletCount = Number(summary.core || 0);
    service.candidateWalletCount = Number(summary.candidate || 0);
    service.watchlistWalletCount = Number(summary.watchlist || 0);
    service.lastScoredAt = summary.lastScoredAt || service.lastScoredAt || null;
    state.service.realCopyQuality = service;
  }

  function applyMaintenanceSummary(summary = {}) {
    if (!summary || typeof summary !== 'object') return;
    state.service.candidates.maintenanceLastRunAt = summary.finishedAt || summary.updatedAt || null;
    state.service.candidates.maintenanceLastStartedAt = summary.startedAt || state.service.candidates.maintenanceLastStartedAt;
    state.service.candidates.maintenanceLastFinishedAt = summary.finishedAt || null;
    state.service.candidates.maintenanceLastWalletCount = Number(summary.walletCount || 0);
    state.service.candidates.maintenanceLastRequestCount = Number(summary.requestCount || 0);
    state.service.candidates.maintenanceLastInsertedTradeCount = Number(summary.insertedTradeCount || 0);
    state.service.candidates.maintenanceLastResolvedTradeCount = Number(summary.resolvedTradeCount || 0);
    if (hasScoringSummary(summary)) applyMaintenanceScoringSummary(summary);
    state.service.candidates.maintenanceLastErrorCount = Number(summary.errorCount || 0);
    state.service.candidates.maintenanceLastError = Array.isArray(summary.errors) && summary.errors.length
      ? summary.errors[0]?.error || null
      : null;
  }

  function applyMaintenanceScoringSummary(summary = {}) {
    if (!hasScoringSummary(summary)) return;
    state.service.candidates.maintenanceLastScoredWalletCount = Number(summary.scoredWalletCount || 0);
    state.service.candidates.maintenanceLastScoringAt = summary.scoredAt || summary.finishedAt || summary.updatedAt || null;
  }

  return {
    start,
    close,
    getLeaderboard,
    getTrader,
    runPoll,
    runBackfill,
    runResolution,
    runMaintenance,
    runCopyPoolEvaluation,
    runShadowTraderEvaluation,
    runRealCopyQualityScoring,
    getRealCopyQualityLeaderboard,
    getRealCopyQualityScore,
    recalculateRealCopyQuality,
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

function inactiveRealCopyQualityPayload(status) {
  return {
    ok: true,
    enabled: false,
    status,
    updatedAt: new Date().toISOString(),
    summary: {
      total: 0,
      scored: 0,
      eligible: 0,
      core: 0,
      candidate: 0,
      watchlist: 0,
      manualReview: 0,
      ignore: 0,
      lastScoredAt: null,
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

function normalizeMaintenanceScope(scope) {
  const text = String(scope || '').trim().toLowerCase();
  if (text === 'all_candidates') return 'all_candidates';
  if (text === 'active_copy_pool') return 'active_copy_pool';
  return 'active_scored';
}

function hasScoringSummary(summary = {}) {
  if (!summary || typeof summary !== 'object') return false;
  if (summary.scoringStatus === 'done' || summary.scoringStatus === 'error') return true;
  if (summary.scoredAt) return true;
  return Number(summary.scoredWalletCount || 0) > 0;
}
