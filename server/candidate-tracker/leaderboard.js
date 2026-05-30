export function buildLeaderboardRows(traders = [], trades = [], { limit = 100, offset = 0, now = Date.now() } = {}) {
  const entryWindowMs = 30 * 24 * 60 * 60 * 1000;
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const traderMap = new Map();
  for (const trader of traders) {
    if (!trader?.wallet) continue;
    traderMap.set(String(trader.wallet).toLowerCase(), {
      wallet: String(trader.wallet).toLowerCase(),
      displayName: trader.displayName || null,
      pseudonym: trader.pseudonym || null,
      profileImage: trader.profileImage || null,
      firstSeenAt: trader.firstSeenAt || null,
      lastSeenAt: trader.lastSeenAt || null,
      backfillStatus: trader.backfillStatus || 'unknown',
    });
  }

  for (const trade of trades) {
    const wallet = String(trade?.wallet || '').toLowerCase();
    if (!wallet) continue;
    if (!traderMap.has(wallet)) traderMap.set(wallet, { wallet, backfillStatus: 'unknown' });
  }

  const rows = [...traderMap.values()].map((trader) => {
    const walletTrades = trades.filter((trade) => String(trade?.wallet || '').toLowerCase() === trader.wallet);
    const resolvedBuyTrades = walletTrades.filter((trade) => {
      return trade.side === 'BUY' && ['resolved_win', 'resolved_loss'].includes(trade.status) && trade.pnlUsd !== null;
    });
    const wins = resolvedBuyTrades.filter((trade) => trade.status === 'resolved_win').length;
    const allTimeProfitUsd = resolvedBuyTrades.reduce((sum, trade) => sum + Number(trade.pnlUsd || 0), 0);
    const recentBuyEntryTrades = walletTrades.filter((trade) => {
      const tradeTime = Date.parse(trade.tradeTimestamp || trade.timestamp || 0);
      return (
        trade.side === 'BUY' &&
        Number.isFinite(Number(trade.usdSize)) &&
        Number.isFinite(Number(trade.shares)) &&
        Number(trade.shares) > 0 &&
        Number.isFinite(tradeTime) &&
        tradeTime >= nowMs - entryWindowMs
      );
    });
    const avgEntryPriceCents30d = recentBuyEntryTrades.length
      ? recentBuyEntryTrades.reduce((sum, trade) => sum + Number(trade.usdSize), 0) /
        recentBuyEntryTrades.reduce((sum, trade) => sum + Number(trade.shares), 0) *
        100
      : null;
    const recentFormResults = resolvedBuyTrades
      .slice()
      .sort(compareResolvedNewest)
      .slice(0, 10)
      .map((trade) => trade.status);
    const recentResolvedDistinctTrades = latestDistinctMarketTrades(
      resolvedBuyTrades.filter((trade) => {
        const tradeTime = Date.parse(trade.tradeTimestamp || trade.timestamp || 0);
        return Number.isFinite(tradeTime) && tradeTime >= nowMs - entryWindowMs;
      })
    );
    const winCountDistinct30d = recentResolvedDistinctTrades.filter((trade) => trade.status === 'resolved_win').length;

    return {
      ...trader,
      allTrackedTradeCount: walletTrades.length,
      openTradeCount: walletTrades.filter((trade) => trade.status === 'open').length,
      allTimePnlTradeCount: resolvedBuyTrades.length,
      allTimeWinRatePct: resolvedBuyTrades.length ? (wins / resolvedBuyTrades.length) * 100 : null,
      allTimeProfitUsd,
      avgEntryPriceCents30d,
      avgEntryTradeCount30d: recentBuyEntryTrades.length,
      resolvedDistinctTradeCount30d: recentResolvedDistinctTrades.length,
      winCountDistinct30d,
      winRatePctDistinct30d: recentResolvedDistinctTrades.length
        ? (winCountDistinct30d / recentResolvedDistinctTrades.length) * 100
        : null,
      recentFormResults,
      monthlyPerformance: buildCandidateMonthlyPerformance(walletTrades, { now: nowMs }),
      metrics: buildCandidateMetrics(walletTrades, { now: nowMs }),
    };
  });

  return rows
    .sort(compareLeaderboardRows)
    .map((row, index) => ({ ...row, rank: index + 1 }))
    .slice(offset, offset + limit);
}

export function buildCandidateMonthlyPerformance(trades = [], { now = Date.now(), windowDays = 30, windowCount = 3 } = {}) {
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  return Array.from({ length: windowCount }, (_, index) => {
    const endMs = nowMs - index * windowMs;
    const startMs = endMs - windowMs;
    const windowTrades = trades.filter((trade) => {
      const tradeTime = Date.parse(trade.tradeTimestamp || trade.timestamp || 0);
      return Number.isFinite(tradeTime) && tradeTime >= startMs && tradeTime < endMs;
    });
    const entryTrades = windowTrades.filter((trade) => {
      return (
        String(trade?.side || '').toUpperCase() === 'BUY' &&
        Number.isFinite(Number(trade.usdSize)) &&
        Number.isFinite(Number(trade.shares)) &&
        Number(trade.shares) > 0
      );
    });
    const entryUsd = sum(entryTrades.map((trade) => Number(trade.usdSize)));
    const entryShares = sum(entryTrades.map((trade) => Number(trade.shares)));
    const resolvedBuyTrades = windowTrades.filter((trade) => {
      return (
        String(trade?.side || '').toUpperCase() === 'BUY' &&
        ['resolved_win', 'resolved_loss'].includes(String(trade?.status || '').toLowerCase())
      );
    });
    const distinctResolved = latestDistinctMarketTrades(resolvedBuyTrades);
    const winCount = distinctResolved.filter((trade) => String(trade.status || '').toLowerCase() === 'resolved_win').length;
    const pnlTrades = resolvedBuyTrades.filter((trade) => {
      return trade.pnlUsd !== null && trade.pnlUsd !== undefined && trade.pnlUsd !== '' && Number.isFinite(Number(trade.pnlUsd));
    });
    const profitUsd = sum(pnlTrades.map((trade) => Number(trade.pnlUsd)));
    const deployedCapital = sum(pnlTrades.map((trade) => Number(trade.usdSize)).filter(Number.isFinite));

    return {
      index,
      label: monthWindowLabel(index, windowDays),
      startAt: new Date(startMs).toISOString(),
      endAt: new Date(endMs).toISOString(),
      distinctResolvedTradeCount: distinctResolved.length,
      winCount,
      winRatePct: distinctResolved.length ? (winCount / distinctResolved.length) * 100 : null,
      avgEntryPriceCents: entryShares > 0 ? (entryUsd / entryShares) * 100 : null,
      avgEntryTradeCount: entryTrades.length,
      pnlTradeCount: pnlTrades.length,
      profitUsd,
      roiPct: deployedCapital > 0 ? (profitUsd / deployedCapital) * 100 : null,
    };
  });
}

export function buildCandidateMetrics(trades = [], { now = Date.now() } = {}) {
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const resolvedBuyTrades = trades.filter((trade) => {
    return (
      String(trade?.side || '').toUpperCase() === 'BUY' &&
      ['resolved_win', 'resolved_loss'].includes(String(trade?.status || '').toLowerCase()) &&
      trade.pnlUsd !== null &&
      trade.pnlUsd !== undefined &&
      trade.pnlUsd !== '' &&
      Number.isFinite(Number(trade.pnlUsd))
    );
  });
  const entryTrades = trades.filter((trade) => {
    return (
      String(trade?.side || '').toUpperCase() === 'BUY' &&
      trade.price !== null &&
      trade.price !== undefined &&
      Number.isFinite(Number(trade.price)) &&
      trade.shares !== null &&
      trade.shares !== undefined &&
      Number.isFinite(Number(trade.shares)) &&
      Number(trade.shares) > 0 &&
      trade.usdSize !== null &&
      trade.usdSize !== undefined &&
      Number.isFinite(Number(trade.usdSize))
    );
  });

  const totalPnl = sum(resolvedBuyTrades.map((trade) => Number(trade.pnlUsd)));
  const deployedCapital = sum(resolvedBuyTrades.map((trade) => Number(trade.usdSize)).filter(Number.isFinite));
  const wins = resolvedBuyTrades.map((trade) => Number(trade.pnlUsd)).filter((pnl) => pnl > 0);
  const losses = resolvedBuyTrades.map((trade) => Number(trade.pnlUsd)).filter((pnl) => pnl < 0);
  const grossWin = sum(wins);
  const grossLoss = Math.abs(sum(losses));
  const recent7d = recentResolvedTrades(resolvedBuyTrades, nowMs, 7);
  const recent14d = recentResolvedTrades(resolvedBuyTrades, nowMs, 14);

  return {
    roiPct: deployedCapital > 0 ? (totalPnl / deployedCapital) * 100 : null,
    profitFactor: grossWin > 0 && grossLoss > 0 ? grossWin / grossLoss : null,
    profitFactorDisplayCapHit: grossWin > 0 && grossLoss === 0,
    maxDrawdownUsd: resolvedBuyTrades.length ? maxDrawdownUsd(resolvedBuyTrades) : null,
    medianEntryCents: median(entryTrades.map((trade) => Number(trade.price) * 100)),
    avgTradeSizeUsd: average(entryTrades.map((trade) => Number(trade.usdSize))),
    avgWinUsd: average(wins),
    avgLossUsd: average(losses),
    recent7dTradeCount: recent7d.length,
    recent7dWinRatePct: winRate(recent7d),
    recent14dTradeCount: recent14d.length,
    recent14dWinRatePct: winRate(recent14d),
    topWinSharePct: grossWin > 0 ? Math.max(...wins) / grossWin * 100 : null,
  };
}

function compareLeaderboardRows(a, b) {
  if (b.allTimeProfitUsd !== a.allTimeProfitUsd) return b.allTimeProfitUsd - a.allTimeProfitUsd;
  if (b.allTimePnlTradeCount !== a.allTimePnlTradeCount) return b.allTimePnlTradeCount - a.allTimePnlTradeCount;
  return Date.parse(b.lastSeenAt || 0) - Date.parse(a.lastSeenAt || 0);
}

function compareResolvedNewest(a, b) {
  return Date.parse(b.resolvedAt || b.tradeTimestamp || 0) - Date.parse(a.resolvedAt || a.tradeTimestamp || 0);
}

function latestDistinctMarketTrades(trades) {
  const byMarket = new Map();
  for (const trade of trades.slice().sort(compareResolvedNewest)) {
    const key = String(
      trade.conditionId ||
        trade.marketSlug ||
        trade.marketTitle ||
        trade.id ||
        `${trade.wallet || ''}-${trade.tradeTimestamp || ''}-${trade.outcome || ''}`
    ).toLowerCase();
    if (!key || byMarket.has(key)) continue;
    byMarket.set(key, trade);
  }
  return [...byMarket.values()];
}

function monthWindowLabel(index, windowDays) {
  if (index === 0) return `Last ${windowDays}D`;
  return `${index * windowDays}-${(index + 1) * windowDays}D`;
}

function recentResolvedTrades(trades, nowMs, days) {
  const cutoff = nowMs - days * 24 * 60 * 60 * 1000;
  return trades.filter((trade) => {
    const resolvedTime = Date.parse(trade.resolvedAt || '');
    return Number.isFinite(resolvedTime) && resolvedTime >= cutoff;
  });
}

function maxDrawdownUsd(trades) {
  let cumulative = 0;
  let peak = 0;
  let worst = 0;
  const sorted = trades.slice().sort((a, b) => {
    const aTime = Date.parse(a.resolvedAt || a.tradeTimestamp || 0);
    const bTime = Date.parse(b.resolvedAt || b.tradeTimestamp || 0);
    if (aTime !== bTime) return aTime - bTime;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
  for (const trade of sorted) {
    cumulative += Number(trade.pnlUsd || 0);
    peak = Math.max(peak, cumulative);
    worst = Math.min(worst, cumulative - peak);
  }
  return worst;
}

function winRate(trades) {
  if (!trades.length) return null;
  const wins = trades.filter((trade) => String(trade.status || '').toLowerCase() === 'resolved_win').length;
  return wins / trades.length * 100;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function average(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? sum(finite) / finite.length : null;
}

function sum(values) {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}
