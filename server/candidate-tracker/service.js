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
  CANDIDATE_DISCOVERY_ENABLED,
  CANDIDATE_DISCOVERY_GLOBAL_PAGES,
  CANDIDATE_DISCOVERY_INTERVAL_MS,
  CANDIDATE_DISCOVERY_MAX_DEEP_BACKFILLS,
  CANDIDATE_DISCOVERY_MAX_STAGE1_WALLETS,
  CANDIDATE_DISCOVERY_REQUEST_BUDGET,
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
  REAL_MAX_ENTRY_PRICE_CENTS,
  SHADOW_FOLLOW_POLL_INTERVAL_MS,
  SHADOW_FOLLOW_POLL_LIMIT,
  SHADOW_POLLING_ENABLED,
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
const DISCOVERY_STATE_KEY = 'discovery:last_run';
const HOUR_MS = 60 * 60_000;

export function createCandidateTracker(state, broadcast, options = {}) {
  const enabled = options.enabled ?? CANDIDATE_TRACKER_ENABLED;
  const maintenanceEnabled = options.maintenanceEnabled ?? CANDIDATE_MAINTENANCE_ENABLED;
  const discoveryEnabled = options.discoveryEnabled ?? CANDIDATE_DISCOVERY_ENABLED;
  const realCopyQualityActive = enabled || maintenanceEnabled || discoveryEnabled;
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
  const discoveryIntervalMs = Number(options.discoveryIntervalMs ?? CANDIDATE_DISCOVERY_INTERVAL_MS);
  const discoveryGlobalPages = boundedNumber(options.discoveryGlobalPages ?? CANDIDATE_DISCOVERY_GLOBAL_PAGES, 2, 1, 25);
  const discoveryMaxStage1Wallets = boundedNumber(
    options.discoveryMaxStage1Wallets ?? CANDIDATE_DISCOVERY_MAX_STAGE1_WALLETS,
    25,
    1,
    500
  );
  const discoveryMaxDeepBackfills = boundedNumber(
    options.discoveryMaxDeepBackfills ?? CANDIDATE_DISCOVERY_MAX_DEEP_BACKFILLS,
    5,
    0,
    100
  );
  const discoveryRequestBudget = boundedNumber(
    options.discoveryRequestBudget ?? CANDIDATE_DISCOVERY_REQUEST_BUDGET,
    75,
    1,
    10_000
  );
  const discoveryRunOnStart = options.discoveryRunOnStart ?? true;
  const discoveryCooldownMs = Number(options.discoveryCooldownMs ?? 7 * 24 * HOUR_MS);
  const shadowPollingEnabled = options.shadowPollingEnabled ?? SHADOW_POLLING_ENABLED;
  const shadowPollIntervalMs = Number(options.shadowPollIntervalMs ?? SHADOW_FOLLOW_POLL_INTERVAL_MS);
  const shadowPollLimit = Number(options.shadowPollLimit ?? SHADOW_FOLLOW_POLL_LIMIT);
  const shadowRunOnStart = options.shadowRunOnStart ?? true;
  const onStateChanged = options.onStateChanged || (() => {});
  const copyPoolEnabled = options.copyPoolEnabled ?? AUTO_COPY_POOL_ENABLED;
  const storageFactory = options.storageFactory || createCandidateStorage;
  const fetchTrades = options.fetchDataApiTrades || fetchDataApiTrades;
  const setTimer = options.setInterval || setInterval;
  const clearTimer = options.clearInterval || clearInterval;
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
  let discoveryTimer = null;
  let shadowPollTimer = null;
  let pollRunning = false;
  let backfillRunning = false;
  let resolutionRunning = false;
  let copyPoolRunning = false;
  let realCopyQualityRunning = false;
  let maintenanceRunning = false;
  let discoveryRunning = false;
  let shadowPollRunning = false;
  let pollBootstrapped = false;
  const realCopyQualityLeaderboardCache = new Map();
  const realCopyQualityLeaderboardCacheMs = Number(options.realCopyQualityLeaderboardCacheMs ?? 60_000);

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
    shadowPollingEnabled: Boolean(shadowPollingEnabled),
    shadowPollIntervalMs,
    shadowPollStatus: shadowPollingEnabled ? 'starting' : 'disabled',
    shadowLastPollAt: null,
    shadowLastPollChecked: 0,
    shadowLastPollCopied: 0,
    shadowLastPollError: null,
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
    discoveryEnabled: Boolean(discoveryEnabled),
    discoveryStatus: discoveryEnabled ? 'starting' : 'disabled',
    discoveryIntervalMs,
    discoveryGlobalPages,
    discoveryMaxStage1Wallets,
    discoveryMaxDeepBackfills,
    discoveryRequestBudget,
    discoveryLastRunAt: null,
    discoveryLastStartedAt: null,
    discoveryLastFinishedAt: null,
    discoveryNextRunAt: null,
    discoveryLastRequestCount: 0,
    discoveryLastWalletsSeen: 0,
    discoveryLastWalletsHeld: 0,
    discoveryLastStage1Promoted: 0,
    discoveryLastDeepPromoted: 0,
    discoveryLastScored: 0,
    discoveryLastRejected: 0,
    discoveryLastError: null,
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
      await startDiscoveryTimer();
      await startShadowPollingTimer();
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
    await startDiscoveryTimer();
    await startShadowPollingTimer();
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

  async function ensureStorageAvailable() {
    if (storage) return true;
    try {
      storage = await storageFactory();
      state.service.candidates.storageStatus = 'ready';
      if (!enabled) state.service.candidates.status = 'disabled';
      if (realCopyQualityActive && state.service.realCopyQuality.status === 'disabled') {
        state.service.realCopyQuality.status = 'cached';
      }
      state.service.candidates.lastError = null;
      state.service.realCopyQuality.lastError = null;
      return true;
    } catch (error) {
      storage = null;
      state.service.candidates.storageStatus = 'unavailable';
      state.service.candidates.maintenanceStatus = maintenanceEnabled ? 'unavailable' : state.service.candidates.maintenanceStatus;
      state.service.candidates.lastError = error.message;
      state.service.realCopyQuality.status = realCopyQualityActive ? 'disabled' : state.service.realCopyQuality.status;
      state.service.realCopyQuality.lastError = error.message;
      broadcast();
      return false;
    }
  }

  async function hydrateMaintenanceState() {
    if (!storage?.getServiceState) return;
    const [lastRun, lastFetch, lastScoring, lastDiscovery] = await Promise.all([
      storage.getServiceState(MAINTENANCE_STATE_KEY).catch(() => null),
      storage.getServiceState(MAINTENANCE_FETCH_STATE_KEY).catch(() => null),
      storage.getServiceState(MAINTENANCE_SCORING_STATE_KEY).catch(() => null),
      storage.getServiceState(DISCOVERY_STATE_KEY).catch(() => null),
    ]);
    const legacyPayload = lastRun?.payload;
    applyMaintenanceSummary(lastFetch?.payload || legacyPayload);
    applyMaintenanceScoringSummary(lastScoring?.payload || (hasScoringSummary(legacyPayload) ? legacyPayload : null));
    applyDiscoverySummary(lastDiscovery?.payload);
  }

  async function hydrateDiscoveryState() {
    if (!storage?.getServiceState) return;
    const lastDiscovery = await storage.getServiceState(DISCOVERY_STATE_KEY).catch(() => null);
    applyDiscoverySummary(lastDiscovery?.payload);
  }

  async function startMaintenanceTimer() {
    if (!maintenanceEnabled) {
      state.service.candidates.maintenanceStatus = 'disabled';
      return;
    }
    if (!storage) await ensureStorageAvailable();

    if (storage) {
      await hydrateMaintenanceState();
      state.service.candidates.maintenanceStatus = 'ready';
      if (maintenanceRunOnStart) await runMaintenance();
    }

    if (!maintenanceTimer) {
      maintenanceTimer = setInterval(runMaintenance, Math.max(60_000, maintenanceIntervalMs));
    }
  }

  async function startDiscoveryTimer() {
    state.service.candidates.discoveryEnabled = Boolean(discoveryEnabled);
    state.service.candidates.discoveryIntervalMs = discoveryIntervalMs;
    state.service.candidates.discoveryGlobalPages = discoveryGlobalPages;
    state.service.candidates.discoveryMaxStage1Wallets = discoveryMaxStage1Wallets;
    state.service.candidates.discoveryMaxDeepBackfills = discoveryMaxDeepBackfills;
    state.service.candidates.discoveryRequestBudget = discoveryRequestBudget;
    if (!discoveryEnabled) {
      state.service.candidates.discoveryStatus = 'disabled';
      return;
    }
    if (!storage && !(await ensureStorageAvailable())) {
      state.service.candidates.discoveryStatus = 'unavailable';
      state.service.candidates.discoveryLastError = state.service.candidates.lastError || 'Candidate storage is unavailable';
      return;
    }

    await hydrateDiscoveryState();
    state.service.candidates.discoveryStatus = 'ready';
    if (discoveryRunOnStart) await runDiscovery();
    if (!discoveryTimer) {
      discoveryTimer = setTimer(runDiscovery, Math.max(60_000, discoveryIntervalMs));
    }
  }

  async function close() {
    clearInterval(pollTimer);
    clearInterval(backfillTimer);
    clearInterval(resolutionTimer);
    clearInterval(copyPoolTimer);
    clearInterval(maintenanceTimer);
    clearInterval(discoveryTimer);
    if (shadowPollTimer) clearTimer(shadowPollTimer);
    await storage?.close();
  }

  async function startShadowPollingTimer() {
    state.service.candidates.shadowPollingEnabled = Boolean(shadowPollingEnabled);
    state.service.candidates.shadowPollIntervalMs = shadowPollIntervalMs;
    if (!shadowPollingEnabled) {
      state.service.candidates.shadowPollStatus = 'disabled';
      return;
    }
    if (!storage && !(await ensureStorageAvailable())) {
      state.service.candidates.shadowPollStatus = 'unavailable';
      state.service.candidates.shadowLastPollError = state.service.candidates.lastError || 'Candidate storage is unavailable';
      return;
    }
    state.service.candidates.shadowPollStatus = 'ready';
    state.service.candidates.shadowTraderStatus = 'ready';
    if (!shadowPollTimer) {
      shadowPollTimer = setTimer(runShadowPoll, Math.max(5_000, shadowPollIntervalMs));
    }
    if (shadowRunOnStart) await runShadowPoll();
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

  async function runShadowPoll() {
    if (!shadowPollingEnabled) {
      state.service.candidates.shadowPollStatus = 'disabled';
      return { ok: true, status: 'disabled', checked: 0, copied: 0 };
    }
    if (shadowPollRunning) {
      return {
        ok: true,
        status: 'running',
        checked: Number(state.service.candidates.shadowLastPollChecked || 0),
        copied: Number(state.service.candidates.shadowLastPollCopied || 0),
      };
    }
    if (!storage && !(await ensureStorageAvailable())) {
      const error = state.service.candidates.lastError || 'Candidate storage is unavailable';
      state.service.candidates.shadowPollStatus = 'unavailable';
      state.service.candidates.shadowLastPollError = error;
      return { ok: false, status: 'unavailable', checked: 0, copied: 0, error };
    }

    shadowPollRunning = true;
    const shadowSelections = selectedShadowWalletsForMaintenance(state);
    const walletList = [...shadowSelections.keys()];
    let checked = 0;
    let copied = 0;
    let observed = 0;
    let inserted = 0;
    let skippedOld = 0;
    const errors = [];

    try {
      state.service.candidates.shadowPollStatus = 'polling';
      state.service.candidates.shadowTraderStatus = 'polling';
      state.service.candidates.shadowLastPollError = null;
      broadcast();

      for (const wallet of walletList) {
        try {
          const rawTrades = await fetchTrades({
            user: wallet,
            side: 'BUY',
            limit: Math.max(1, shadowPollLimit),
            filterType: 'CASH',
            filterAmount: CANDIDATE_MIN_USD,
          });
          const trades = Array.isArray(rawTrades) ? rawTrades : [];
          for (const raw of trades.slice().reverse()) {
            const trade = normalizeCandidateTrade(raw, { source: 'shadow-live' });
            if (!trade || trade.wallet !== wallet) continue;
            const selected = shadowSelections.get(wallet);
            const tradeTimestampMs = Number(trade.timestamp) * 1000;
            if (!Number.isFinite(tradeTimestampMs) || tradeTimestampMs < selected.selectedAtMs) {
              skippedOld += 1;
              continue;
            }
            checked += 1;
            const upsert = await storage.upsertTrade?.(trade);
            if (upsert?.insertedTrade) inserted += 1;
            const event = observeShadowTrade(state, trade, shadowSelections, 'shadow-live');
            if (event?.shadowWatched) {
              observed += 1;
              if (event.shadowDecision?.action === 'copied') copied += 1;
            }
          }
        } catch (error) {
          errors.push({ wallet, error: error.message });
        }
      }

      const finishedAt = new Date().toISOString();
      state.service.candidates.shadowPollStatus = errors.length ? 'partial' : 'ready';
      state.service.candidates.shadowTraderStatus = 'ready';
      state.service.candidates.shadowLastPollAt = finishedAt;
      state.service.candidates.shadowLastPollChecked = checked;
      state.service.candidates.shadowLastPollCopied = copied;
      state.service.candidates.shadowLastPollObserved = observed;
      state.service.candidates.shadowLastPollInserted = inserted;
      state.service.candidates.shadowLastPollSkippedOld = skippedOld;
      state.service.candidates.shadowLastPollError = errors[0]?.error || null;
      state.service.candidates.shadowTraderLastRunAt = finishedAt;
      state.service.candidates.shadowTraderSelectedWalletCount = walletList.length;
      state.service.candidates.shadowTraderLastCopiedCount = copied;
      if (observed > 0) onStateChanged();
      broadcast();
      return {
        ok: errors.length === 0,
        status: errors.length ? 'partial' : 'ready',
        walletCount: walletList.length,
        checked,
        observed,
        copied,
        inserted,
        skippedOld,
        errors: errors.slice(0, 10),
        updatedAt: finishedAt,
      };
    } catch (error) {
      state.service.candidates.shadowPollStatus = 'error';
      state.service.candidates.shadowTraderStatus = 'error';
      state.service.candidates.shadowLastPollError = error.message;
      broadcast();
      return { ok: false, status: 'error', checked, copied, error: error.message, updatedAt: new Date().toISOString() };
    } finally {
      shadowPollRunning = false;
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

  async function runMaintenance({ force = false, forceFetch = false, forceScoring = false } = {}) {
    if (!maintenanceEnabled || maintenanceRunning) return null;
    if (!storage && !(await ensureStorageAvailable())) return null;
    maintenanceRunning = true;
    try {
      state.service.candidates.maintenanceStatus = 'running';
      state.service.candidates.maintenanceLastStartedAt = new Date().toISOString();
      state.service.candidates.maintenanceLastError = null;
      broadcast();

      const runWithDueCheck = async () => {
        const plan = await planMaintenanceRun({ force, forceFetch, forceScoring });
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

  async function runDiscovery({ force = false } = {}) {
    if ((!discoveryEnabled && !force) || discoveryRunning) return null;
    if (!storage && !(await ensureStorageAvailable())) return null;
    discoveryRunning = true;
    state.service.candidates.discoveryStatus = 'running';
    state.service.candidates.discoveryLastStartedAt = new Date().toISOString();
    state.service.candidates.discoveryLastError = null;
    broadcast();
    try {
      const due = force ? { due: true, reason: 'Forced discovery run' } : await isDiscoveryDue();
      if (!due.due) {
        state.service.candidates.discoveryStatus = 'ready';
        state.service.candidates.discoveryNextRunAt = due.nextRunAt || state.service.candidates.discoveryNextRunAt;
        return {
          ok: true,
          status: 'skipped',
          reason: due.reason,
          nextRunAt: due.nextRunAt,
          updatedAt: new Date().toISOString(),
        };
      }

      const runWithLock = async () => executeDiscovery({ reason: due.reason });
      const lockResult = storage.withMaintenanceLock
        ? await storage.withMaintenanceLock(runWithLock)
        : { acquired: true, result: await runWithLock() };

      if (!lockResult.acquired) {
        state.service.candidates.discoveryStatus = 'locked';
        return {
          ok: true,
          status: 'locked',
          reason: 'Another candidate maintenance or discovery run is already active',
          updatedAt: new Date().toISOString(),
        };
      }

      return lockResult.result;
    } catch (error) {
      state.service.candidates.discoveryStatus = 'error';
      state.service.candidates.discoveryLastError = error.message;
      state.service.candidates.lastError = error.message;
      broadcast();
      return { ok: false, status: 'error', error: error.message, updatedAt: new Date().toISOString() };
    } finally {
      discoveryRunning = false;
      broadcast();
    }
  }

  async function isDiscoveryDue() {
    if (!storage?.getServiceState) return { due: true, reason: 'No persisted discovery state reader' };
    const lastRun = await storage.getServiceState(DISCOVERY_STATE_KEY).catch(() => null);
    applyDiscoverySummary(lastRun?.payload);
    const payload = lastRun?.payload || {};
    if (payload.status !== 'done') return { due: true, reason: 'No completed discovery run' };
    const lastFinishedAt = Date.parse(payload.finishedAt || payload.updatedAt || lastRun?.updatedAt);
    if (!Number.isFinite(lastFinishedAt)) return { due: true, reason: 'Completed discovery run has no timestamp' };
    const elapsedMs = Date.now() - lastFinishedAt;
    if (elapsedMs >= discoveryIntervalMs) return { due: true, reason: 'Discovery interval elapsed' };
    return {
      due: false,
      reason: 'Discovery interval has not elapsed',
      nextRunAt: new Date(lastFinishedAt + discoveryIntervalMs).toISOString(),
    };
  }

  async function executeDiscovery({ reason = null } = {}) {
    const startedAt = new Date().toISOString();
    const candidateStatusBefore = state.service.candidates.status;
    const cutoffStage1 = new Date(Date.now() - maintenanceLookbackHours * HOUR_MS);
    const cutoffDeep = new Date(Date.now() - CANDIDATE_BACKFILL_DAYS * 24 * HOUR_MS);
    const requestBudget = Math.max(1, discoveryRequestBudget);
    let requestCount = 0;
    let rawTradeCount = 0;
    let normalizedTradeCount = 0;
    let insertedTradeCount = 0;
    const errors = [];
    const globalTrades = [];

    const canRequest = () => requestCount < requestBudget;
    const fetchWithBudget = async (params) => {
      if (!canRequest()) return { skipped: true, trades: [] };
      requestCount += 1;
      return { skipped: false, trades: await fetchTrades(params) };
    };

    for (let page = 0; page < discoveryGlobalPages && canRequest(); page += 1) {
      const offset = page * CANDIDATE_POLL_LIMIT;
      const { trades: rawTrades } = await fetchWithBudget({
        limit: CANDIDATE_POLL_LIMIT,
        offset,
        side: 'BUY',
        filterType: 'CASH',
        filterAmount: CANDIDATE_MIN_USD,
      });
      if (!rawTrades.length) break;
      rawTradeCount += rawTrades.length;
      for (const raw of rawTrades.slice().reverse()) {
        const trade = normalizeCandidateTrade(raw, { source: 'discovery' });
        if (!isDiscoveryCopyableTrade(trade)) continue;
        normalizedTradeCount += 1;
        globalTrades.push(trade);
        const upsert = await storage.upsertDiscoveryTrade?.(trade);
        if (upsert?.insertedTrade) insertedTradeCount += 1;
      }
    }

    const signals = buildDiscoverySignals(globalTrades);
    const savedWallets = await storage.saveDiscoverySignals?.(signals);
    const runnableWallets = new Set(
      (Array.isArray(savedWallets) ? savedWallets : signals.map((signal) => signal.wallet))
        .map((entry) => normalizeWallet(entry?.wallet || entry))
        .filter(Boolean)
    );
    const stage1Candidates = signals
      .filter((signal) => runnableWallets.has(signal.wallet))
      .filter((signal) => passesDiscoverySignal(signal))
      .slice(0, discoveryMaxStage1Wallets);
    const stage1Wallets = stage1Candidates.map((signal) => signal.wallet);
    if (stage1Wallets.length) await storage.markDiscoveryWallets?.(stage1Wallets, 'stage1_promoted');

    const stage1Results = [];
    for (const signal of stage1Candidates) {
      const result = await fetchDiscoveryWalletHistory({
        wallet: signal.wallet,
        cutoff: cutoffStage1,
        maxPages: 1,
        source: 'discovery_stage1',
        fetchWithBudget,
      });
      rawTradeCount += result.rawTradeCount;
      normalizedTradeCount += result.normalizedTradeCount;
      insertedTradeCount += result.insertedTradeCount;
      errors.push(...result.errors);
      stage1Results.push({ ...signal, stage1: result });
    }

    const rejectedStage1 = stage1Results.filter((row) => !passesDiscoveryStage1(row.stage1));
    if (rejectedStage1.length) {
      await storage.markDiscoveryWallets?.(
        rejectedStage1.map((row) => row.wallet),
        'rejected',
        {
          rejectReason: 'Insufficient recent copyable activity in stage 1',
          cooldownUntil: new Date(Date.now() + discoveryCooldownMs).toISOString(),
        }
      );
    }

    const deepCandidates = stage1Results
      .filter((row) => passesDiscoveryStage1(row.stage1))
      .sort((a, b) => b.signalScore - a.signalScore)
      .slice(0, discoveryMaxDeepBackfills);
    const deepWallets = deepCandidates.map((row) => row.wallet);
    if (deepWallets.length) await storage.markDiscoveryWallets?.(deepWallets, 'deep_promoted');

    let resolvedTradeCount = 0;
    const deepFetchedWallets = [];
    const rejectedDeep = [];
    for (let index = 0; index < deepCandidates.length; index += 1) {
      const row = deepCandidates[index];
      const remainingWallets = Math.max(1, deepCandidates.length - index);
      const remainingBudget = Math.max(0, requestBudget - requestCount);
      const maxPages = Math.max(1, Math.min(CANDIDATE_BACKFILL_MAX_PAGES, Math.floor(remainingBudget / remainingWallets) || 1));
      const result = await fetchDiscoveryWalletHistory({
        wallet: row.wallet,
        cutoff: cutoffDeep,
        maxPages,
        source: 'discovery_deep',
        fetchWithBudget,
      });
      rawTradeCount += result.rawTradeCount;
      normalizedTradeCount += result.normalizedTradeCount;
      insertedTradeCount += result.insertedTradeCount;
      errors.push(...result.errors);
      if (result.normalizedTradeCount <= 0) {
        rejectedDeep.push(row.wallet);
        continue;
      }
      deepFetchedWallets.push(row.wallet);
    }

    if (deepFetchedWallets.length) {
      const resolution = await runResolution({
        maxTrades: Math.min(maintenanceResolutionMaxTrades, Math.max(100, discoveryMaxDeepBackfills * 100)),
        evaluateCopyPoolOnSettle: false,
      });
      resolvedTradeCount = Number(resolution?.settled || 0);
      if (!enabled) state.service.candidates.status = candidateStatusBefore || 'disabled';
    }

    const scoredWallets = [];
    for (const wallet of deepFetchedWallets) {
      const scoring = await runRealCopyQualityScoring({ wallet });
      if (scoring?.ok === false) {
        errors.push({ wallet, phase: 'scoring', error: scoring.error || 'ECP scoring failed' });
        rejectedDeep.push(wallet);
        continue;
      }
      scoredWallets.push(wallet);
    }

    if (scoredWallets.length) await storage.markDiscoveryWallets?.(scoredWallets, 'scored');
    if (rejectedDeep.length) {
      await storage.markDiscoveryWallets?.(rejectedDeep, 'rejected', {
        rejectReason: 'No deep copyable activity available for scoring',
        cooldownUntil: new Date(Date.now() + discoveryCooldownMs).toISOString(),
      });
    }

    const finishedAt = new Date().toISOString();
    const summary = {
      ok: errors.length === 0,
      status: errors.length ? 'partial' : 'done',
      reason,
      startedAt,
      finishedAt,
      nextRunAt: new Date(Date.parse(finishedAt) + discoveryIntervalMs).toISOString(),
      requestBudget,
      requestCount,
      globalPages: discoveryGlobalPages,
      rawTradeCount,
      normalizedTradeCount,
      insertedTradeCount,
      resolvedTradeCount,
      walletsSeen: signals.length,
      walletsHeld: Array.isArray(savedWallets) ? savedWallets.length : signals.length,
      stage1Promoted: stage1Wallets.length,
      deepPromoted: deepWallets.length,
      scored: scoredWallets.length,
      rejected: rejectedStage1.length + rejectedDeep.length,
      errorCount: errors.length,
      errors: errors.slice(0, 10),
      updatedAt: finishedAt,
    };
    await storage.saveServiceState?.(DISCOVERY_STATE_KEY, summary);
    applyDiscoverySummary(summary);
    state.service.candidates.discoveryStatus = errors.length ? 'partial' : 'ready';
    state.service.candidates.discoveryLastError = errors[0]?.error || null;
    state.service.candidates.lastError = null;
    broadcast();
    return summary;
  }

  async function planMaintenanceRun({ force = false, forceFetch = false, forceScoring = false } = {}) {
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
      fetchDue: forceFetch || fetchDue.due,
      scoringDue: forceScoring || scoringDue.due,
      fetchReason: forceFetch ? 'Forced maintenance fetch' : fetchDue.reason,
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
    const shadowSelections = selectedShadowWalletsForMaintenance(state);
    const shadowSelectedWallets = [...shadowSelections.keys()];
    const wallets = runFetch
      ? await storage.getMaintenanceWallets?.({
          scope: maintenanceScope,
          baselineWallets: WATCHED_WALLETS,
        })
      : [];
    const walletList = runFetch && Array.isArray(wallets) ? uniqueWallets([...wallets, ...shadowSelectedWallets]) : [];
    const errors = [];

    let fetchResult = emptyMaintenanceFetchResult();
    if (runFetch) {
      fetchResult = await fetchMaintenanceTradesForWallets({ walletList, cutoff, maxPagesForRun, shadowSelections });
      errors.push(...fetchResult.errors);
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
      requestCount: fetchResult.requestCount,
      rawTradeCount: fetchResult.rawTradeCount,
      normalizedTradeCount: fetchResult.normalizedTradeCount,
      insertedTradeCount: fetchResult.insertedTradeCount,
      resolvedTradeCount: Number(resolution?.settled || 0),
      resolutionCheckedCount: Number(resolution?.checked || 0),
      copyPoolChangedCount: Array.isArray(copyPoolResult?.changed) ? copyPoolResult.changed.length : 0,
      shadowSelectedWalletCount: shadowSelectedWallets.length,
      shadowObservedTradeCount: fetchResult.shadowObservedTradeCount,
      shadowCopiedTradeCount: fetchResult.shadowCopiedTradeCount,
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

  async function runShadowObservation({ lookbackHours = maintenanceLookbackHours } = {}) {
    if (!storage && !(await ensureStorageAvailable())) return null;
    const startedAt = new Date().toISOString();
    const shadowSelections = selectedShadowWalletsForMaintenance(state);
    const walletList = [...shadowSelections.keys()];
    const runLookbackHours = Math.max(1, Number(lookbackHours) || maintenanceLookbackHours);
    const maxPagesForRun = maintenancePagesForLookback(runLookbackHours);
    const cutoff = new Date(Date.now() - runLookbackHours * HOUR_MS);

    if (!walletList.length) {
      return {
        ok: true,
        status: 'skipped',
        reason: 'No selected shadow wallets to observe',
        scope: 'shadow_selected',
        startedAt,
        finishedAt: new Date().toISOString(),
        walletCount: 0,
      };
    }

    const runWithLock = async () => {
      state.service.candidates.shadowTraderStatus = 'observing';
      broadcast();
      const fetchResult = await fetchMaintenanceTradesForWallets({ walletList, cutoff, maxPagesForRun, shadowSelections });
      const finishedAt = new Date().toISOString();
      const summary = {
        ok: fetchResult.errors.length === 0,
        status: fetchResult.errors.length ? 'partial' : 'done',
        scope: 'shadow_selected',
        lookbackHours: runLookbackHours,
        maxPagesPerWallet: maxPagesForRun,
        cutoffAt: cutoff.toISOString(),
        startedAt,
        finishedAt,
        walletCount: walletList.length,
        requestCount: fetchResult.requestCount,
        rawTradeCount: fetchResult.rawTradeCount,
        normalizedTradeCount: fetchResult.normalizedTradeCount,
        insertedTradeCount: fetchResult.insertedTradeCount,
        shadowSelectedWalletCount: walletList.length,
        shadowObservedTradeCount: fetchResult.shadowObservedTradeCount,
        shadowCopiedTradeCount: fetchResult.shadowCopiedTradeCount,
        errorCount: fetchResult.errors.length,
        errors: fetchResult.errors.slice(0, 10),
        updatedAt: finishedAt,
      };
      state.service.candidates.shadowTraderStatus = 'ready';
      state.service.candidates.shadowTraderLastRunAt = finishedAt;
      state.service.candidates.shadowTraderLastCopiedCount = fetchResult.shadowCopiedTradeCount;
      state.service.candidates.lastError = null;
      if (fetchResult.shadowObservedTradeCount > 0) onStateChanged();
      broadcast();
      return summary;
    };

    try {
      const lockResult = storage.withMaintenanceLock
        ? await storage.withMaintenanceLock(runWithLock)
        : { acquired: true, result: await runWithLock() };
      if (!lockResult.acquired) {
        state.service.candidates.shadowTraderStatus = 'locked';
        return {
          ok: true,
          status: 'locked',
          reason: 'Another candidate maintenance run is already active',
          updatedAt: new Date().toISOString(),
        };
      }
      return lockResult.result;
    } catch (error) {
      state.service.candidates.shadowTraderStatus = 'error';
      state.service.candidates.lastError = error.message;
      broadcast();
      return { ok: false, status: 'error', error: error.message, updatedAt: new Date().toISOString() };
    }
  }

  async function fetchMaintenanceTradesForWallets({ walletList, cutoff, maxPagesForRun, shadowSelections }) {
    const result = emptyMaintenanceFetchResult();
    for (const wallet of walletList) {
      try {
        let reachedCutoff = false;
        for (let page = 0; page < maxPagesForRun && !reachedCutoff; page += 1) {
          const offset = page * Math.max(1, maintenancePageLimit);
          result.requestCount += 1;
          const rawTrades = await fetchTrades({
            user: wallet,
            limit: Math.max(1, maintenancePageLimit),
            offset,
            filterType: 'CASH',
            filterAmount: CANDIDATE_MIN_USD,
          });
          if (!rawTrades.length) break;
          result.rawTradeCount += rawTrades.length;

          for (const raw of rawTrades.slice().reverse()) {
            const rawTimestamp = toUnixSeconds(raw.timestamp ?? raw.createdAt ?? raw.ts);
            if (rawTimestamp && rawTimestamp * 1000 < cutoff.getTime()) {
              reachedCutoff = true;
              continue;
            }
            const trade = normalizeCandidateTrade(raw, { source: 'maintenance' });
            if (!trade) continue;
            result.normalizedTradeCount += 1;
            const upsert = await storage.upsertTrade(trade);
            if (upsert.insertedTrade) result.insertedTradeCount += 1;
            const shadowEvent = observeShadowTrade(state, trade, shadowSelections, 'shadow-maintenance');
            if (shadowEvent?.shadowWatched) {
              result.shadowObservedTradeCount += 1;
              if (shadowEvent.shadowDecision?.action === 'copied') result.shadowCopiedTradeCount += 1;
            }
          }
        }
      } catch (error) {
        result.errors.push({ wallet, error: error.message });
      }
    }
    return result;
  }

  async function fetchDiscoveryWalletHistory({ wallet, cutoff, maxPages, source, fetchWithBudget }) {
    const result = {
      wallet,
      rawTradeCount: 0,
      normalizedTradeCount: 0,
      insertedTradeCount: 0,
      distinctMarketCount: 0,
      distinctEventCount: 0,
      medianEntryCents: null,
      errors: [],
    };
    const markets = new Set();
    const events = new Set();
    const entries = [];
    let reachedCutoff = false;
    try {
      for (let page = 0; page < Math.max(1, maxPages) && !reachedCutoff; page += 1) {
        const offset = page * Math.max(1, maintenancePageLimit);
        const { skipped, trades: rawTrades } = await fetchWithBudget({
          user: wallet,
          limit: Math.max(1, maintenancePageLimit),
          offset,
          side: 'BUY',
          filterType: 'CASH',
          filterAmount: CANDIDATE_MIN_USD,
        });
        if (skipped || !rawTrades.length) break;
        result.rawTradeCount += rawTrades.length;
        for (const raw of rawTrades.slice().reverse()) {
          const rawTimestamp = toUnixSeconds(raw.timestamp ?? raw.createdAt ?? raw.ts);
          if (rawTimestamp && rawTimestamp * 1000 < cutoff.getTime()) {
            reachedCutoff = true;
            continue;
          }
          const trade = normalizeCandidateTrade(raw, { source });
          if (!isDiscoveryCopyableTrade(trade)) continue;
          result.normalizedTradeCount += 1;
          const upsert = await storage.upsertDiscoveryTrade?.(trade);
          if (upsert?.insertedTrade) result.insertedTradeCount += 1;
          const marketKey = discoveryMarketKey(trade);
          if (marketKey) markets.add(marketKey);
          if (trade.eventSlug || trade.conditionId || trade.marketSlug) events.add(trade.eventSlug || trade.conditionId || trade.marketSlug);
          if (Number.isFinite(trade.priceCents)) entries.push(trade.priceCents);
        }
      }
    } catch (error) {
      result.errors.push({ wallet, phase: source, error: error.message });
    }
    result.distinctMarketCount = markets.size;
    result.distinctEventCount = events.size;
    result.medianEntryCents = median(entries);
    return result;
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
    if (!storage && !(await ensureStorageAvailable())) {
      return { ok: false, error: state.service.candidates.lastError || 'Candidate storage is unavailable' };
    }
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

  async function runRealCopyQualityScoring({ scope = 'all_candidates', wallet = null } = {}) {
    if (realCopyQualityRunning) return state.service.realCopyQuality;
    if (!storage && !(await ensureStorageAvailable())) {
      return { ok: false, error: state.service.realCopyQuality.lastError || 'Candidate storage is unavailable' };
    }
    realCopyQualityRunning = true;
    realCopyQualityLeaderboardCache.clear();
    try {
      state.service.realCopyQuality.status = 'scoring';
      broadcast();
      const result = await storage.recalculateRealCopyQuality?.({
        scope: wallet ? 'wallet' : scope,
        wallet,
        baselineWallets: WATCHED_WALLETS,
      });
      realCopyQualityLeaderboardCache.clear();
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
    const cacheKey = realCopyQualityLeaderboardCacheKey(params);
    const cached = realCopyQualityLeaderboardCache.get(cacheKey);
    if (cached && Date.now() - cached.storedAt < realCopyQualityLeaderboardCacheMs) {
      return { ...cached.payload, updatedAt: new Date().toISOString(), cacheHit: true };
    }
    const payload = await storage.getRealCopyQualityLeaderboard(params);
    applyRealCopyQualitySummary(payload.summary, payload.summary?.total || 0);
    const response = {
      ...payload,
      enabled: realCopyQualityActive,
      cached: !realCopyQualityActive,
      status: realCopyQualityActive ? state.service.realCopyQuality.status : 'cached',
      updatedAt: new Date().toISOString(),
    };
    realCopyQualityLeaderboardCache.set(cacheKey, { payload: response, storedAt: Date.now() });
    return response;
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
    state.service.candidates.shadowTraderLastCopiedCount = Number(summary.shadowCopiedTradeCount || 0);
    if (hasScoringSummary(summary)) applyMaintenanceScoringSummary(summary);
    state.service.candidates.maintenanceLastErrorCount = Number(summary.errorCount || 0);
    state.service.candidates.maintenanceLastError = Array.isArray(summary.errors) && summary.errors.length
      ? summary.errors[0]?.error || null
      : null;
  }

  function applyDiscoverySummary(summary = {}) {
    if (!summary || typeof summary !== 'object') return;
    state.service.candidates.discoveryLastRunAt = summary.finishedAt || summary.updatedAt || null;
    state.service.candidates.discoveryLastStartedAt = summary.startedAt || state.service.candidates.discoveryLastStartedAt;
    state.service.candidates.discoveryLastFinishedAt = summary.finishedAt || null;
    state.service.candidates.discoveryNextRunAt = summary.nextRunAt || null;
    state.service.candidates.discoveryLastRequestCount = Number(summary.requestCount || 0);
    state.service.candidates.discoveryLastWalletsSeen = Number(summary.walletsSeen || 0);
    state.service.candidates.discoveryLastWalletsHeld = Number(summary.walletsHeld || 0);
    state.service.candidates.discoveryLastStage1Promoted = Number(summary.stage1Promoted || 0);
    state.service.candidates.discoveryLastDeepPromoted = Number(summary.deepPromoted || 0);
    state.service.candidates.discoveryLastScored = Number(summary.scored || 0);
    state.service.candidates.discoveryLastRejected = Number(summary.rejected || 0);
    state.service.candidates.discoveryLastError = Array.isArray(summary.errors) && summary.errors.length
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
    runDiscovery,
    runShadowPoll,
    runShadowObservation,
    runCopyPoolEvaluation,
    runShadowTraderEvaluation,
    runRealCopyQualityScoring,
    getRealCopyQualityLeaderboard,
    getRealCopyQualityScore,
    recalculateRealCopyQuality,
  };
}

function selectedShadowWalletsForMaintenance(state) {
  const shadow = state?.shadowTrader || {};
  const fallbackSelectedAt = timestampMs(shadow.lastEvaluatedAt) ?? Date.now();
  const selected = new Map();
  for (const [walletKey, row] of Object.entries(shadow.selectedWallets || {})) {
    if (row?.status && row.status !== 'active') continue;
    const wallet = normalizeWallet(row?.wallet || walletKey);
    if (!wallet) continue;
    selected.set(wallet, {
      wallet,
      selectedAtMs: timestampMs(row?.selectedAt || row?.lastEvaluatedAt) ?? fallbackSelectedAt,
    });
  }
  return selected;
}

function isDiscoveryCopyableTrade(trade) {
  if (!trade || trade.side !== 'BUY') return false;
  if (!Number.isFinite(trade.priceCents) || trade.priceCents > REAL_MAX_ENTRY_PRICE_CENTS) return false;
  return Number.isFinite(trade.usdSize) && trade.usdSize >= CANDIDATE_MIN_USD && trade.usdSize < CANDIDATE_MAX_USD;
}

function buildDiscoverySignals(trades = []) {
  const byWallet = new Map();
  for (const trade of trades) {
    const wallet = normalizeWallet(trade.wallet);
    if (!wallet) continue;
    if (!byWallet.has(wallet)) {
      byWallet.set(wallet, {
        wallet,
        displayName: trade.displayName || null,
        pseudonym: trade.pseudonym || null,
        profileImage: trade.profileImage || null,
        recentBuyCount: 0,
        markets: new Set(),
        events: new Set(),
        entries: [],
        usdSizes: [],
        firstSeenMs: null,
        lastSeenMs: null,
      });
    }
    const signal = byWallet.get(wallet);
    signal.recentBuyCount += 1;
    if (!signal.displayName && trade.displayName) signal.displayName = trade.displayName;
    if (!signal.pseudonym && trade.pseudonym) signal.pseudonym = trade.pseudonym;
    if (!signal.profileImage && trade.profileImage) signal.profileImage = trade.profileImage;
    const marketKey = discoveryMarketKey(trade);
    if (marketKey) signal.markets.add(marketKey);
    if (trade.eventSlug || trade.conditionId || trade.marketSlug) {
      signal.events.add(trade.eventSlug || trade.conditionId || trade.marketSlug);
    }
    if (Number.isFinite(trade.priceCents)) signal.entries.push(trade.priceCents);
    if (Number.isFinite(trade.usdSize)) signal.usdSizes.push(trade.usdSize);
    const seenMs = timestampMs(trade.tradeTimestamp || trade.timestamp);
    if (seenMs) {
      signal.firstSeenMs = signal.firstSeenMs ? Math.min(signal.firstSeenMs, seenMs) : seenMs;
      signal.lastSeenMs = signal.lastSeenMs ? Math.max(signal.lastSeenMs, seenMs) : seenMs;
    }
  }

  return [...byWallet.values()]
    .map((signal) => {
      const medianEntryCents = median(signal.entries);
      const maxTradeUsd = signal.usdSizes.length ? Math.max(...signal.usdSizes) : null;
      const distinctMarketCount = signal.markets.size;
      const distinctEventCount = signal.events.size;
      const signalScore = discoverySignalScore({
        recentBuyCount: signal.recentBuyCount,
        distinctMarketCount,
        distinctEventCount,
        medianEntryCents,
      });
      return {
        wallet: signal.wallet,
        displayName: signal.displayName,
        pseudonym: signal.pseudonym,
        profileImage: signal.profileImage,
        signalScore,
        recentBuyCount: signal.recentBuyCount,
        distinctMarketCount,
        distinctEventCount,
        medianEntryCents,
        maxTradeUsd,
        firstSeenAt: signal.firstSeenMs ? new Date(signal.firstSeenMs).toISOString() : null,
        lastSeenAt: signal.lastSeenMs ? new Date(signal.lastSeenMs).toISOString() : null,
        rawMetrics: {
          recentBuyCount: signal.recentBuyCount,
          distinctMarketCount,
          distinctEventCount,
          medianEntryCents,
          maxTradeUsd,
        },
      };
    })
    .sort((a, b) => b.signalScore - a.signalScore);
}

function discoverySignalScore({ recentBuyCount, distinctMarketCount, distinctEventCount, medianEntryCents }) {
  const activity = Math.min(40, Math.max(0, recentBuyCount) * 10);
  const marketBreadth = Math.min(25, Math.max(0, distinctMarketCount) * 8);
  const eventBreadth = Math.min(20, Math.max(0, distinctEventCount) * 10);
  const entryBonus = Number.isFinite(medianEntryCents)
    ? Math.max(0, Math.min(15, (REAL_MAX_ENTRY_PRICE_CENTS - medianEntryCents) / 5))
    : 0;
  return Math.round((activity + marketBreadth + eventBreadth + entryBonus) * 100) / 100;
}

function passesDiscoverySignal(signal) {
  return (
    Number(signal?.recentBuyCount || 0) >= 2
    && Number(signal?.distinctMarketCount || 0) >= 2
    && Number(signal?.distinctEventCount || 0) >= 1
    && Number(signal?.medianEntryCents || 999) <= REAL_MAX_ENTRY_PRICE_CENTS
  );
}

function passesDiscoveryStage1(result) {
  return (
    Number(result?.normalizedTradeCount || 0) >= 2
    && Number(result?.distinctMarketCount || 0) >= 2
    && Number(result?.medianEntryCents || 999) <= REAL_MAX_ENTRY_PRICE_CENTS
  );
}

function discoveryMarketKey(trade) {
  return trade?.conditionId || trade?.marketSlug || trade?.asset || null;
}

function median(values = []) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function observeShadowTrade(state, trade, shadowSelections, source = 'shadow-maintenance') {
  const wallet = normalizeWallet(trade?.wallet);
  if (!wallet || !shadowSelections?.has(wallet)) return null;
  const selected = shadowSelections.get(wallet);
  const tradeTimestampMs = Number(trade.timestamp) * 1000;
  if (!Number.isFinite(tradeTimestampMs) || tradeTimestampMs < selected.selectedAtMs) return null;
  const demoTrade = candidateTradeToDemoTrade(trade);
  return demoTrade ? ingestTrade(state, demoTrade, source) : null;
}

function emptyMaintenanceFetchResult() {
  return {
    requestCount: 0,
    rawTradeCount: 0,
    normalizedTradeCount: 0,
    insertedTradeCount: 0,
    shadowObservedTradeCount: 0,
    shadowCopiedTradeCount: 0,
    errors: [],
  };
}

function uniqueWallets(wallets = []) {
  return [...new Set((wallets || []).map(normalizeWallet).filter(Boolean))];
}

function timestampMs(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
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

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
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

function realCopyQualityLeaderboardCacheKey(params = {}) {
  return JSON.stringify({
    limit: params.limit ?? 100,
    offset: params.offset ?? 0,
    q: String(params.q || '').trim().toLowerCase(),
    tier: params.tier || 'all',
    eligible: params.eligible === true ? true : params.eligible === false ? false : null,
    sort: params.sort || 'expectedProfit',
    order: params.order || 'desc',
  });
}

function hasScoringSummary(summary = {}) {
  if (!summary || typeof summary !== 'object') return false;
  if (summary.scoringStatus === 'done' || summary.scoringStatus === 'error') return true;
  if (summary.scoredAt) return true;
  return Number(summary.scoredWalletCount || 0) > 0;
}
