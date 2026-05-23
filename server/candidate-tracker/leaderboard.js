export function buildLeaderboardRows(traders = [], trades = [], { limit = 100, offset = 0 } = {}) {
  const entryWindowMs = 30 * 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
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
      .slice(0, 8)
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
    };
  });

  return rows
    .sort(compareLeaderboardRows)
    .map((row, index) => ({ ...row, rank: index + 1 }))
    .slice(offset, offset + limit);
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
