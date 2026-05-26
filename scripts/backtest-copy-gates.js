#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_OUTPUT_DIR = 'backtests';
const DEFAULT_LCB_Z = 1.64;

export const DEFAULT_BACKTEST_OPTIONS = {
  trainDays: 30,
  testDays: 7,
  stepDays: 1,
  stakeUsd: 10,
  maxCopyPriceCents: 75,
  outputDir: DEFAULT_OUTPUT_DIR,
  copyMode: 'first_wallet_market',
  includeSensitivity: true,
  lcbZ: DEFAULT_LCB_Z,
};

export function buildPrimaryStrategies(env = process.env) {
  return [
    {
      name: 'old_gate',
      type: 'old',
      minResolved: envNumber(env, 'AUTO_COPY_MIN_DISTINCT_MARKETS', 15),
      minWinRatePct: envNumber(env, 'AUTO_COPY_MIN_WIN_RATE_PCT', 75),
      maxAvgEntryPriceCents: envNumber(env, 'AUTO_COPY_MAX_AEP_CENTS', 75),
    },
    {
      name: 'hybrid_gate_v1',
      type: 'hybrid',
      minResolved: 15,
      minWinRatePct: 70,
      maxAvgEntryPriceCents: 75,
      minMeanEdge: 0,
      minUsdWeightedEdge: 0,
      edgeComparison: 'gt',
    },
    {
      name: 'hybrid_gate_v2',
      type: 'hybrid',
      minResolved: 20,
      minWinRatePct: 70,
      maxAvgEntryPriceCents: 75,
      minMeanEdge: 0.03,
      minUsdWeightedEdge: 0.03,
      edgeComparison: 'gte',
    },
    {
      name: 'hybrid_gate_v3',
      type: 'hybrid',
      minResolved: 20,
      minWinRatePct: 72,
      maxAvgEntryPriceCents: 75,
      minMeanEdge: 0.05,
      minUsdWeightedEdge: 0.04,
      minDistinctEvents: 5,
      edgeComparison: 'gte',
    },
    {
      name: 'edge_gate_loose',
      type: 'edge',
      minResolved: 25,
      minMeanEdge: 0.05,
      minEdgeLowerBound: -0.01,
      minUsdWeightedEdge: 0.04,
      minDistinctEvents: 6,
      minResolvedUsdVolume: 0,
    },
    {
      name: 'edge_gate_strict',
      type: 'edge',
      minResolved: 40,
      minMeanEdge: 0.08,
      minEdgeLowerBound: 0.02,
      minUsdWeightedEdge: 0.06,
      minDistinctEvents: 8,
      minResolvedUsdVolume: 20_000,
    },
  ];
}

export function buildSensitivityStrategies() {
  const minResolvedValues = [20, 30, 40, 60];
  const meanEdgeValues = [0.03, 0.05, 0.08, 0.1];
  const edgeLcbValues = [-0.02, 0, 0.02, 0.04];
  const usdWeightedEdgeValues = [0.03, 0.05, 0.08];
  const strategies = [];

  for (const minResolved of minResolvedValues) {
    for (const minMeanEdge of meanEdgeValues) {
      for (const minEdgeLowerBound of edgeLcbValues) {
        for (const minUsdWeightedEdge of usdWeightedEdgeValues) {
          strategies.push({
            name: [
              'edge_grid',
              `r${minResolved}`,
              `me${thresholdToken(minMeanEdge)}`,
              `lcb${thresholdToken(minEdgeLowerBound)}`,
              `uwe${thresholdToken(minUsdWeightedEdge)}`,
            ].join('_'),
            type: 'edge',
            minResolved,
            minMeanEdge,
            minEdgeLowerBound,
            minUsdWeightedEdge,
            minDistinctEvents: 6,
            minResolvedUsdVolume: 0,
          });
        }
      }
    }
  }

  return strategies;
}

export function normalizeTradeRow(row) {
  const wallet = normalizeWallet(row.wallet);
  const id = stringOrNull(row.id);
  const price = numberOrNull(row.price);
  const tradeTsMs = dateMs(row.trade_timestamp ?? row.tradeTimestamp);
  const resolvedAtMs = dateMs(row.resolved_at ?? row.resolvedAt);
  const status = String(row.status || '').toLowerCase();
  const conditionId = stringOrNull(row.condition_id ?? row.conditionId);
  const marketSlug = stringOrNull(row.market_slug ?? row.marketSlug);
  const eventSlug = stringOrNull(row.event_slug ?? row.eventSlug);
  const marketTitle = stringOrNull(row.market_title ?? row.marketTitle);
  const marketKey = firstNonEmpty(conditionId, marketSlug, marketTitle, id);
  const eventKey = firstNonEmpty(eventSlug, marketSlug, marketTitle, marketKey);

  return {
    id,
    wallet,
    conditionId,
    marketSlug,
    eventSlug,
    marketTitle,
    marketKey,
    eventKey,
    status,
    side: String(row.side || '').toUpperCase(),
    price,
    usdSize: numberOrNull(row.usd_size ?? row.usdSize),
    shares: numberOrNull(row.shares),
    pnlUsd: numberOrNull(row.pnl_usd ?? row.pnlUsd),
    tradeTimestamp: isoOrNull(tradeTsMs),
    resolvedAt: isoOrNull(resolvedAtMs),
    tradeTsMs,
    resolvedAtMs,
  };
}

export function scoreWallets(rows, asofMs, options = {}) {
  const normalizedRows = rows.map((row) => (row.tradeTsMs === undefined ? normalizeTradeRow(row) : row));
  const trainMs = positiveInteger(options.trainDays, DEFAULT_BACKTEST_OPTIONS.trainDays) * DAY_MS;
  const lcbZ = numberOrFallback(options.lcbZ, DEFAULT_LCB_Z);
  const trainStartMs = asofMs - trainMs;
  const resolvedByWalletMarket = new Map();
  const entryStats = new Map();

  for (const row of normalizedRows) {
    if (!row.wallet || row.price === null || row.tradeTsMs === null) continue;

    if (row.tradeTsMs >= trainStartMs && row.tradeTsMs < asofMs) {
      const stats = getOrCreate(entryStats, row.wallet, () => ({ entryUsd: 0, entryShares: 0, entryTradeCount: 0 }));
      if (row.shares !== null && row.shares > 0 && row.usdSize !== null && row.usdSize >= 0) {
        stats.entryUsd += row.usdSize;
        stats.entryShares += row.shares;
        stats.entryTradeCount += 1;
      }
    }

    if (!isResolvedTrade(row)) continue;
    if (row.resolvedAtMs === null || row.resolvedAtMs >= asofMs || row.resolvedAtMs < trainStartMs) continue;

    const walletMarkets = getOrCreate(resolvedByWalletMarket, row.wallet, () => new Map());
    const marketKey = row.marketKey || row.id;
    const existing = walletMarkets.get(marketKey);
    if (!existing || compareResolvedNewest(row, existing) < 0) {
      walletMarkets.set(marketKey, row);
    }
  }

  const wallets = new Set([...resolvedByWalletMarket.keys(), ...entryStats.keys()]);
  const scores = new Map();

  for (const wallet of wallets) {
    const resolvedRows = [...(resolvedByWalletMarket.get(wallet)?.values() || [])];
    const edges = resolvedRows.map((row) => edgeForTrade(row));
    const wins = resolvedRows.filter((row) => row.status === 'resolved_win').length;
    const nResolved = resolvedRows.length;
    const meanEdge = average(edges);
    const edgeStddev = sampleStddev(edges, meanEdge);
    const edgeLowerBound =
      nResolved >= 2 && edgeStddev !== null && meanEdge !== null
        ? meanEdge - (lcbZ * edgeStddev) / Math.sqrt(nResolved)
        : null;
    const resolvedUsdVolume = resolvedRows.reduce((sum, row) => sum + Math.max(0, row.usdSize || 0), 0);
    const usdWeightedEdge = resolvedUsdVolume > 0
      ? resolvedRows.reduce((sum, row) => sum + Math.max(0, row.usdSize || 0) * edgeForTrade(row), 0) / resolvedUsdVolume
      : null;
    const eventExposure = new Map();
    for (const row of resolvedRows) {
      const key = row.eventKey || row.marketKey || row.id;
      eventExposure.set(key, (eventExposure.get(key) || 0) + Math.max(0, row.usdSize || 0));
    }
    const maxEventExposure = eventExposure.size ? Math.max(...eventExposure.values()) : 0;
    const entry = entryStats.get(wallet);
    const avgEntryPriceCents30d = entry?.entryShares > 0 ? (entry.entryUsd / entry.entryShares) * 100 : null;

    scores.set(wallet, {
      wallet,
      nResolved,
      wins,
      winRatePct: nResolved ? (wins / nResolved) * 100 : null,
      avgEntryPriceCents30d,
      avgEntryTradeCount30d: entry?.entryTradeCount || 0,
      meanEdge,
      edgeStddev,
      edgeLowerBound,
      usdWeightedEdge,
      resolvedUsdVolume,
      distinctEventCount: eventExposure.size,
      maxEventExposurePct: resolvedUsdVolume > 0 ? (maxEventExposure / resolvedUsdVolume) * 100 : null,
      profitFactor: profitFactorForRows(resolvedRows),
      roiPct: roiPctForRows(resolvedRows),
    });
  }

  return scores;
}

export function runWalkForwardBacktest(inputRows, strategies, options = {}) {
  const normalizedOptions = normalizeOptions(options);
  const rows = inputRows
    .map((row) => normalizeTradeRow(row))
    .filter((row) => row.id && row.wallet && row.side === 'BUY' && row.price > 0 && row.price < 1 && row.tradeTsMs !== null)
    .sort(compareTradeOldest);
  const copyableRows = rows.filter((row) => {
    return (
      isResolvedTrade(row) &&
      row.resolvedAtMs !== null &&
      row.price * 100 <= normalizedOptions.maxCopyPriceCents
    );
  });
  const asofDates = generateAsofDates(copyableRows, normalizedOptions);
  const strategyStates = new Map(
    strategies.map((strategy) => [
      strategy.name,
      {
        strategy,
        copiedTradeIds: new Set(),
        copiedWalletMarketKeys: new Set(),
        copies: [],
        selectedWalletCounts: [],
      },
    ])
  );

  for (const asofMs of asofDates) {
    const scores = scoreWallets(rows, asofMs, normalizedOptions);
    const futureRows = copyableRows.filter((row) => {
      return row.tradeTsMs >= asofMs && row.tradeTsMs < asofMs + normalizedOptions.testDays * DAY_MS;
    });

    for (const strategy of strategies) {
      const state = strategyStates.get(strategy.name);
      const selectedWallets = new Set();
      for (const score of scores.values()) {
        if (strategyPasses(strategy, score)) selectedWallets.add(score.wallet);
      }
      state.selectedWalletCounts.push(selectedWallets.size);
      if (selectedWallets.size === 0) continue;

      for (const row of futureRows) {
        if (!selectedWallets.has(row.wallet)) continue;
        if (state.copiedTradeIds.has(row.id)) continue;
        const walletMarketKey = `${row.wallet}:${row.marketKey || row.id}`;
        if (
          normalizedOptions.copyMode === 'first_wallet_market' &&
          state.copiedWalletMarketKeys.has(walletMarketKey)
        ) {
          continue;
        }

        const score = scores.get(row.wallet);
        state.copiedTradeIds.add(row.id);
        state.copiedWalletMarketKeys.add(walletMarketKey);
        state.copies.push(makeCopiedTrade(row, strategy, score, asofMs, normalizedOptions));
      }
    }
  }

  const copies = [...strategyStates.values()]
    .flatMap((state) => state.copies)
    .sort((a, b) => a.tradeTsMs - b.tradeTsMs || a.strategy.localeCompare(b.strategy) || a.tradeId.localeCompare(b.tradeId));

  return {
    generatedAt: new Date().toISOString(),
    options: normalizedOptions,
    strategies,
    rows,
    copyableRows,
    asofDates,
    strategyStates,
    copies,
    strategySummaries: summarizeByStrategy(strategies, copies, strategyStates),
  };
}

export function calculateCopiedPnl(status, price, stakeUsd) {
  if (status === 'resolved_win') return stakeUsd * ((1 - price) / price);
  if (status === 'resolved_loss') return -stakeUsd;
  return 0;
}

export function summarizeByStrategy(strategies, copies, strategyStates = new Map()) {
  return strategies.map((strategy) => {
    const strategyCopies = copies.filter((copy) => copy.strategy === strategy.name);
    const pnlValues = strategyCopies.map((copy) => copy.copiedPnlUsd);
    const totalPnlUsd = sum(pnlValues);
    const totalStakedUsd = strategyCopies.length * (strategyCopies[0]?.stakeUsd || DEFAULT_BACKTEST_OPTIONS.stakeUsd);
    const grossProfitUsd = sum(pnlValues.filter((value) => value > 0));
    const grossLossUsd = Math.abs(sum(pnlValues.filter((value) => value < 0)));
    const selectedCounts = strategyStates.get(strategy.name)?.selectedWalletCounts || [];
    const concentration = walletPnlConcentration(strategyCopies);

    return {
      strategy: strategy.name,
      type: strategy.type,
      copiedTradeCount: strategyCopies.length,
      copiedWalletCount: new Set(strategyCopies.map((copy) => copy.wallet)).size,
      avgSelectedWalletCount: average(selectedCounts),
      totalStakedUsd,
      totalPnlUsd,
      roiPct: totalStakedUsd > 0 ? (totalPnlUsd / totalStakedUsd) * 100 : null,
      winRatePct: strategyCopies.length
        ? (strategyCopies.filter((copy) => copy.status === 'resolved_win').length / strategyCopies.length) * 100
        : null,
      avgEntryPriceCents: average(strategyCopies.map((copy) => copy.price * 100)),
      profitFactor: grossLossUsd > 0 ? grossProfitUsd / grossLossUsd : null,
      avgPnlPerTrade: average(pnlValues),
      medianPnlPerTrade: median(pnlValues),
      maxDrawdownUsd: maxDrawdown(strategyCopies),
      firstCopiedAt: minIso(strategyCopies.map((copy) => copy.tradeTimestamp)),
      lastCopiedAt: maxIso(strategyCopies.map((copy) => copy.tradeTimestamp)),
      topWallet: concentration.topWallet,
      topWalletPnlUsd: concentration.topWalletPnlUsd,
      top1WalletPnlPct: concentration.top1WalletPnlPct,
      top3WalletPnlPct: concentration.top3WalletPnlPct,
      ...strategyThresholdColumns(strategy),
    };
  });
}

async function main() {
  await loadDotenv(process.cwd());
  const cli = parseArgs(process.argv.slice(2));
  if (cli.help) {
    printHelp();
    return;
  }

  const options = normalizeOptions({
    trainDays: cli.trainDays,
    testDays: cli.testDays,
    stepDays: cli.stepDays,
    stakeUsd: cli.stakeUsd,
    maxCopyPriceCents: cli.maxCopyPriceCents,
    outputDir: cli.outputDir,
    copyMode: cli.copyMode,
    includeSensitivity: cli.includeSensitivity,
  });
  const databaseUrl = cli.databaseUrl || process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required. Set it in the environment, .env, or pass --database-url.');
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: shouldUseSsl(databaseUrl) ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 10_000,
    query_timeout: 120_000,
  });

  try {
    const rows = await fetchCandidateBuyRows(pool);
    const primaryStrategies = buildPrimaryStrategies(process.env);
    const primaryResult = runWalkForwardBacktest(rows, primaryStrategies, options);
    if (primaryResult.asofDates.length === 0) {
      throw new Error(buildEmptyCalendarMessage(primaryResult));
    }

    const written = await writePrimaryOutputs(primaryResult, options.outputDir);
    let sensitivityPath = null;
    if (options.includeSensitivity) {
      const sensitivityResult = runWalkForwardBacktest(rows, buildSensitivityStrategies(), options);
      sensitivityPath = await writeSensitivityOutput(sensitivityResult, options.outputDir);
    }

    printRunSummary(primaryResult, written, sensitivityPath);
  } finally {
    await pool.end().catch(() => {});
  }
}

async function fetchCandidateBuyRows(pool) {
  const client = await pool.connect();
  try {
    await client.query('begin read only');
    const result = await client.query(`
      select
        id,
        wallet,
        condition_id,
        market_slug,
        event_slug,
        market_title,
        side,
        status,
        price,
        usd_size,
        shares,
        pnl_usd,
        trade_timestamp,
        resolved_at
      from candidate_trades
      where side = 'BUY'
        and price is not null
        and price > 0
        and price < 1
        and trade_timestamp is not null
      order by trade_timestamp asc, id asc
    `);
    await client.query('commit');
    return result.rows;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function writePrimaryOutputs(result, outputDir) {
  await fs.mkdir(outputDir, { recursive: true });
  const summaryPath = path.join(outputDir, 'copy_gate_summary.json');
  const tradesPath = path.join(outputDir, 'copy_gate_trades.csv');
  const equityPath = path.join(outputDir, 'copy_gate_equity.csv');
  const byTraderPath = path.join(outputDir, 'copy_gate_by_trader.csv');
  const byMonthPath = path.join(outputDir, 'copy_gate_by_month.csv');
  const topWalletsPath = path.join(outputDir, 'copy_gate_top_wallets.csv');
  const bottomWalletsPath = path.join(outputDir, 'copy_gate_bottom_wallets.csv');
  const byTraderRows = buildByTraderRows(result.strategies, result.copies);
  const topWalletRows = buildWalletExtremeRows(result.strategies, byTraderRows, 'top');
  const bottomWalletRows = buildWalletExtremeRows(result.strategies, byTraderRows, 'bottom');

  const summary = {
    generatedAt: result.generatedAt,
    data: {
      buyRowsLoaded: result.rows.length,
      copyableResolvedRows: result.copyableRows.length,
      calendarSteps: result.asofDates.length,
      firstAsofDate: isoOrNull(result.asofDates[0]),
      lastAsofDate: isoOrNull(result.asofDates.at(-1)),
    },
    options: {
      trainDays: result.options.trainDays,
      testDays: result.options.testDays,
      stepDays: result.options.stepDays,
      stakeUsd: result.options.stakeUsd,
      maxCopyPriceCents: result.options.maxCopyPriceCents,
      copyMode: result.options.copyMode,
    },
    strategies: result.strategies.map(strategyConfigColumns),
    summary: result.strategySummaries.map(roundSummaryNumbers),
    topWallets: topWalletRows,
    bottomWallets: bottomWalletRows,
  };

  await Promise.all([
    fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`),
    fs.writeFile(tradesPath, toCsv(result.copies.map(roundCopiedTrade), copiedTradeColumns())),
    fs.writeFile(equityPath, toCsv(buildEquityRows(result.strategies, result.copies), equityColumns())),
    fs.writeFile(byTraderPath, toCsv(byTraderRows, contributionColumns('wallet'))),
    fs.writeFile(byMonthPath, toCsv(buildByMonthRows(result.strategies, result.copies), contributionColumns('month'))),
    fs.writeFile(topWalletsPath, toCsv(topWalletRows, walletExtremeColumns())),
    fs.writeFile(bottomWalletsPath, toCsv(bottomWalletRows, walletExtremeColumns())),
  ]);

  return { summaryPath, tradesPath, equityPath, byTraderPath, byMonthPath, topWalletsPath, bottomWalletsPath };
}

async function writeSensitivityOutput(result, outputDir) {
  await fs.mkdir(outputDir, { recursive: true });
  const sensitivityPath = path.join(outputDir, 'copy_gate_sensitivity.csv');
  await fs.writeFile(sensitivityPath, toCsv(result.strategySummaries.map(roundSummaryNumbers), sensitivityColumns()));
  return sensitivityPath;
}

function buildEquityRows(strategies, copies) {
  const rows = [];
  for (const strategy of strategies) {
    const strategyCopies = copies
      .filter((copy) => copy.strategy === strategy.name)
      .sort(compareCopyResolvedOldest);
    let cumulativePnlUsd = 0;
    let cumulativeStakedUsd = 0;
    let peakPnlUsd = 0;
    let maxDrawdownUsd = 0;

    strategyCopies.forEach((copy, index) => {
      cumulativePnlUsd += copy.copiedPnlUsd;
      cumulativeStakedUsd += copy.stakeUsd;
      peakPnlUsd = Math.max(peakPnlUsd, cumulativePnlUsd);
      maxDrawdownUsd = Math.max(maxDrawdownUsd, peakPnlUsd - cumulativePnlUsd);
      rows.push({
        strategy: strategy.name,
        resolvedAt: copy.resolvedAt,
        copiedTradeCount: index + 1,
        cumulativeStakedUsd,
        cumulativePnlUsd,
        roiPct: cumulativeStakedUsd > 0 ? (cumulativePnlUsd / cumulativeStakedUsd) * 100 : null,
        maxDrawdownUsd,
      });
    });
  }
  return rows.map(roundSummaryNumbers);
}

function buildByTraderRows(strategies, copies) {
  const rows = [];
  for (const strategy of strategies) {
    const groups = groupBy(copies.filter((copy) => copy.strategy === strategy.name), (copy) => copy.wallet);
    for (const [wallet, group] of groups) {
      rows.push({
        strategy: strategy.name,
        wallet,
        ...contributionSummary(group),
      });
    }
  }
  return rows.sort((a, b) => a.strategy.localeCompare(b.strategy) || b.totalPnlUsd - a.totalPnlUsd);
}

function buildWalletExtremeRows(strategies, byTraderRows, direction, limit = 10) {
  const rows = [];
  for (const strategy of strategies) {
    const strategyRows = byTraderRows
      .filter((row) => row.strategy === strategy.name)
      .sort((a, b) => {
        return direction === 'bottom' ? a.totalPnlUsd - b.totalPnlUsd : b.totalPnlUsd - a.totalPnlUsd;
      })
      .slice(0, limit);
    strategyRows.forEach((row, index) => {
      rows.push({
        strategy: row.strategy,
        rank: index + 1,
        wallet: row.wallet,
        copiedTrades: row.copiedTrades,
        totalStakedUsd: row.totalStakedUsd,
        totalPnlUsd: row.totalPnlUsd,
        roiPct: row.roiPct,
        winRatePct: row.winRatePct,
        avgEntryPriceCents: row.avgEntryPriceCents,
        profitFactor: row.profitFactor,
        maxDrawdownUsd: row.maxDrawdownUsd,
        firstCopiedAt: row.firstCopiedAt,
        lastCopiedAt: row.lastCopiedAt,
      });
    });
  }
  return rows;
}

function buildByMonthRows(strategies, copies) {
  const rows = [];
  for (const strategy of strategies) {
    const groups = groupBy(copies.filter((copy) => copy.strategy === strategy.name), (copy) => utcMonth(copy.tradeTsMs));
    for (const [month, group] of groups) {
      rows.push({
        strategy: strategy.name,
        month,
        ...contributionSummary(group),
      });
    }
  }
  return rows.sort((a, b) => a.strategy.localeCompare(b.strategy) || a.month.localeCompare(b.month));
}

function contributionSummary(copies) {
  const totalPnlUsd = sum(copies.map((copy) => copy.copiedPnlUsd));
  const totalStakedUsd = sum(copies.map((copy) => copy.stakeUsd));
  return roundSummaryNumbers({
    copiedTrades: copies.length,
    copiedWallets: new Set(copies.map((copy) => copy.wallet)).size,
    totalStakedUsd,
    totalPnlUsd,
    roiPct: totalStakedUsd > 0 ? (totalPnlUsd / totalStakedUsd) * 100 : null,
    winRatePct: copies.length ? (copies.filter((copy) => copy.status === 'resolved_win').length / copies.length) * 100 : null,
    avgEntryPriceCents: average(copies.map((copy) => copy.price * 100)),
    profitFactor: profitFactorForPnl(copies.map((copy) => copy.copiedPnlUsd)),
    avgPnlPerTrade: average(copies.map((copy) => copy.copiedPnlUsd)),
    medianPnlPerTrade: median(copies.map((copy) => copy.copiedPnlUsd)),
    maxDrawdownUsd: maxDrawdown(copies),
    firstCopiedAt: minIso(copies.map((copy) => copy.tradeTimestamp)),
    lastCopiedAt: maxIso(copies.map((copy) => copy.tradeTimestamp)),
  });
}

function makeCopiedTrade(row, strategy, score, asofMs, options) {
  const copiedPnlUsd = calculateCopiedPnl(row.status, row.price, options.stakeUsd);
  return {
    strategy: strategy.name,
    selectedAt: isoOrNull(asofMs),
    trainWindowStart: isoOrNull(asofMs - options.trainDays * DAY_MS),
    tradeId: row.id,
    wallet: row.wallet,
    tradeTimestamp: row.tradeTimestamp,
    resolvedAt: row.resolvedAt,
    tradeTsMs: row.tradeTsMs,
    resolvedAtMs: row.resolvedAtMs,
    marketKey: row.marketKey,
    eventKey: row.eventKey,
    status: row.status,
    price: row.price,
    entryPriceCents: row.price * 100,
    stakeUsd: options.stakeUsd,
    copiedPnlUsd,
    trainResolvedCount: score?.nResolved ?? 0,
    trainWinRatePct: score?.winRatePct ?? null,
    trainAvgEntryPriceCents30d: score?.avgEntryPriceCents30d ?? null,
    trainMeanEdge: score?.meanEdge ?? null,
    trainEdgeLowerBound: score?.edgeLowerBound ?? null,
    trainUsdWeightedEdge: score?.usdWeightedEdge ?? null,
    trainResolvedUsdVolume: score?.resolvedUsdVolume ?? null,
    trainDistinctEventCount: score?.distinctEventCount ?? null,
    trainMaxEventExposurePct: score?.maxEventExposurePct ?? null,
  };
}

function strategyPasses(strategy, score) {
  if (!score) return false;
  if (strategy.type === 'old') {
    return (
      score.nResolved >= strategy.minResolved &&
      numberAtLeast(score.winRatePct, strategy.minWinRatePct) &&
      score.avgEntryPriceCents30d !== null &&
      score.avgEntryPriceCents30d < strategy.maxAvgEntryPriceCents
    );
  }

  if (strategy.type === 'edge') {
    return (
      score.nResolved >= strategy.minResolved &&
      numberAtLeast(score.meanEdge, strategy.minMeanEdge) &&
      numberAtLeast(score.edgeLowerBound, strategy.minEdgeLowerBound) &&
      numberAtLeast(score.usdWeightedEdge, strategy.minUsdWeightedEdge) &&
      score.distinctEventCount >= (strategy.minDistinctEvents || 0) &&
      score.resolvedUsdVolume >= (strategy.minResolvedUsdVolume || 0)
    );
  }

  if (strategy.type === 'hybrid') {
    return (
      score.nResolved >= strategy.minResolved &&
      numberAtLeast(score.winRatePct, strategy.minWinRatePct) &&
      score.avgEntryPriceCents30d !== null &&
      score.avgEntryPriceCents30d < strategy.maxAvgEntryPriceCents &&
      thresholdPasses(score.meanEdge, strategy.minMeanEdge, strategy.edgeComparison) &&
      thresholdPasses(score.usdWeightedEdge, strategy.minUsdWeightedEdge, strategy.edgeComparison) &&
      score.distinctEventCount >= (strategy.minDistinctEvents || 0)
    );
  }

  throw new Error(`Unknown strategy type: ${strategy.type}`);
}

function generateAsofDates(copyableRows, options) {
  if (!copyableRows.length) return [];
  const firstResolvedMs = Math.min(...copyableRows.map((row) => row.resolvedAtMs).filter(Number.isFinite));
  const lastTradeMs = Math.max(...copyableRows.map((row) => row.tradeTsMs).filter(Number.isFinite));
  if (!Number.isFinite(firstResolvedMs) || !Number.isFinite(lastTradeMs)) return [];

  const startMs = startOfUtcDay(firstResolvedMs + options.trainDays * DAY_MS);
  const endMs = startOfUtcDay(lastTradeMs - options.testDays * DAY_MS);
  const dates = [];
  for (let ms = startMs; ms <= endMs; ms += options.stepDays * DAY_MS) {
    dates.push(ms);
  }
  return dates;
}

function edgeForTrade(row) {
  return (row.status === 'resolved_win' ? 1 : 0) - row.price;
}

function roiPctForRows(rows) {
  const staked = sum(rows.map((row) => Math.max(0, row.usdSize || 0)));
  if (staked <= 0) return null;
  const pnl = sum(rows.map((row) => row.pnlUsd || 0));
  return (pnl / staked) * 100;
}

function profitFactorForRows(rows) {
  return profitFactorForPnl(rows.map((row) => row.pnlUsd || 0));
}

function profitFactorForPnl(pnlValues) {
  const grossProfit = sum(pnlValues.filter((value) => value > 0));
  const grossLoss = Math.abs(sum(pnlValues.filter((value) => value < 0)));
  return grossLoss > 0 ? grossProfit / grossLoss : null;
}

function maxDrawdown(copies) {
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  for (const copy of [...copies].sort(compareCopyResolvedOldest)) {
    equity += copy.copiedPnlUsd;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }
  return drawdown;
}

function parseArgs(argv) {
  const parsed = {
    includeSensitivity: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--skip-sensitivity') {
      parsed.includeSensitivity = false;
    } else if (arg === '--database-url') {
      parsed.databaseUrl = requiredValue(argv, ++index, arg);
    } else if (arg === '--output-dir') {
      parsed.outputDir = requiredValue(argv, ++index, arg);
    } else if (arg === '--train-days') {
      parsed.trainDays = Number(requiredValue(argv, ++index, arg));
    } else if (arg === '--test-days') {
      parsed.testDays = Number(requiredValue(argv, ++index, arg));
    } else if (arg === '--step-days') {
      parsed.stepDays = Number(requiredValue(argv, ++index, arg));
    } else if (arg === '--stake') {
      parsed.stakeUsd = Number(requiredValue(argv, ++index, arg));
    } else if (arg === '--max-copy-price-cents') {
      parsed.maxCopyPriceCents = Number(requiredValue(argv, ++index, arg));
    } else if (arg === '--copy-mode') {
      parsed.copyMode = requiredValue(argv, ++index, arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function normalizeOptions(options = {}) {
  const copyMode = options.copyMode || DEFAULT_BACKTEST_OPTIONS.copyMode;
  if (!['first_wallet_market', 'all_trades'].includes(copyMode)) {
    throw new Error(`Invalid copy mode "${copyMode}". Use first_wallet_market or all_trades.`);
  }

  return {
    trainDays: positiveInteger(options.trainDays, DEFAULT_BACKTEST_OPTIONS.trainDays),
    testDays: positiveInteger(options.testDays, DEFAULT_BACKTEST_OPTIONS.testDays),
    stepDays: positiveInteger(options.stepDays, DEFAULT_BACKTEST_OPTIONS.stepDays),
    stakeUsd: positiveNumber(options.stakeUsd, DEFAULT_BACKTEST_OPTIONS.stakeUsd),
    maxCopyPriceCents: positiveNumber(options.maxCopyPriceCents, DEFAULT_BACKTEST_OPTIONS.maxCopyPriceCents),
    outputDir: options.outputDir || DEFAULT_BACKTEST_OPTIONS.outputDir,
    copyMode,
    includeSensitivity: options.includeSensitivity !== false,
    lcbZ: numberOrFallback(options.lcbZ, DEFAULT_LCB_Z),
  };
}

async function loadDotenv(cwd) {
  const envPath = path.join(cwd, '.env');
  let content;
  try {
    content = await fs.readFile(envPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (!key || process.env[key] !== undefined) continue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function shouldUseSsl(databaseUrl) {
  if (process.env.PGSSLMODE === 'disable') return false;
  if (process.env.PGSSLMODE === 'require') return true;
  return !/localhost|127\.0\.0\.1/i.test(databaseUrl);
}

function printRunSummary(result, written, sensitivityPath) {
  console.log(`Loaded ${result.rows.length} BUY rows; ${result.copyableRows.length} resolved rows are copyable.`);
  console.log(
    `Walk-forward calendar: ${result.asofDates.length} steps from ${isoOrNull(result.asofDates[0])} to ${isoOrNull(result.asofDates.at(-1))}.`
  );
  console.table(
    result.strategySummaries.map((row) => ({
      strategy: row.strategy,
      trades: row.copiedTradeCount,
      wallets: row.copiedWalletCount,
      pnl: round(row.totalPnlUsd, 2),
      roi_pct: round(row.roiPct, 2),
      win_rate_pct: round(row.winRatePct, 2),
      max_drawdown: round(row.maxDrawdownUsd, 2),
    }))
  );
  console.log(`Wrote ${written.summaryPath}`);
  console.log(`Wrote ${written.tradesPath}`);
  console.log(`Wrote ${written.equityPath}`);
  console.log(`Wrote ${written.byTraderPath}`);
  console.log(`Wrote ${written.byMonthPath}`);
  console.log(`Wrote ${written.topWalletsPath}`);
  console.log(`Wrote ${written.bottomWalletsPath}`);
  if (sensitivityPath) console.log(`Wrote ${sensitivityPath}`);
}

function buildEmptyCalendarMessage(result) {
  const resolvedTimes = result.copyableRows.map((row) => row.resolvedAtMs).filter(Number.isFinite);
  const tradeTimes = result.copyableRows.map((row) => row.tradeTsMs).filter(Number.isFinite);
  const firstResolvedAt = resolvedTimes.length ? isoOrNull(Math.min(...resolvedTimes)) : 'none';
  const lastTradeAt = tradeTimes.length ? isoOrNull(Math.max(...tradeTimes)) : 'none';
  const requiredDays = result.options.trainDays + result.options.testDays;
  return [
    'Not enough resolved BUY trade history to build a walk-forward calendar.',
    `Copyable resolved BUY range: first resolved at ${firstResolvedAt}, latest trade at ${lastTradeAt}.`,
    `Current settings require at least about ${requiredDays} days before the first full evaluation window.`,
    'Try reducing --train-days or --test-days until more resolved history is collected.',
  ].join(' ');
}

function printHelp() {
  console.log(`
Usage:
  npm run backtest:gates -- [options]

Options:
  --database-url <url>           Override DATABASE_URL
  --output-dir <dir>             Output directory (default: backtests)
  --train-days <days>            Training window (default: 30)
  --test-days <days>             Evaluation window (default: 7)
  --step-days <days>             Walk-forward step size (default: 1)
  --stake <usd>                  Fixed copied stake (default: 10)
  --max-copy-price-cents <cents> Max copied BUY entry price (default: 75)
  --copy-mode <mode>             first_wallet_market or all_trades (default: first_wallet_market)
  --skip-sensitivity             Skip sensitivity-grid CSV
`);
}

function copiedTradeColumns() {
  return [
    'strategy',
    'selectedAt',
    'trainWindowStart',
    'tradeId',
    'wallet',
    'tradeTimestamp',
    'resolvedAt',
    'marketKey',
    'eventKey',
    'status',
    'price',
    'entryPriceCents',
    'stakeUsd',
    'copiedPnlUsd',
    'trainResolvedCount',
    'trainWinRatePct',
    'trainAvgEntryPriceCents30d',
    'trainMeanEdge',
    'trainEdgeLowerBound',
    'trainUsdWeightedEdge',
    'trainResolvedUsdVolume',
    'trainDistinctEventCount',
    'trainMaxEventExposurePct',
  ];
}

function equityColumns() {
  return [
    'strategy',
    'resolvedAt',
    'copiedTradeCount',
    'cumulativeStakedUsd',
    'cumulativePnlUsd',
    'roiPct',
    'maxDrawdownUsd',
  ];
}

function contributionColumns(groupKey) {
  return [
    'strategy',
    groupKey,
    'copiedTrades',
    'copiedWallets',
    'totalStakedUsd',
    'totalPnlUsd',
    'roiPct',
    'winRatePct',
    'avgEntryPriceCents',
    'profitFactor',
    'avgPnlPerTrade',
    'medianPnlPerTrade',
    'maxDrawdownUsd',
    'firstCopiedAt',
    'lastCopiedAt',
  ];
}

function walletExtremeColumns() {
  return [
    'strategy',
    'rank',
    'wallet',
    'copiedTrades',
    'totalStakedUsd',
    'totalPnlUsd',
    'roiPct',
    'winRatePct',
    'avgEntryPriceCents',
    'profitFactor',
    'maxDrawdownUsd',
    'firstCopiedAt',
    'lastCopiedAt',
  ];
}

function sensitivityColumns() {
  return [
    'strategy',
    'minResolved',
    'minMeanEdge',
    'minEdgeLowerBound',
    'minUsdWeightedEdge',
    'minDistinctEvents',
    'minResolvedUsdVolume',
    'copiedTradeCount',
    'copiedWalletCount',
    'avgSelectedWalletCount',
    'totalStakedUsd',
    'totalPnlUsd',
    'roiPct',
    'winRatePct',
    'avgEntryPriceCents',
    'profitFactor',
    'avgPnlPerTrade',
    'medianPnlPerTrade',
    'maxDrawdownUsd',
    'topWallet',
    'topWalletPnlUsd',
    'top1WalletPnlPct',
    'top3WalletPnlPct',
    'firstCopiedAt',
    'lastCopiedAt',
  ];
}

function strategyThresholdColumns(strategy) {
  return {
    minResolved: strategy.minResolved ?? null,
    minWinRatePct: strategy.minWinRatePct ?? null,
    maxAvgEntryPriceCents: strategy.maxAvgEntryPriceCents ?? null,
    minMeanEdge: strategy.minMeanEdge ?? null,
    minEdgeLowerBound: strategy.minEdgeLowerBound ?? null,
    minUsdWeightedEdge: strategy.minUsdWeightedEdge ?? null,
    minDistinctEvents: strategy.minDistinctEvents ?? null,
    minResolvedUsdVolume: strategy.minResolvedUsdVolume ?? null,
    edgeComparison: strategy.edgeComparison ?? null,
  };
}

function strategyConfigColumns(strategy) {
  return {
    strategy: strategy.name,
    type: strategy.type,
    ...strategyThresholdColumns(strategy),
  };
}

function roundCopiedTrade(row) {
  return roundSummaryNumbers(row);
}

function roundSummaryNumbers(row) {
  const next = { ...row };
  for (const [key, value] of Object.entries(next)) {
    if (typeof value === 'number') next[key] = round(value, 6);
  }
  return next;
}

function toCsv(rows, columns) {
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(row[column])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function groupBy(rows, getKey) {
  const groups = new Map();
  for (const row of rows) {
    const key = getKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function compareTradeOldest(a, b) {
  return a.tradeTsMs - b.tradeTsMs || a.id.localeCompare(b.id);
}

function compareResolvedNewest(a, b) {
  return (
    (b.resolvedAtMs || 0) - (a.resolvedAtMs || 0) ||
    (b.tradeTsMs || 0) - (a.tradeTsMs || 0) ||
    String(b.id).localeCompare(String(a.id))
  );
}

function compareCopyResolvedOldest(a, b) {
  return (
    (a.resolvedAtMs || a.tradeTsMs) - (b.resolvedAtMs || b.tradeTsMs) ||
    a.tradeTsMs - b.tradeTsMs ||
    a.tradeId.localeCompare(b.tradeId)
  );
}

function isResolvedTrade(row) {
  return row.status === 'resolved_win' || row.status === 'resolved_loss';
}

function startOfUtcDay(ms) {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function utcMonth(ms) {
  const date = new Date(ms);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function average(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (!finite.length) return null;
  return sum(finite) / finite.length;
}

function median(values) {
  const finite = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!finite.length) return null;
  const middle = Math.floor(finite.length / 2);
  if (finite.length % 2) return finite[middle];
  return (finite[middle - 1] + finite[middle]) / 2;
}

function sampleStddev(values, meanValue = average(values)) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length < 2 || meanValue === null) return null;
  const variance = sum(finite.map((value) => (value - meanValue) ** 2)) / (finite.length - 1);
  return Math.sqrt(variance);
}

function sum(values) {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

function getOrCreate(map, key, makeValue) {
  if (!map.has(key)) map.set(key, makeValue());
  return map.get(key);
}

function normalizeWallet(value) {
  const wallet = stringOrNull(value);
  return wallet ? wallet.toLowerCase() : null;
}

function stringOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function firstNonEmpty(...values) {
  return values.find((value) => value !== null && value !== undefined && String(value).trim() !== '') || null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberOrFallback(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function numberAtLeast(value, minimum) {
  return value !== null && Number.isFinite(value) && value >= minimum;
}

function thresholdPasses(value, minimum, comparison = 'gte') {
  if (value === null || !Number.isFinite(value)) return false;
  return comparison === 'gt' ? value > minimum : value >= minimum;
}

function walletPnlConcentration(copies) {
  const walletRows = [...groupBy(copies, (copy) => copy.wallet)]
    .map(([wallet, rows]) => ({
      wallet,
      totalPnlUsd: sum(rows.map((row) => row.copiedPnlUsd)),
    }))
    .sort((a, b) => b.totalPnlUsd - a.totalPnlUsd);
  const totalPnlUsd = sum(copies.map((copy) => copy.copiedPnlUsd));
  const topWallet = walletRows[0] || null;
  const top1Pnl = topWallet?.totalPnlUsd ?? null;
  const top3Pnl = sum(walletRows.slice(0, 3).map((row) => row.totalPnlUsd));

  return {
    topWallet: topWallet?.wallet ?? null,
    topWalletPnlUsd: top1Pnl,
    top1WalletPnlPct: totalPnlUsd > 0 && top1Pnl !== null ? (top1Pnl / totalPnlUsd) * 100 : null,
    top3WalletPnlPct: totalPnlUsd > 0 ? (top3Pnl / totalPnlUsd) * 100 : null,
  };
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function envNumber(env, key, fallback) {
  return numberOrFallback(env[key], fallback);
}

function dateMs(value) {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isoOrNull(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function minIso(values) {
  const timestamps = values.map((value) => dateMs(value)).filter(Number.isFinite);
  return timestamps.length ? isoOrNull(Math.min(...timestamps)) : null;
}

function maxIso(values) {
  const timestamps = values.map((value) => dateMs(value)).filter(Number.isFinite);
  return timestamps.length ? isoOrNull(Math.max(...timestamps)) : null;
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function thresholdToken(value) {
  const token = String(Math.round(value * 100)).replace('-', 'm');
  return token;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

const thisFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : null;

if (invokedFile && path.resolve(thisFile) === invokedFile) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
