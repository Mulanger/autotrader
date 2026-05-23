import { Pool } from 'pg';
import { serializeDurableState } from './app-state.js';
import { DEMO_STARTING_CAPITAL_USD } from './config.js';
import { nowIso } from './format.js';

const STATE_KEY = 'default';
const SCHEMA_VERSION = 3;

export async function createStorage(state) {
  const info = state.service.storage;

  if (!process.env.DATABASE_URL) {
    return createMemoryStorage(info, 'memory_only');
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: shouldUseSsl(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 5_000,
    query_timeout: 10_000,
  });

  try {
    await migrate(pool);
    info.mode = 'postgres';
    info.status = 'ready';
    info.durable = true;
    info.schemaVersion = SCHEMA_VERSION;
  } catch (error) {
    info.mode = 'postgres';
    info.status = 'error';
    info.durable = false;
    info.schemaVersion = null;
    info.lastError = error.message;
    console.error(`Postgres setup failed: ${error.message}`);
    await pool.end().catch(() => {});
    return createMemoryStorage(info, 'postgres_error');
  }

  let queuedPayload = null;
  let saveRunning = false;

  async function load() {
    try {
      const normalized = await loadNormalizedState(pool);
      const legacy = normalized || (await loadLegacyState(pool));
      info.lastLoadedAt = nowIso();
      info.status = 'ready';
      info.lastError = null;
      info.lastLoadedRows = legacy?.allTrades?.length ?? 0;
      return legacy;
    } catch (error) {
      info.status = 'error';
      info.lastError = error.message;
      return null;
    }
  }

  async function queueSave(appState) {
    queuedPayload = serializeDurableState(appState);
    if (saveRunning) return;

    saveRunning = true;
    while (queuedPayload) {
      const payload = queuedPayload;
      queuedPayload = null;
      const startedAt = Date.now();
      try {
        info.status = 'saving';
        await saveNormalizedState(pool, payload);
        info.status = 'ready';
        info.lastSavedAt = nowIso();
        info.lastFlushDurationMs = Date.now() - startedAt;
        info.lastError = null;
      } catch (error) {
        info.status = 'error';
        info.lastError = error.message;
      }
    }
    saveRunning = false;
  }

  async function flush(appState) {
    if (appState) queuedPayload = serializeDurableState(appState);
    if (!saveRunning && queuedPayload) {
      await queueSave(appState);
      return;
    }
    while (saveRunning || queuedPayload) {
      await sleep(25);
    }
  }

  return {
    info,
    load,
    queueSave,
    flush,
    close: () => pool.end(),
  };
}

export function createMemoryStorage(info, status = 'memory_only') {
  info.mode = status === 'postgres_error' ? 'postgres' : 'memory';
  info.status = status;
  info.durable = false;
  return {
    info,
    load: async () => null,
    queueSave: () => {},
    flush: async () => {},
    close: async () => {},
  };
}

async function migrate(pool) {
  await pool.query(`
    create table if not exists autotrader_schema_migrations (
      version integer primary key,
      applied_at timestamptz not null default now()
    );

    create table if not exists autotrader_state (
      key text primary key,
      payload jsonb not null,
      updated_at timestamptz not null default now()
    );

    create table if not exists autotrader_snapshots (
      key text primary key,
      payload jsonb not null,
      updated_at timestamptz not null default now()
    );

    create table if not exists demo_account (
      id text primary key,
      starting_capital_usd numeric not null,
      cash_usd numeric not null,
      fixed_stake_usd numeric not null,
      realized_pnl_usd numeric not null,
      copied_count integer not null,
      skipped_count integer not null,
      total_notional_copied_usd numeric not null,
      updated_at timestamptz not null default now()
    );

    create table if not exists observed_trades (
      id text primary key,
      source text not null,
      watched boolean not null,
      observed_at timestamptz not null,
      trader_wallet text,
      market_slug text,
      side text,
      outcome text,
      usd_size numeric,
      trade_ts timestamptz,
      payload jsonb not null,
      updated_at timestamptz not null default now()
    );

    create index if not exists observed_trades_observed_at_idx on observed_trades (observed_at desc);
    create index if not exists observed_trades_watched_idx on observed_trades (watched, observed_at desc);
    create index if not exists observed_trades_trader_wallet_idx on observed_trades (trader_wallet);

    create table if not exists copy_decisions (
      id text primary key,
      trade_id text not null,
      mode text not null default 'demo',
      action text not null,
      reason text,
      copy_id text,
      created_at timestamptz not null,
      payload jsonb not null,
      updated_at timestamptz not null default now()
    );

    create index if not exists copy_decisions_trade_id_idx on copy_decisions (trade_id);
    create index if not exists copy_decisions_created_at_idx on copy_decisions (created_at desc);
    create index if not exists copy_decisions_action_idx on copy_decisions (action);

    create table if not exists demo_positions (
      id text primary key,
      source_trade_id text,
      close_source_trade_id text,
      trader_wallet text,
      market_slug text,
      market_title text,
      outcome text,
      status text not null,
      stake_usd numeric,
      shares numeric,
      entry_price_cents numeric,
      current_price_cents numeric,
      exit_price_cents numeric,
      exit_value_usd numeric,
      realized_pnl_usd numeric,
      resolution_status text,
      winning_outcome text,
      resolved_at timestamptz,
      settlement_source text,
      opened_at timestamptz,
      closed_at timestamptz,
      payload jsonb not null,
      updated_at timestamptz not null default now()
    );

    alter table demo_positions add column if not exists resolution_status text;
    alter table demo_positions add column if not exists winning_outcome text;
    alter table demo_positions add column if not exists resolved_at timestamptz;
    alter table demo_positions add column if not exists settlement_source text;

    create index if not exists demo_positions_status_idx on demo_positions (status);
    create index if not exists demo_positions_source_trade_id_idx on demo_positions (source_trade_id);
    create index if not exists demo_positions_trader_wallet_idx on demo_positions (trader_wallet);

    create table if not exists trader_profiles (
      wallet text primary key,
      payload jsonb not null,
      updated_at timestamptz not null default now()
    );

    insert into autotrader_schema_migrations (version)
    values (${SCHEMA_VERSION})
    on conflict (version) do nothing;
  `);
}

async function saveNormalizedState(pool, payload) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const demo = payload.demo || {};

    await client.query(
      `
        insert into autotrader_snapshots (key, payload, updated_at)
        values ($1, $2::jsonb, now())
        on conflict (key)
        do update set payload = excluded.payload, updated_at = now()
      `,
      [STATE_KEY, JSON.stringify(payload)]
    );

    await client.query(
      `
        insert into demo_account (
          id, starting_capital_usd, cash_usd, fixed_stake_usd, realized_pnl_usd,
          copied_count, skipped_count, total_notional_copied_usd, updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, now())
        on conflict (id)
        do update set
          starting_capital_usd = excluded.starting_capital_usd,
          cash_usd = excluded.cash_usd,
          fixed_stake_usd = excluded.fixed_stake_usd,
          realized_pnl_usd = excluded.realized_pnl_usd,
          copied_count = excluded.copied_count,
          skipped_count = excluded.skipped_count,
          total_notional_copied_usd = excluded.total_notional_copied_usd,
          updated_at = now()
      `,
      [
        STATE_KEY,
        demo.startingCapitalUsd ?? DEMO_STARTING_CAPITAL_USD,
        demo.cashUsd ?? DEMO_STARTING_CAPITAL_USD,
        demo.fixedStakeUsd ?? 10,
        demo.realizedPnlUsd ?? 0,
        demo.copiedCount ?? 0,
        demo.skippedCount ?? 0,
        demo.totalNotionalCopiedUsd ?? 0,
      ]
    );

    for (const trader of Object.values(payload.traders || {})) {
      if (!trader?.wallet) continue;
      await client.query(
        `
          insert into trader_profiles (wallet, payload, updated_at)
          values ($1, $2::jsonb, now())
          on conflict (wallet)
          do update set payload = excluded.payload, updated_at = now()
        `,
        [trader.wallet, JSON.stringify(trader)]
      );
    }

    for (const event of payload.allTrades || []) {
      await upsertObservedTrade(client, event);
      if (event.copyDecision) await upsertCopyDecision(client, event.id, event.copyDecision);
    }

    for (const decision of demo.decisions || []) {
      await upsertCopyDecision(client, decision.tradeId, decision);
    }

    const positions = [...(demo.openPositions || []), ...(demo.closedPositions || [])];
    for (const position of positions) {
      await upsertDemoPosition(client, position);
    }
    const positionIds = positions.map((position) => position.id).filter(Boolean);
    if (positionIds.length) {
      await client.query('delete from demo_positions where not (id = any($1::text[]))', [positionIds]);
    } else {
      await client.query('delete from demo_positions');
    }

    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function upsertObservedTrade(client, event) {
  const trade = event.trade || {};
  await client.query(
    `
      insert into observed_trades (
        id, source, watched, observed_at, trader_wallet, market_slug, side, outcome,
        usd_size, trade_ts, payload, updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, now())
      on conflict (id)
      do update set
        source = excluded.source,
        watched = excluded.watched,
        observed_at = excluded.observed_at,
        trader_wallet = excluded.trader_wallet,
        market_slug = excluded.market_slug,
        side = excluded.side,
        outcome = excluded.outcome,
        usd_size = excluded.usd_size,
        trade_ts = excluded.trade_ts,
        payload = excluded.payload,
        updated_at = now()
    `,
    [
      event.id,
      event.source || 'unknown',
      Boolean(event.watched),
      dateOrNull(event.observedAt) || new Date(),
      trade.trader?.proxyWallet || null,
      trade.market?.slug || null,
      trade.side || null,
      trade.outcome || null,
      numberOrNull(trade.usdSize),
      unixSecondsToDate(trade.timestamp),
      JSON.stringify(event),
    ]
  );
}

async function upsertCopyDecision(client, tradeId, decision) {
  if (!tradeId || !decision?.action) return;
  const id = decision.id || `${tradeId}-${decision.action}`;
  await client.query(
    `
      insert into copy_decisions (id, trade_id, mode, action, reason, copy_id, created_at, payload, updated_at)
      values ($1, $2, 'demo', $3, $4, $5, $6, $7::jsonb, now())
      on conflict (id)
      do update set
        trade_id = excluded.trade_id,
        action = excluded.action,
        reason = excluded.reason,
        copy_id = excluded.copy_id,
        created_at = excluded.created_at,
        payload = excluded.payload,
        updated_at = now()
    `,
    [
      id,
      tradeId,
      decision.action,
      decision.reason || null,
      decision.copyId || null,
      dateOrNull(decision.at) || new Date(),
      JSON.stringify({ id, tradeId, ...decision }),
    ]
  );
}

async function upsertDemoPosition(client, position) {
  if (!position?.id) return;
  await client.query(
    `
      insert into demo_positions (
        id, source_trade_id, close_source_trade_id, trader_wallet, market_slug, market_title, outcome, status,
        stake_usd, shares, entry_price_cents, current_price_cents, exit_price_cents, exit_value_usd,
        realized_pnl_usd, resolution_status, winning_outcome, resolved_at, settlement_source,
        opened_at, closed_at, payload, updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22::jsonb, now())
      on conflict (id)
      do update set
        close_source_trade_id = excluded.close_source_trade_id,
        status = excluded.status,
        current_price_cents = excluded.current_price_cents,
        exit_price_cents = excluded.exit_price_cents,
        exit_value_usd = excluded.exit_value_usd,
        realized_pnl_usd = excluded.realized_pnl_usd,
        resolution_status = excluded.resolution_status,
        winning_outcome = excluded.winning_outcome,
        resolved_at = excluded.resolved_at,
        settlement_source = excluded.settlement_source,
        closed_at = excluded.closed_at,
        payload = excluded.payload,
        updated_at = now()
    `,
    [
      position.id,
      position.sourceTradeId || null,
      position.closeSourceTradeId || null,
      position.traderWallet || null,
      position.marketSlug || null,
      position.marketTitle || null,
      position.outcome || null,
      position.status || 'open',
      numberOrNull(position.stakeUsd),
      numberOrNull(position.shares),
      numberOrNull(position.entryPriceCents),
      numberOrNull(position.currentPriceCents),
      numberOrNull(position.exitPriceCents),
      numberOrNull(position.exitValueUsd),
      numberOrNull(position.realizedPnlUsd),
      position.resolutionStatus || null,
      position.winningOutcome || null,
      dateOrNull(position.resolvedAt),
      position.settlementSource || null,
      dateOrNull(position.openedAt),
      dateOrNull(position.closedAt),
      JSON.stringify(position),
    ]
  );
}

async function loadNormalizedState(pool) {
  const accountResult = await pool.query('select * from demo_account where id = $1', [STATE_KEY]);
  if (!accountResult.rowCount) return null;

  const [snapshotResult, traderResult, openResult, closedResult, decisionResult, allTradeResult, copiedFeedResult, seenResult] =
    await Promise.all([
      pool.query('select payload from autotrader_snapshots where key = $1', [STATE_KEY]),
      pool.query('select wallet, payload from trader_profiles'),
      pool.query("select payload from demo_positions where status = 'open' order by opened_at desc nulls last"),
      pool.query("select payload from demo_positions where status <> 'open' order by closed_at desc nulls last limit 500"),
      pool.query('select payload from copy_decisions order by created_at desc limit 500'),
      pool.query('select payload from observed_trades order by observed_at desc limit 300'),
      pool.query('select payload from observed_trades where watched = true order by observed_at desc limit 200'),
      pool.query('select id from observed_trades'),
    ]);

  const account = accountResult.rows[0];
  const snapshot = snapshotResult.rows[0]?.payload || {};
  const traders = {};
  for (const row of traderResult.rows) traders[row.wallet] = row.payload;

  const openPositions = openResult.rows.map((row) => row.payload);
  const closedPositions = closedResult.rows.map((row) => row.payload);
  const decisions = decisionResult.rows.map((row) => row.payload);
  const copiedSourceTradeIds = [
    ...openPositions.map((position) => position.sourceTradeId).filter(Boolean),
    ...closedPositions.map((position) => position.sourceTradeId).filter(Boolean),
    ...closedPositions.map((position) => position.closeSourceTradeId).filter(Boolean),
    ...decisions.filter((decision) => decision.action === 'copied').map((decision) => decision.tradeId).filter(Boolean),
  ];
  const copiedTraderMarketKeys = [
    ...(snapshot.demo?.copiedTraderMarketKeys || []),
    ...openPositions.map((position) => position.traderMarketKey).filter(Boolean),
    ...closedPositions.map((position) => position.traderMarketKey).filter(Boolean),
  ];

  return {
    version: SCHEMA_VERSION,
    savedAt: snapshot.savedAt,
    watchedWallets: snapshot.watchedWallets,
    traders: Object.keys(traders).length ? traders : snapshot.traders,
    allTrades: allTradeResult.rows.map((row) => row.payload),
    copiedFeed: copiedFeedResult.rows.map((row) => row.payload),
    demo: {
      ...(snapshot.demo || {}),
      startingCapitalUsd: numberFromPg(account.starting_capital_usd),
      cashUsd: numberFromPg(account.cash_usd),
      fixedStakeUsd: numberFromPg(account.fixed_stake_usd),
      realizedPnlUsd: numberFromPg(account.realized_pnl_usd),
      copiedCount: Number(account.copied_count || 0),
      skippedCount: Number(account.skipped_count || 0),
      totalNotionalCopiedUsd: numberFromPg(account.total_notional_copied_usd),
      openPositions,
      closedPositions,
      decisions,
      copiedSourceTradeIds,
      copiedTraderMarketKeys,
    },
    real: snapshot.real,
    copyPool: snapshot.copyPool,
    seenTradeIds: seenResult.rows.map((row) => row.id),
  };
}

async function loadLegacyState(pool) {
  const result = await pool.query('select payload from autotrader_state where key = $1', [STATE_KEY]);
  return result.rows[0]?.payload || null;
}

function shouldUseSsl(databaseUrl) {
  if (process.env.PGSSLMODE === 'disable') return false;
  if (process.env.PGSSLMODE === 'require') return true;
  return /sslmode=require/i.test(databaseUrl);
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberFromPg(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function unixSecondsToDate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return new Date(number * 1000);
}

function dateOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
