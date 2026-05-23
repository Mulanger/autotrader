import { Pool } from 'pg';

const SCHEMA_VERSION = 1;

export async function createCandidateStorage() {
  if (!process.env.DATABASE_URL) {
    throw new Error('Candidate tracker requires DATABASE_URL for durable Postgres storage');
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: shouldUseSsl(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 5_000,
    query_timeout: 15_000,
  });

  try {
    await migrate(pool);
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }

  return {
    upsertTrade: (trade) => upsertTrade(pool, trade),
    getQueuedBackfillTraders: (limit) => getQueuedBackfillTraders(pool, limit),
    markBackfillRunning: (wallet) => markBackfillRunning(pool, wallet),
    markBackfillComplete: (wallet, since) => markBackfillComplete(pool, wallet, since),
    markBackfillFailed: (wallet, error) => markBackfillFailed(pool, wallet, error),
    getOpenTrades: (limit) => getOpenTrades(pool, limit),
    markResolutionChecked: (tradeId, nextCheckAt) => markResolutionChecked(pool, tradeId, nextCheckAt),
    saveResolvedTrade: (tradeId, settlement, resolution) => saveResolvedTrade(pool, tradeId, settlement, resolution),
    getLeaderboard: (params) => getLeaderboard(pool, params),
    getTrader: (wallet, params) => getTrader(pool, wallet, params),
    getSummary: () => getSummary(pool),
    close: () => pool.end(),
  };
}

async function migrate(pool) {
  await pool.query(`
    create table if not exists candidate_schema_migrations (
      version integer primary key,
      applied_at timestamptz not null default now()
    );

    create table if not exists candidate_traders (
      wallet text primary key,
      display_name text,
      pseudonym text,
      profile_image text,
      first_seen_at timestamptz not null default now(),
      last_seen_at timestamptz,
      backfill_status text not null default 'queued',
      backfill_started_at timestamptz,
      backfilled_since timestamptz,
      backfilled_at timestamptz,
      backfill_error text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists candidate_trades (
      id text primary key,
      wallet text not null references candidate_traders(wallet) on delete cascade,
      transaction_hash text,
      asset text,
      condition_id text,
      market_slug text,
      event_slug text,
      market_title text,
      market_icon text,
      polymarket_url text,
      side text not null,
      outcome text,
      outcome_index integer,
      shares numeric,
      price numeric,
      usd_size numeric not null,
      trade_timestamp timestamptz not null,
      source text not null,
      status text not null default 'open',
      payout_usd numeric,
      pnl_usd numeric,
      winning_outcome text,
      winning_outcome_index integer,
      resolution_source text,
      resolved_at timestamptz,
      next_resolution_check_at timestamptz default now(),
      raw_payload jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create index if not exists candidate_trades_wallet_ts_idx on candidate_trades (wallet, trade_timestamp desc);
    create index if not exists candidate_trades_condition_status_idx on candidate_trades (condition_id, status);
    create index if not exists candidate_trades_resolution_queue_idx on candidate_trades (status, next_resolution_check_at);
    create index if not exists candidate_trades_usd_ts_idx on candidate_trades (usd_size, trade_timestamp desc);
    create index if not exists candidate_traders_backfill_idx on candidate_traders (backfill_status, first_seen_at);

    create table if not exists candidate_market_resolutions (
      condition_id text primary key,
      market_slug text,
      status text not null,
      winning_outcome text,
      winning_outcome_index integer,
      resolved_at timestamptz,
      last_checked_at timestamptz not null default now(),
      raw_payload jsonb not null,
      updated_at timestamptz not null default now()
    );

    create table if not exists candidate_service_state (
      key text primary key,
      payload jsonb not null,
      updated_at timestamptz not null default now()
    );

    insert into candidate_schema_migrations (version)
    values (${SCHEMA_VERSION})
    on conflict (version) do nothing;
  `);
}

async function upsertTrade(pool, trade) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const existingTrader = await client.query('select wallet from candidate_traders where wallet = $1', [trade.wallet]);
    const newTrader = existingTrader.rowCount === 0;

    await client.query(
      `
        insert into candidate_traders (
          wallet, display_name, pseudonym, profile_image, first_seen_at, last_seen_at, backfill_status, updated_at
        )
        values ($1, $2, $3, $4, $5, $5, 'queued', now())
        on conflict (wallet)
        do update set
          display_name = coalesce(excluded.display_name, candidate_traders.display_name),
          pseudonym = coalesce(excluded.pseudonym, candidate_traders.pseudonym),
          profile_image = coalesce(excluded.profile_image, candidate_traders.profile_image),
          last_seen_at = greatest(coalesce(candidate_traders.last_seen_at, excluded.last_seen_at), excluded.last_seen_at),
          updated_at = now()
      `,
      [trade.wallet, trade.displayName, trade.pseudonym, trade.profileImage, trade.tradeTimestamp]
    );

    const insertResult = await client.query(
      `
        insert into candidate_trades (
          id, wallet, transaction_hash, asset, condition_id, market_slug, event_slug, market_title,
          market_icon, polymarket_url, side, outcome, outcome_index, shares, price, usd_size,
          trade_timestamp, source, status, raw_payload, updated_at
        )
        values (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14, $15, $16,
          $17, $18, 'open', $19::jsonb, now()
        )
        on conflict (id) do nothing
      `,
      [
        trade.id,
        trade.wallet,
        trade.transactionHash,
        trade.asset,
        trade.conditionId,
        trade.marketSlug,
        trade.eventSlug,
        trade.marketTitle,
        trade.marketIcon,
        trade.polymarketUrl,
        trade.side,
        trade.outcome,
        trade.outcomeIndex,
        numberOrNull(trade.shares),
        numberOrNull(trade.price),
        numberOrNull(trade.usdSize),
        trade.tradeTimestamp,
        trade.source,
        JSON.stringify(trade.raw || {}),
      ]
    );

    await client.query('commit');
    return { insertedTrade: insertResult.rowCount > 0, newTrader };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function getQueuedBackfillTraders(pool, limit = 1) {
  const result = await pool.query(
    `
      select wallet
      from candidate_traders
      where backfill_status = 'queued'
      order by first_seen_at asc
      limit $1
    `,
    [limit]
  );
  return result.rows.map((row) => row.wallet);
}

async function markBackfillRunning(pool, wallet) {
  await pool.query(
    `
      update candidate_traders
      set backfill_status = 'running',
        backfill_started_at = now(),
        backfill_error = null,
        updated_at = now()
      where wallet = $1 and backfill_status in ('queued', 'error')
    `,
    [wallet]
  );
}

async function markBackfillComplete(pool, wallet, since) {
  await pool.query(
    `
      update candidate_traders
      set backfill_status = 'done',
        backfilled_since = $2,
        backfilled_at = now(),
        backfill_error = null,
        updated_at = now()
      where wallet = $1
    `,
    [wallet, since]
  );
}

async function markBackfillFailed(pool, wallet, error) {
  await pool.query(
    `
      update candidate_traders
      set backfill_status = 'error',
        backfill_error = $2,
        updated_at = now()
      where wallet = $1
    `,
    [wallet, String(error || 'unknown error').slice(0, 500)]
  );
}

async function getOpenTrades(pool, limit = 50) {
  const result = await pool.query(
    `
      select *
      from candidate_trades
      where status = 'open'
        and (next_resolution_check_at is null or next_resolution_check_at <= now())
      order by trade_timestamp asc
      limit $1
    `,
    [limit]
  );
  return result.rows.map(mapTradeRow);
}

async function markResolutionChecked(pool, tradeId, nextCheckAt) {
  await pool.query(
    `
      update candidate_trades
      set next_resolution_check_at = $2,
        updated_at = now()
      where id = $1 and status = 'open'
    `,
    [tradeId, nextCheckAt]
  );
}

async function saveResolvedTrade(pool, tradeId, settlement, resolution) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `
        update candidate_trades
        set status = $2,
          payout_usd = $3,
          pnl_usd = $4,
          winning_outcome = $5,
          winning_outcome_index = $6,
          resolution_source = $7,
          resolved_at = $8,
          next_resolution_check_at = null,
          updated_at = now()
        where id = $1
      `,
      [
        tradeId,
        settlement.status,
        numberOrNull(settlement.payoutUsd),
        numberOrNull(settlement.pnlUsd),
        settlement.winningOutcome,
        settlement.winningOutcomeIndex,
        settlement.resolutionSource,
        settlement.resolvedAt,
      ]
    );

    const conditionId = resolution?.conditionId || resolution?.market?.conditionId || null;
    if (conditionId) {
      await client.query(
        `
          insert into candidate_market_resolutions (
            condition_id, market_slug, status, winning_outcome, winning_outcome_index,
            resolved_at, last_checked_at, raw_payload, updated_at
          )
          values ($1, $2, $3, $4, $5, $6, now(), $7::jsonb, now())
          on conflict (condition_id)
          do update set
            market_slug = coalesce(excluded.market_slug, candidate_market_resolutions.market_slug),
            status = excluded.status,
            winning_outcome = excluded.winning_outcome,
            winning_outcome_index = excluded.winning_outcome_index,
            resolved_at = excluded.resolved_at,
            last_checked_at = now(),
            raw_payload = excluded.raw_payload,
            updated_at = now()
        `,
        [
          conditionId,
          resolution?.slug || resolution?.marketSlug || null,
          resolution?.status || settlement.status,
          settlement.winningOutcome,
          settlement.winningOutcomeIndex,
          settlement.resolvedAt,
          JSON.stringify(resolution || {}),
        ]
      );
    }

    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function getLeaderboard(pool, { limit = 100, offset = 0 } = {}) {
  const result = await pool.query(
    `
      with buy_stats as (
        select
          wallet,
          count(*) filter (
            where side = 'BUY' and status in ('resolved_win', 'resolved_loss') and pnl_usd is not null
          )::integer as pnl_trade_count,
          count(*) filter (
            where side = 'BUY' and status = 'resolved_win' and pnl_usd is not null
          )::integer as win_count,
          coalesce(sum(pnl_usd) filter (
            where side = 'BUY' and status in ('resolved_win', 'resolved_loss') and pnl_usd is not null
          ), 0)::numeric as profit_usd
        from candidate_trades
        group by wallet
      ),
      activity_stats as (
        select
          wallet,
          count(*)::integer as all_tracked_trade_count,
          count(*) filter (where status = 'open')::integer as open_trade_count
        from candidate_trades
        group by wallet
      ),
      entry_price_stats as (
        select
          wallet,
          (sum(usd_size) filter (
            where side = 'BUY'
              and shares is not null
              and shares > 0
              and trade_timestamp >= now() - interval '30 days'
          ) / nullif(sum(shares) filter (
            where side = 'BUY'
              and shares is not null
              and shares > 0
              and trade_timestamp >= now() - interval '30 days'
          ), 0) * 100)::numeric as avg_entry_price_cents_30d,
          count(*) filter (
            where side = 'BUY'
              and shares is not null
              and shares > 0
              and trade_timestamp >= now() - interval '30 days'
          )::integer as avg_entry_trade_count_30d
        from candidate_trades
        group by wallet
      ),
      recent_form as (
        select wallet, jsonb_agg(status order by resolved_at desc, trade_timestamp desc) as recent_form_results
        from (
          select
            wallet,
            status,
            resolved_at,
            trade_timestamp,
            row_number() over (partition by wallet order by resolved_at desc nulls last, trade_timestamp desc) as rn
          from candidate_trades
          where side = 'BUY' and status in ('resolved_win', 'resolved_loss') and pnl_usd is not null
        ) ranked_form
        where rn <= 8
        group by wallet
      ),
      ranked as (
        select
          row_number() over (
            order by coalesce(b.profit_usd, 0) desc,
              coalesce(b.pnl_trade_count, 0) desc,
              t.last_seen_at desc nulls last,
              t.wallet asc
          )::integer as rank,
          t.wallet,
          t.display_name,
          t.pseudonym,
          t.profile_image,
          t.first_seen_at,
          t.last_seen_at,
          t.backfill_status,
          coalesce(a.all_tracked_trade_count, 0)::integer as all_tracked_trade_count,
          coalesce(a.open_trade_count, 0)::integer as open_trade_count,
          coalesce(b.pnl_trade_count, 0)::integer as all_time_pnl_trade_count,
          coalesce(b.win_count, 0)::integer as win_count,
          coalesce(b.profit_usd, 0)::numeric as all_time_profit_usd,
          e.avg_entry_price_cents_30d,
          coalesce(e.avg_entry_trade_count_30d, 0)::integer as avg_entry_trade_count_30d,
          coalesce(r.recent_form_results, '[]'::jsonb) as recent_form_results
        from candidate_traders t
        left join buy_stats b on b.wallet = t.wallet
        left join activity_stats a on a.wallet = t.wallet
        left join entry_price_stats e on e.wallet = t.wallet
        left join recent_form r on r.wallet = t.wallet
      )
      select *
      from ranked
      order by rank
      limit $1 offset $2
    `,
    [limit, offset]
  );
  return result.rows.map(mapLeaderboardRow);
}

async function getTrader(pool, wallet, { limit = 100, offset = 0 } = {}) {
  const normalizedWallet = String(wallet || '').toLowerCase();
  const [traderResult, tradeResult, countResult] = await Promise.all([
    pool.query('select * from candidate_traders where wallet = $1', [normalizedWallet]),
    pool.query(
      `
        select *
        from candidate_trades
        where wallet = $1
        order by trade_timestamp desc
        limit $2 offset $3
      `,
      [normalizedWallet, limit, offset]
    ),
    pool.query('select count(*)::integer as trade_count from candidate_trades where wallet = $1', [normalizedWallet]),
  ]);

  if (!traderResult.rowCount) return null;
  return {
    ...mapTraderRow(traderResult.rows[0]),
    totalTrackedTradeCount: Number(countResult.rows[0]?.trade_count || 0),
    pageLimit: limit,
    pageOffset: offset,
    trades: tradeResult.rows.map(mapTradeRow),
  };
}

async function getSummary(pool) {
  const result = await pool.query(`
    select
      (select count(*)::integer from candidate_traders) as trader_count,
      (select count(*)::integer from candidate_trades) as trade_count,
      (select count(*)::integer from candidate_trades where status = 'open') as open_trade_count,
      (select count(*)::integer from candidate_trades where status in ('resolved_win', 'resolved_loss', 'invalid')) as resolved_trade_count,
      (select count(*)::integer from candidate_traders where backfill_status = 'queued') as queued_backfill_count,
      (select count(*)::integer from candidate_traders where backfill_status = 'running') as running_backfill_count
  `);
  return camelizeSummary(result.rows[0] || {});
}

function mapLeaderboardRow(row) {
  const pnlTradeCount = Number(row.all_time_pnl_trade_count || 0);
  const winCount = Number(row.win_count || 0);
  return {
    rank: Number(row.rank || 0),
    wallet: row.wallet,
    displayName: row.display_name,
    pseudonym: row.pseudonym,
    profileImage: row.profile_image,
    firstSeenAt: isoOrNull(row.first_seen_at),
    lastSeenAt: isoOrNull(row.last_seen_at),
    backfillStatus: row.backfill_status,
    allTrackedTradeCount: Number(row.all_tracked_trade_count || 0),
    openTradeCount: Number(row.open_trade_count || 0),
    allTimePnlTradeCount: pnlTradeCount,
    allTimeWinRatePct: pnlTradeCount ? (winCount / pnlTradeCount) * 100 : null,
    allTimeProfitUsd: numberFromPg(row.all_time_profit_usd),
    avgEntryPriceCents30d: nullableNumberFromPg(row.avg_entry_price_cents_30d),
    avgEntryTradeCount30d: Number(row.avg_entry_trade_count_30d || 0),
    recentFormResults: Array.isArray(row.recent_form_results) ? row.recent_form_results : [],
  };
}

function mapTraderRow(row) {
  return {
    wallet: row.wallet,
    displayName: row.display_name,
    pseudonym: row.pseudonym,
    profileImage: row.profile_image,
    firstSeenAt: isoOrNull(row.first_seen_at),
    lastSeenAt: isoOrNull(row.last_seen_at),
    backfillStatus: row.backfill_status,
    backfilledSince: isoOrNull(row.backfilled_since),
    backfilledAt: isoOrNull(row.backfilled_at),
    backfillError: row.backfill_error,
  };
}

function mapTradeRow(row) {
  return {
    id: row.id,
    wallet: row.wallet,
    transactionHash: row.transaction_hash,
    asset: row.asset,
    conditionId: row.condition_id,
    marketSlug: row.market_slug,
    eventSlug: row.event_slug,
    marketTitle: row.market_title,
    marketIcon: row.market_icon,
    polymarketUrl: row.polymarket_url,
    side: row.side,
    outcome: row.outcome,
    outcomeIndex: row.outcome_index,
    shares: numberFromPg(row.shares),
    price: numberFromPg(row.price),
    usdSize: numberFromPg(row.usd_size),
    tradeTimestamp: isoOrNull(row.trade_timestamp),
    source: row.source,
    status: row.status,
    payoutUsd: nullableNumberFromPg(row.payout_usd),
    pnlUsd: nullableNumberFromPg(row.pnl_usd),
    winningOutcome: row.winning_outcome,
    winningOutcomeIndex: row.winning_outcome_index,
    resolutionSource: row.resolution_source,
    resolvedAt: isoOrNull(row.resolved_at),
    nextResolutionCheckAt: isoOrNull(row.next_resolution_check_at),
    raw: row.raw_payload,
  };
}

function camelizeSummary(row) {
  return {
    traderCount: Number(row.trader_count || 0),
    tradeCount: Number(row.trade_count || 0),
    openTradeCount: Number(row.open_trade_count || 0),
    resolvedTradeCount: Number(row.resolved_trade_count || 0),
    queuedBackfillCount: Number(row.queued_backfill_count || 0),
    runningBackfillCount: Number(row.running_backfill_count || 0),
  };
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

function nullableNumberFromPg(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isoOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
