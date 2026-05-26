import { settleDemoPosition, updateOpenPositionPrices } from './demo-engine.js';

export async function reconcileOpenDemoPositions(state, fetchTradeById, fetchMarketResolution = null) {
  const portfolios = [
    { key: 'demo', portfolio: state.demo },
    { key: 'shadowTrader', portfolio: state.shadowTrader?.portfolio },
  ].filter((item) => item.portfolio);
  const openPositions = portfolios.flatMap(({ key, portfolio }) => {
    return [...(portfolio.openPositions || [])].map((position) => ({ key, portfolio, position }));
  });
  if (!openPositions.length) {
    return { changed: false, checked: 0, settled: [], errors: [] };
  }

  let changed = false;
  const settled = [];
  const errors = [];

  const results = await Promise.all(
    openPositions.map(async (entry) => {
      try {
        const trade = await fetchTradeById(entry.position.sourceTradeId);
        return { ...entry, trade, fetchError: null };
      } catch (error) {
        return { ...entry, trade: null, fetchError: error };
      }
    })
  );

  for (const result of results) {
    const { portfolio, position, fetchError } = result;

    const livePosition = portfolio.openPositions.find((item) => item.id === position.id);
    if (!livePosition) continue;

    const trade = result.trade || buildPositionResolutionTrade(livePosition);
    if (!trade) {
      const message = fetchError ? errorMessage(fetchError) : `No trade returned for ${position.sourceTradeId}`;
      errors.push(message);
      setResolutionDiagnostic(livePosition, 'whale_fetch_failed', message);
      continue;
    }

    const previousPrice = livePosition.currentPriceCents;
    livePosition.resolutionLastCheckedAt = new Date().toISOString();

    if (result.trade) {
      updateOpenPositionPrices(portfolio, trade);
      livePosition.resolutionFetchStatus = 'ok';
      livePosition.resolutionFetchError = null;
      livePosition.resolutionStatus = trade.resolution?.status || livePosition.resolutionStatus || 'open';
      if (trade.resolution?.winningOutcome) livePosition.winningOutcome = trade.resolution.winningOutcome;
    } else {
      livePosition.resolutionFetchStatus = 'failed';
      livePosition.resolutionFetchError = fetchError
        ? errorMessage(fetchError)
        : `No trade returned for ${position.sourceTradeId}`;
      if (!livePosition.resolutionStatus) livePosition.resolutionStatus = 'open';
    }

    if (previousPrice !== livePosition.currentPriceCents) changed = true;

    let gammaResolution = null;
    try {
      gammaResolution = await fetchFallbackResolution(livePosition, trade, fetchMarketResolution, {
        force: Boolean(fetchError),
      });
    } catch (error) {
      const message = `Gamma resolution failed for ${position.sourceTradeId}: ${errorMessage(error)}`;
      errors.push(message);
      if (setResolutionDiagnostic(livePosition, 'gamma_resolution_failed', message)) changed = true;
    }

    if (gammaResolution) {
      if (setResolutionDiagnostic(livePosition, gammaDiagnosticCode(gammaResolution), gammaDiagnosticDetail(gammaResolution))) {
        changed = true;
      }
    } else if (fetchError) {
      const canUseGammaFallback = Boolean(fetchMarketResolution && hasResolutionLookupKey(livePosition, trade));
      const message = canUseGammaFallback
        ? `Whale fetch failed; waiting on Gamma fallback for ${position.sourceTradeId}`
        : `Whale fetch failed and no Gamma fallback is available for ${position.sourceTradeId}`;
      if (!canUseGammaFallback) errors.push(message);
      if (setResolutionDiagnostic(livePosition, 'whale_fetch_failed', message)) changed = true;
    }

    const resolutionTrade = gammaResolution ? { ...trade, resolution: gammaResolution } : trade;
    if (gammaResolution?.status && gammaResolution.status !== 'open') {
      livePosition.resolutionStatus = gammaResolution.status;
      livePosition.resolutionSource = gammaResolution.source;
      if (gammaResolution.winningOutcome) livePosition.winningOutcome = gammaResolution.winningOutcome;
    }

    const settlement = buildSettlementForPosition(livePosition, resolutionTrade);
    if (!settlement) continue;

    setResolutionDiagnostic(
      livePosition,
      settlement.settlementSource === 'polymarket-gamma' ? 'settled_from_gamma' : 'settled_from_polywhale',
      `Settled from ${settlement.settlementSource || 'official resolution'}`
    );
    const closed = settleDemoPosition(portfolio, livePosition.id, settlement);
    if (closed) {
      changed = true;
      settled.push(closed);
    }
  }

  return { changed, checked: openPositions.length, settled, errors };
}

function buildPositionResolutionTrade(position) {
  if (!position?.sourceTradeId) return null;
  const timestamp = Date.parse(position.openedAt || position.createdAt || position.updatedAt);
  return {
    id: position.sourceTradeId,
    side: position.side || 'BUY',
    outcome: position.outcome,
    usdSize: position.stakeUsd,
    shares: position.shares,
    priceCents: position.currentPriceCents ?? position.entryPriceCents,
    timestamp: Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : Math.floor(Date.now() / 1000),
    market: {
      conditionId: position.marketConditionId || null,
      slug: position.marketSlug || null,
      title: position.marketTitle || null,
      icon: position.marketIcon || null,
      polymarketUrl: position.polymarketUrl || null,
      yesPriceCents: null,
      noPriceCents: null,
    },
    trader: {
      proxyWallet: position.traderWallet || null,
      displayName: position.traderName || null,
    },
    resolution: { status: position.resolutionStatus || 'open', pnlUsd: null },
  };
}

export function buildSettlementForPosition(position, trade) {
  const resolution = trade?.resolution || {};
  const resolutionStatus = String(resolution.status || '').toLowerCase();

  if (!isResolvableStatus(resolutionStatus, resolution)) return null;

  if (resolutionStatus === 'invalid') {
    return {
      status: 'invalid',
      exitPriceCents: position.entryPriceCents,
      exitValueUsd: position.stakeUsd,
      realizedPnlUsd: 0,
      resolvedAt: resolution.resolvedAt,
      resolutionStatus,
      winningOutcome: resolution.winningOutcome || null,
      settlementSource: resolution.source || 'polywhale-resolution',
      sourceTradeId: trade.id,
      reason: 'Market invalidated; demo stake refunded',
    };
  }

  const won = inferWin(position, resolution);
  if (won === null) return null;

  const exitValueUsd = won ? position.shares : 0;
  const realizedPnlUsd = exitValueUsd - position.stakeUsd;

  return {
    status: won ? 'win' : 'loss',
    exitPriceCents: won ? 100 : 0,
    exitValueUsd,
    realizedPnlUsd,
    resolvedAt: resolution.resolvedAt,
    resolutionStatus,
    winningOutcome: resolution.winningOutcome || null,
    settlementSource: resolution.source || 'polywhale-resolution',
    sourceTradeId: trade.id,
    reason: `Official market resolution: ${won ? 'won' : 'lost'} ${formatSignedUsd(realizedPnlUsd)}`,
  };
}

async function fetchFallbackResolution(position, trade, fetchMarketResolution, options = {}) {
  if (!fetchMarketResolution) return null;
  if (!hasResolutionLookupKey(position, trade)) return null;

  const resolution = trade?.resolution || {};
  const resolutionStatus = String(resolution.status || '').toLowerCase();
  if (!options.force && isResolvableStatus(resolutionStatus, resolution) && !needsResolutionCrossCheck(position, resolution)) {
    return null;
  }

  return fetchMarketResolution({
    conditionId: trade?.market?.conditionId || position.marketConditionId || null,
    slug: trade?.market?.slug || position.marketSlug || null,
  });
}

function hasResolutionLookupKey(position, trade) {
  return Boolean(
    trade?.market?.conditionId ||
      position?.marketConditionId ||
      trade?.market?.slug ||
      position?.marketSlug
  );
}

function isResolvableStatus(status, resolution) {
  if (status === 'invalid' || status === 'resolved_win' || status === 'resolved_loss') return true;
  if (status === 'resolved' && resolution.winningOutcome) return true;
  return hasNumericValue(resolution.pnlUsd);
}

function inferWin(position, resolution) {
  const status = String(resolution.status || '').toLowerCase();

  const match = outcomeMatches(position.outcome, resolution.winningOutcome);
  if (match !== null) return match;

  if (isBinaryOutcome(resolution.winningOutcome) && !isBinaryOutcome(position.outcome)) {
    return null;
  }

  if (status === 'resolved_win') return true;
  if (status === 'resolved_loss') return false;

  if (hasNumericValue(resolution.pnlUsd)) {
    return Number(resolution.pnlUsd) >= 0;
  }

  return null;
}

function outcomeMatches(outcome, winningOutcome) {
  const normalizedOutcome = normalizeOutcomeLabel(outcome);
  const normalizedWinner = normalizeOutcomeLabel(winningOutcome);
  if (!normalizedOutcome || !normalizedWinner) return null;
  if (normalizedOutcome === normalizedWinner) return true;
  if (isBinaryOutcome(normalizedOutcome) !== isBinaryOutcome(normalizedWinner)) return null;
  return false;
}

function needsResolutionCrossCheck(position, resolution) {
  const status = String(resolution.status || '').toLowerCase();
  if (!['resolved', 'resolved_win', 'resolved_loss'].includes(status)) return false;

  if (isBinaryOutcome(resolution.winningOutcome) && !isBinaryOutcome(position.outcome)) {
    return true;
  }

  const match = outcomeMatches(position.outcome, resolution.winningOutcome);
  if (match === null) return false;
  if (status === 'resolved_win' && !match) return true;
  if (status === 'resolved_loss' && match) return true;
  return false;
}

function normalizeOutcomeLabel(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toUpperCase();
  return text || null;
}

function isBinaryOutcome(value) {
  return ['YES', 'NO'].includes(normalizeOutcomeLabel(value));
}

function hasNumericValue(value) {
  if (value === null || value === undefined || value === '') return false;
  return Number.isFinite(Number(value));
}

function setResolutionDiagnostic(position, code, detail) {
  if (!position || !code) return false;
  const changed = position.resolutionDiagnostic !== code || position.resolutionDiagnosticDetail !== detail;
  position.resolutionDiagnostic = code;
  position.resolutionDiagnosticDetail = detail;
  return changed;
}

function gammaDiagnosticCode(resolution) {
  if (resolution?.status === 'resolved' || resolution?.status === 'resolved_win' || resolution?.status === 'resolved_loss') {
    return 'gamma_resolved';
  }
  if (resolution?.status === 'closed') return 'gamma_closed_no_winner';
  if (resolution?.rawStatus === 'gamma_proposed') return 'gamma_proposed';
  if (resolution?.rawStatus === 'gamma_near_final_open') return 'gamma_near_final_open';
  return 'gamma_open';
}

function gammaDiagnosticDetail(resolution) {
  const status = gammaDiagnosticCode(resolution);
  if (status === 'gamma_resolved') return `Gamma resolved winner ${resolution.winningOutcome || 'unknown'}`;
  if (status === 'gamma_closed_no_winner') return 'Gamma market is closed but no final winning outcome is available yet';
  if (status === 'gamma_proposed') return 'Gamma market has a proposed result; waiting for official close';
  if (status === 'gamma_near_final_open') return 'Gamma prices look near-final; waiting for official close';
  return 'Gamma market is still open';
}

function errorMessage(error) {
  return error?.message || String(error);
}

function formatSignedUsd(value) {
  const prefix = value >= 0 ? '+' : '-';
  return `${prefix}$${Math.abs(value).toFixed(2)}`;
}
