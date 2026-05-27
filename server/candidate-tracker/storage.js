import { Pool } from 'pg';
import {
  copyPoolEligibilityReason,
  copyPoolRetentionReason,
  defaultCopyPoolThresholds,
  isCopyPoolEligible,
  isCopyPoolRetained,
  makeCopyPoolWallet,
  normalizeWallet,
} from '../copy-pool.js';
import { SHADOW_TRADER_CRITERIA, SHADOW_TRADER_STRATEGY } from '../shadow-trader.js';

const SCHEMA_VERSION = 2;

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
    seedActiveCopyPoolBackfill: (baselineWallets, options) => seedActiveCopyPoolBackfill(pool, baselineWallets, options),
    getQueuedBackfillTraders: (limit) => getQueuedBackfillTraders(pool, limit),
    recoverStaleBackfills: (staleMs) => recoverStaleBackfills(pool, staleMs),
    markBackfillRunning: (wallet) => markBackfillRunning(pool, wallet),
    markBackfillComplete: (wallet, since, options) => markBackfillComplete(pool, wallet, since, options),
    markBackfillFailed: (wallet, error) => markBackfillFailed(pool, wallet, error),
    getOpenTrades: (limit) => getOpenTrades(pool, limit),
    getResolutionQueueMetrics: () => getResolutionQueueMetrics(pool),
    markResolutionChecked: (tradeId, nextCheckAt) => markResolutionChecked(pool, tradeId, nextCheckAt),
    saveResolvedTrade: (tradeId, settlement, resolution) => saveResolvedTrade(pool, tradeId, settlement, resolution),
    saveServiceState: (key, payload) => saveServiceState(pool, key, payload),
    getLeaderboard: (params) => getLeaderboard(pool, params),
    getTrader: (wallet, params) => getTrader(pool, wallet, params),
    getSummary: () => getSummary(pool),
    evaluateCopyPool: (params) => evaluateCopyPool(pool, params),
    evaluateShadowTrader: (params) => evaluateShadowTrader(pool, params),
    getCopyPoolSnapshot: (params) => getCopyPoolSnapshot(pool, params),
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
    create index if not exists candidate_trades_resolution_due_idx on candidate_trades (status, next_resolution_check_at, trade_timestamp);
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

    create table if not exists copy_pool_traders (
      wallet text primary key,
      source text not null,
      status text not null,
      protected boolean not null default false,
      display_name text,
      pseudonym text,
      profile_image text,
      distinct_resolved_trade_count integer not null default 0,
      win_count integer not null default 0,
      win_rate_pct numeric,
      avg_entry_price_cents_30d numeric,
      avg_entry_trade_count_30d integer not null default 0,
      eligible boolean not null default false,
      reason text,
      first_added_at timestamptz,
      added_at timestamptz,
      removed_at timestamptz,
      last_evaluated_at timestamptz,
      payload jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists copy_pool_events (
      id bigserial primary key,
      wallet text not null,
      action text not null,
      source text not null,
      reason text,
      metrics jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );

    create index if not exists copy_pool_traders_status_idx on copy_pool_traders (source, status);
    create index if not exists copy_pool_events_created_idx on copy_pool_events (created_at desc);
    create index if not exists copy_pool_events_wallet_idx on copy_pool_events (wallet, created_at desc);

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

export async function seedActiveCopyPoolBackfill(pool, baselineWallets = [], { historyDays = 30 } = {}) {
  const wallets = [...new Set((baselineWallets || []).map(normalizeWallet).filter(Boolean))];
  const result = await pool.query(
    `
      with active_wallets as (
        select wallet
        from copy_pool_traders
        where status = 'active'
        union
        select unnest($1::text[]) as wallet
      ),
      normalized as (
        select distinct lower(trim(wallet)) as wallet
        from active_wallets
        where wallet is not null and trim(wallet) <> ''
      )
      insert into candidate_traders (
        wallet, first_seen_at, last_seen_at, backfill_status, updated_at
      )
      select wallet, now(), null, 'queued', now()
      from normalized
      on conflict (wallet) do update set
        backfill_status = 'queued',
        backfill_error = null,
        updated_at = now()
      where (
          candidate_traders.backfill_status in ('done', 'error')
          and (
            candidate_traders.backfilled_since is null
            or candidate_traders.backfilled_since > now() - ($2::integer * interval '1 day')
          )
        )
        or (
          candidate_traders.backfill_status = 'partial'
          and candidate_traders.backfill_error like '%configured max is 3000%'
        )
      returning wallet
    `,
    [wallets, historyDays]
  );
  return result.rows.map((row) => row.wallet);
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

async function recoverStaleBackfills(pool, staleMs = 30 * 60_000) {
  const cutoff = new Date(Date.now() - staleMs);
  const result = await pool.query(
    `
      update candidate_traders
      set backfill_status = 'queued',
        backfill_error = 'Recovered stale running backfill',
        updated_at = now()
      where backfill_status = 'running'
        and backfill_started_at < $1
      returning wallet
    `,
    [cutoff]
  );
  return result.rows.map((row) => row.wallet);
}

async function markBackfillComplete(pool, wallet, since, options = {}) {
  const status = options.partial ? 'partial' : 'done';
  const reason = options.reason ? String(options.reason).slice(0, 500) : null;
  await pool.query(
    `
      update candidate_traders
      set backfill_status = $3,
        backfilled_since = $2,
        backfilled_at = now(),
        backfill_error = $4,
        updated_at = now()
      where wallet = $1
    `,
    [wallet, since, status, reason]
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
      order by next_resolution_check_at asc nulls first, trade_timestamp asc
      limit $1
    `,
    [limit]
  );
  return result.rows.map(mapTradeRow);
}

async function getResolutionQueueMetrics(pool) {
  const result = await pool.query(`
    select
      count(*) filter (where status = 'open')::integer as open_trade_count,
      count(*) filter (
        where status = 'open'
          and (next_resolution_check_at is null or next_resolution_check_at <= now())
      )::integer as eligible_open_trade_count,
      min(next_resolution_check_at) filter (where status = 'open') as oldest_next_resolution_check_at,
      min(trade_timestamp) filter (
        where status = 'open'
          and (next_resolution_check_at is null or next_resolution_check_at <= now())
      ) as oldest_eligible_trade_timestamp
    from candidate_trades
  `);
  const row = result.rows[0] || {};
  return {
    openTradeCount: Number(row.open_trade_count || 0),
    eligibleOpenTradeCount: Number(row.eligible_open_trade_count || 0),
    oldestNextResolutionCheckAt: isoOrNull(row.oldest_next_resolution_check_at),
    oldestEligibleTradeTimestamp: isoOrNull(row.oldest_eligible_trade_timestamp),
  };
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

async function saveServiceState(pool, key, payload) {
  await pool.query(
    `
      insert into candidate_service_state (key, payload, updated_at)
      values ($1, $2::jsonb, now())
      on conflict (key)
      do update set payload = excluded.payload, updated_at = now()
    `,
    [key, JSON.stringify(payload || {})]
  );
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
      resolved_distinct_30d as (
        select
          wallet,
          count(*)::integer as resolved_distinct_trade_count_30d,
          count(*) filter (where status = 'resolved_win')::integer as win_count_distinct_30d
        from (
          select
            wallet,
            status,
            row_number() over (
              partition by wallet, coalesce(nullif(condition_id, ''), nullif(market_slug, ''), nullif(market_title, ''), id)
              order by resolved_at desc nulls last, trade_timestamp desc, id desc
            ) as rn
          from candidate_trades
          where side = 'BUY'
            and status in ('resolved_win', 'resolved_loss')
            and trade_timestamp >= now() - interval '30 days'
        ) distinct_buy
        where rn = 1
        group by wallet
      ),
      resolved_metric_raw as (
        select
          wallet,
          id,
          status,
          pnl_usd,
          usd_size,
          resolved_at,
          trade_timestamp
        from candidate_trades
        where side = 'BUY'
          and status in ('resolved_win', 'resolved_loss')
          and pnl_usd is not null
      ),
      performance_raw as (
        select
          wallet,
          coalesce(sum(pnl_usd), 0)::numeric as total_pnl_usd,
          coalesce(sum(usd_size), 0)::numeric as deployed_capital_usd,
          coalesce(sum(pnl_usd) filter (where pnl_usd > 0), 0)::numeric as gross_winning_pnl_usd,
          abs(coalesce(sum(pnl_usd) filter (where pnl_usd < 0), 0))::numeric as gross_losing_pnl_usd,
          (max(pnl_usd) filter (where pnl_usd > 0))::numeric as largest_win_usd,
          (avg(pnl_usd) filter (where pnl_usd > 0))::numeric as avg_win_usd,
          (avg(pnl_usd) filter (where pnl_usd < 0))::numeric as avg_loss_usd,
          count(*) filter (where resolved_at >= now() - interval '7 days')::integer as recent_7d_trade_count,
          count(*) filter (
            where resolved_at >= now() - interval '7 days' and status = 'resolved_win'
          )::integer as recent_7d_win_count,
          count(*) filter (where resolved_at >= now() - interval '14 days')::integer as recent_14d_trade_count,
          count(*) filter (
            where resolved_at >= now() - interval '14 days' and status = 'resolved_win'
          )::integer as recent_14d_win_count
        from resolved_metric_raw
        group by wallet
      ),
      performance_stats as (
        select
          wallet,
          case
            when deployed_capital_usd > 0 then total_pnl_usd / deployed_capital_usd * 100
            else null
          end as roi_pct,
          case
            when gross_winning_pnl_usd > 0 and gross_losing_pnl_usd > 0 then gross_winning_pnl_usd / gross_losing_pnl_usd
            else null
          end as profit_factor,
          (gross_winning_pnl_usd > 0 and gross_losing_pnl_usd = 0) as profit_factor_display_cap_hit,
          avg_win_usd,
          avg_loss_usd,
          recent_7d_trade_count,
          case
            when recent_7d_trade_count > 0 then recent_7d_win_count::numeric / recent_7d_trade_count * 100
            else null
          end as recent_7d_win_rate_pct,
          recent_14d_trade_count,
          case
            when recent_14d_trade_count > 0 then recent_14d_win_count::numeric / recent_14d_trade_count * 100
            else null
          end as recent_14d_win_rate_pct,
          case
            when gross_winning_pnl_usd > 0 then largest_win_usd / gross_winning_pnl_usd * 100
            else null
          end as top_win_share_pct
        from performance_raw
      ),
      entry_metric_stats as (
        select
          wallet,
          (percentile_cont(0.5) within group (order by price * 100))::numeric as median_entry_cents,
          avg(usd_size)::numeric as avg_trade_size_usd
        from candidate_trades
        where side = 'BUY'
          and price is not null
          and shares is not null
          and shares > 0
          and usd_size is not null
        group by wallet
      ),
      drawdown_curve as (
        select
          wallet,
          coalesce(resolved_at, trade_timestamp) as close_ts,
          id,
          (sum(pnl_usd) over (
            partition by wallet
            order by coalesce(resolved_at, trade_timestamp), id
            rows between unbounded preceding and current row
          ))::numeric as cumulative_pnl_usd
        from resolved_metric_raw
      ),
      drawdown_points as (
        select
          wallet,
          cumulative_pnl_usd - greatest(
            0::numeric,
            max(cumulative_pnl_usd) over (
              partition by wallet
              order by close_ts, id
              rows between unbounded preceding and current row
            )
          ) as drawdown_usd
        from drawdown_curve
      ),
      drawdown_stats as (
        select wallet, min(drawdown_usd)::numeric as max_drawdown_usd
        from drawdown_points
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
      month_windows as (
        select
          t.wallet,
          series.window_index,
          now() - (series.window_index * interval '30 days') as window_end,
          now() - ((series.window_index + 1) * interval '30 days') as window_start
        from candidate_traders t
        cross join generate_series(0, 2) as series(window_index)
      ),
      monthly_entry_stats as (
        select
          mw.wallet,
          mw.window_index,
          (sum(ct.usd_size) / nullif(sum(ct.shares), 0) * 100)::numeric as avg_entry_price_cents,
          count(ct.id)::integer as avg_entry_trade_count
        from month_windows mw
        left join candidate_trades ct on ct.wallet = mw.wallet
          and ct.side = 'BUY'
          and ct.shares is not null
          and ct.shares > 0
          and ct.usd_size is not null
          and ct.trade_timestamp >= mw.window_start
          and ct.trade_timestamp < mw.window_end
        group by mw.wallet, mw.window_index
      ),
      monthly_resolved_ranked as (
        select
          mw.wallet,
          mw.window_index,
          ct.status,
          row_number() over (
            partition by mw.wallet, mw.window_index,
              coalesce(nullif(ct.condition_id, ''), nullif(ct.market_slug, ''), nullif(ct.market_title, ''), ct.id)
            order by ct.resolved_at desc nulls last, ct.trade_timestamp desc, ct.id desc
          ) as rn
        from month_windows mw
        join candidate_trades ct on ct.wallet = mw.wallet
          and ct.side = 'BUY'
          and ct.status in ('resolved_win', 'resolved_loss')
          and ct.trade_timestamp >= mw.window_start
          and ct.trade_timestamp < mw.window_end
      ),
      monthly_resolved_stats as (
        select
          wallet,
          window_index,
          count(*)::integer as resolved_distinct_trade_count,
          count(*) filter (where status = 'resolved_win')::integer as win_count
        from monthly_resolved_ranked
        where rn = 1
        group by wallet, window_index
      ),
      monthly_pnl_stats as (
        select
          mw.wallet,
          mw.window_index,
          count(ct.id)::integer as pnl_trade_count,
          coalesce(sum(ct.pnl_usd), 0)::numeric as profit_usd,
          coalesce(sum(ct.usd_size), 0)::numeric as deployed_capital_usd
        from month_windows mw
        left join candidate_trades ct on ct.wallet = mw.wallet
          and ct.side = 'BUY'
          and ct.status in ('resolved_win', 'resolved_loss')
          and ct.pnl_usd is not null
          and ct.trade_timestamp >= mw.window_start
          and ct.trade_timestamp < mw.window_end
        group by mw.wallet, mw.window_index
      ),
      monthly_stats as (
        select
          mw.wallet,
          jsonb_agg(
            jsonb_build_object(
              'index', mw.window_index,
              'label', case
                when mw.window_index = 0 then 'Last 30D'
                else (mw.window_index * 30)::text || '-' || ((mw.window_index + 1) * 30)::text || 'D'
              end,
              'startAt', mw.window_start,
              'endAt', mw.window_end,
              'distinctResolvedTradeCount', coalesce(mrs.resolved_distinct_trade_count, 0),
              'winCount', coalesce(mrs.win_count, 0),
              'winRatePct', case
                when coalesce(mrs.resolved_distinct_trade_count, 0) > 0
                  then mrs.win_count::numeric / mrs.resolved_distinct_trade_count * 100
                else null
              end,
              'avgEntryPriceCents', mes.avg_entry_price_cents,
              'avgEntryTradeCount', coalesce(mes.avg_entry_trade_count, 0),
              'pnlTradeCount', coalesce(mps.pnl_trade_count, 0),
              'profitUsd', coalesce(mps.profit_usd, 0),
              'roiPct', case
                when coalesce(mps.deployed_capital_usd, 0) > 0
                  then mps.profit_usd / mps.deployed_capital_usd * 100
                else null
              end
            )
            order by mw.window_index
          ) as monthly_performance
        from month_windows mw
        left join monthly_entry_stats mes on mes.wallet = mw.wallet and mes.window_index = mw.window_index
        left join monthly_resolved_stats mrs on mrs.wallet = mw.wallet and mrs.window_index = mw.window_index
        left join monthly_pnl_stats mps on mps.wallet = mw.wallet and mps.window_index = mw.window_index
        group by mw.wallet
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
          coalesce(d.resolved_distinct_trade_count_30d, 0)::integer as resolved_distinct_trade_count_30d,
          coalesce(d.win_count_distinct_30d, 0)::integer as win_count_distinct_30d,
          coalesce(r.recent_form_results, '[]'::jsonb) as recent_form_results,
          p.roi_pct,
          p.profit_factor,
          coalesce(p.profit_factor_display_cap_hit, false) as profit_factor_display_cap_hit,
          dd.max_drawdown_usd,
          em.median_entry_cents,
          em.avg_trade_size_usd,
          p.avg_win_usd,
          p.avg_loss_usd,
          coalesce(p.recent_7d_trade_count, 0)::integer as recent_7d_trade_count,
          p.recent_7d_win_rate_pct,
          coalesce(p.recent_14d_trade_count, 0)::integer as recent_14d_trade_count,
          p.recent_14d_win_rate_pct,
          p.top_win_share_pct,
          coalesce(ms.monthly_performance, '[]'::jsonb) as monthly_performance
        from candidate_traders t
        left join buy_stats b on b.wallet = t.wallet
        left join activity_stats a on a.wallet = t.wallet
        left join entry_price_stats e on e.wallet = t.wallet
        left join resolved_distinct_30d d on d.wallet = t.wallet
        left join recent_form r on r.wallet = t.wallet
        left join performance_stats p on p.wallet = t.wallet
        left join entry_metric_stats em on em.wallet = t.wallet
        left join drawdown_stats dd on dd.wallet = t.wallet
        left join monthly_stats ms on ms.wallet = t.wallet
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

async function evaluateCopyPool(pool, { baselineWallets = [], thresholds: thresholdOverrides = {} } = {}) {
  const thresholds = defaultCopyPoolThresholds(thresholdOverrides);
  const client = await pool.connect();
  const changed = [];
  try {
    await client.query('begin');
    await upsertBaselineCopyPoolRows(client, baselineWallets, thresholds);

    const metricRowsResult = await queryCopyPoolMetricRows(client, thresholds);
    const currentRowsResult = await client.query('select * from copy_pool_traders');
    const current = new Map(currentRowsResult.rows.map((row) => [normalizeWallet(row.wallet), row]));
    const metricWallets = new Set();

    for (const row of metricRowsResult.rows) {
      const wallet = normalizeWallet(row.wallet);
      if (!wallet) continue;
      metricWallets.add(wallet);
      const existing = current.get(wallet);
      const source = existing?.source || 'auto';
      const protectedWallet = Boolean(existing?.protected);
      const metrics = metricsFromRow(row, thresholds);

      if (protectedWallet || source === 'baseline') {
        const evaluatedAt = new Date().toISOString();
        await upsertCopyPoolRow(client, {
          ...metrics,
          wallet,
          source: 'baseline',
          status: 'active',
          protected: true,
          displayName: row.display_name,
          pseudonym: row.pseudonym,
          profileImage: row.profile_image,
          reason: 'Protected baseline wallet',
          firstAddedAt: isoOrNull(existing?.first_added_at) || evaluatedAt,
          addedAt: isoOrNull(existing?.added_at) || evaluatedAt,
          removedAt: null,
        });
        continue;
      }

      if (metrics.eligible) {
        const wasActive = existing?.status === 'active';
        const evaluatedAt = new Date().toISOString();
        await upsertCopyPoolRow(client, {
          ...metrics,
          wallet,
          source: 'auto',
          status: 'active',
          protected: false,
          displayName: row.display_name,
          pseudonym: row.pseudonym,
          profileImage: row.profile_image,
          reason: 'Eligible',
          firstAddedAt: isoOrNull(existing?.first_added_at) || evaluatedAt,
          addedAt: wasActive ? isoOrNull(existing?.added_at) || evaluatedAt : evaluatedAt,
          removedAt: null,
        });
        if (!wasActive) {
          await insertCopyPoolEvent(client, wallet, 'added', 'auto', 'Eligible', metrics);
          changed.push({ wallet, action: 'added' });
        }
        continue;
      }

      if (existing?.status === 'active' && existing?.source === 'auto' && metrics.retained) {
        await upsertCopyPoolRow(client, {
          ...metrics,
          wallet,
          source: 'auto',
          status: 'active',
          protected: false,
          displayName: row.display_name,
          pseudonym: row.pseudonym,
          profileImage: row.profile_image,
          reason: metrics.retentionReason,
          firstAddedAt: isoOrNull(existing.first_added_at),
          addedAt: isoOrNull(existing.added_at),
          removedAt: null,
        });
        continue;
      }

      if (existing?.status === 'active' && existing?.source === 'auto') {
        const evaluatedAt = new Date().toISOString();
        await upsertCopyPoolRow(client, {
          ...metrics,
          wallet,
          source: 'auto',
          status: 'removed',
          protected: false,
          displayName: row.display_name,
          pseudonym: row.pseudonym,
          profileImage: row.profile_image,
          reason: metrics.retentionReason,
          firstAddedAt: isoOrNull(existing?.first_added_at),
          addedAt: isoOrNull(existing?.added_at),
          removedAt: evaluatedAt,
        });
        await insertCopyPoolEvent(client, wallet, 'removed', 'auto', metrics.retentionReason, metrics);
        changed.push({ wallet, action: 'removed', reason: metrics.retentionReason });
      } else if (existing) {
        await upsertCopyPoolRow(client, {
          ...metrics,
          wallet,
          source: existing.source || 'auto',
          status: existing.status || 'removed',
          protected: Boolean(existing.protected),
          displayName: row.display_name,
          pseudonym: row.pseudonym,
          profileImage: row.profile_image,
          reason: metrics.reason,
          firstAddedAt: isoOrNull(existing.first_added_at),
          addedAt: isoOrNull(existing.added_at),
          removedAt: isoOrNull(existing.removed_at),
        });
      }
    }

    for (const [wallet, existing] of current.entries()) {
      if (metricWallets.has(wallet) || existing.source !== 'auto' || existing.status !== 'active') continue;
      const metrics = metricsFromRow({ wallet }, thresholds);
      const evaluatedAt = new Date().toISOString();
      await upsertCopyPoolRow(client, {
        ...metrics,
        wallet,
        source: 'auto',
        status: 'removed',
        protected: false,
        displayName: existing.display_name,
        pseudonym: existing.pseudonym,
        profileImage: existing.profile_image,
        reason: metrics.retentionReason,
        firstAddedAt: isoOrNull(existing.first_added_at),
        addedAt: isoOrNull(existing.added_at),
        removedAt: evaluatedAt,
      });
      await insertCopyPoolEvent(client, wallet, 'removed', 'auto', metrics.retentionReason, metrics);
      changed.push({ wallet, action: 'removed', reason: metrics.retentionReason });
    }

    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  return {
    changed,
    snapshot: await getCopyPoolSnapshot(pool, { thresholds }),
  };
}

async function evaluateShadowTrader(pool, { windowDays = 30, criteria = SHADOW_TRADER_CRITERIA } = {}) {
  const result = await queryShadowTraderMetricRows(pool, { windowDays });
  const selectedWallets = {};

  for (const row of result.rows) {
    const metrics = mapShadowMetricRow(row);
    if (!isHybridV1Eligible(metrics, criteria)) continue;
    selectedWallets[metrics.wallet] = {
      ...metrics,
      status: 'active',
      strategy: SHADOW_TRADER_STRATEGY,
      reason: 'Selected by hybrid v1 shadow gate',
    };
  }

  return {
    enabled: true,
    strategy: SHADOW_TRADER_STRATEGY,
    label: 'Hybrid v1 shadow',
    status: 'ready',
    criteria,
    selectedWallets,
    selectedWalletCount: Object.keys(selectedWallets).length,
    candidatesScoredCount: result.rows.length,
    lastEvaluatedAt: new Date().toISOString(),
  };
}

async function getCopyPoolSnapshot(pool, { thresholds: thresholdOverrides = {} } = {}) {
  const thresholds = defaultCopyPoolThresholds(thresholdOverrides);
  const [walletResult, addedResult, removedResult] = await Promise.all([
    pool.query('select * from copy_pool_traders order by protected desc, source asc, added_at asc nulls last, wallet asc'),
    queryCopyPoolEvents(pool, 'added'),
    queryCopyPoolEvents(pool, 'removed'),
  ]);
  const wallets = {};
  for (const row of walletResult.rows) {
    const wallet = normalizeWallet(row.wallet);
    if (!wallet) continue;
    wallets[wallet] = makeCopyPoolWallet(row);
  }

  const rows = Object.values(wallets);
  const lastEvaluatedAt = rows
    .map((row) => row.lastEvaluatedAt)
    .filter(Boolean)
    .sort()
    .at(-1) || null;

  return {
    enabled: true,
    thresholds,
    counts: {
      active: rows.filter((row) => row.status === 'active').length,
      protectedActive: rows.filter((row) => row.status === 'active' && row.protected).length,
      autoActive: rows.filter((row) => row.status === 'active' && row.source === 'auto').length,
      autoRemoved: rows.filter((row) => row.status === 'removed' && row.source === 'auto').length,
    },
    lastEvaluatedAt,
    wallets,
    recentAdded: addedResult.rows.map(mapCopyPoolEventRow),
    recentRemoved: removedResult.rows.map(mapCopyPoolEventRow),
  };
}

async function upsertBaselineCopyPoolRows(client, baselineWallets, thresholds) {
  for (const rawWallet of baselineWallets || []) {
    const wallet = normalizeWallet(rawWallet);
    if (!wallet) continue;
    const traderResult = await client.query('select * from candidate_traders where wallet = $1', [wallet]);
    const existingResult = await client.query('select * from copy_pool_traders where wallet = $1', [wallet]);
    const trader = traderResult.rows[0] || {};
    const existing = existingResult.rows[0] || {};
    const metricsResult = await queryCopyPoolMetricRows(client, thresholds, wallet);
    const metrics = metricsFromRow(metricsResult.rows[0] || { wallet }, thresholds);
    const evaluatedAt = new Date().toISOString();
    await upsertCopyPoolRow(client, {
      ...metrics,
      wallet,
      source: 'baseline',
      status: 'active',
      protected: true,
      displayName: trader.display_name,
      pseudonym: trader.pseudonym,
      profileImage: trader.profile_image,
      reason: 'Protected baseline wallet',
      firstAddedAt: isoOrNull(existing.first_added_at) || evaluatedAt,
      addedAt: isoOrNull(existing.added_at) || evaluatedAt,
      removedAt: null,
    });
  }
}

async function queryCopyPoolMetricRows(clientOrPool, thresholds, wallet = null) {
  const params = [thresholds.windowDays];
  const walletClause = wallet ? 'where t.wallet = $2' : '';
  if (wallet) params.push(wallet);
  return clientOrPool.query(
    `
      with trader_base as (
        select t.wallet, t.display_name, t.pseudonym, t.profile_image, t.last_seen_at
        from candidate_traders t
        ${walletClause}
      ),
      resolved_buy as (
        select
          wallet,
          id,
          coalesce(nullif(condition_id, ''), nullif(market_slug, ''), nullif(market_title, ''), id) as market_key,
          status,
          resolved_at,
          trade_timestamp
        from candidate_trades
        where side = 'BUY'
          and status in ('resolved_win', 'resolved_loss')
          and trade_timestamp >= now() - ($1::integer * interval '1 day')
      ),
      deduped_buy as (
        select
          wallet,
          market_key,
          status,
          row_number() over (
            partition by wallet, market_key
            order by resolved_at desc nulls last, trade_timestamp desc, id desc
          ) as rn
        from resolved_buy
      ),
      resolved_stats as (
        select
          wallet,
          count(*)::integer as distinct_resolved_trade_count,
          count(*) filter (where status = 'resolved_win')::integer as win_count
        from deduped_buy
        where rn = 1
        group by wallet
      ),
      entry_stats as (
        select
          wallet,
          (sum(usd_size) / nullif(sum(shares), 0) * 100)::numeric as avg_entry_price_cents_30d,
          count(*)::integer as avg_entry_trade_count_30d
        from candidate_trades
        where side = 'BUY'
          and shares is not null
          and shares > 0
          and usd_size is not null
          and trade_timestamp >= now() - ($1::integer * interval '1 day')
        group by wallet
      )
      select
        t.wallet,
        t.display_name,
        t.pseudonym,
        t.profile_image,
        coalesce(r.distinct_resolved_trade_count, 0)::integer as distinct_resolved_trade_count,
        coalesce(r.win_count, 0)::integer as win_count,
        e.avg_entry_price_cents_30d,
        coalesce(e.avg_entry_trade_count_30d, 0)::integer as avg_entry_trade_count_30d
      from trader_base t
      left join resolved_stats r on r.wallet = t.wallet
      left join entry_stats e on e.wallet = t.wallet
    `,
    params
  );
}

async function queryShadowTraderMetricRows(clientOrPool, { windowDays = 30 } = {}) {
  return clientOrPool.query(
    `
      with trader_base as (
        select wallet, display_name, pseudonym, profile_image, last_seen_at
        from candidate_traders
      ),
      resolved_buy as (
        select
          wallet,
          id,
          coalesce(nullif(condition_id, ''), nullif(market_slug, ''), nullif(market_title, ''), id) as market_key,
          coalesce(nullif(event_slug, ''), nullif(market_slug, ''), nullif(market_title, ''), id) as event_key,
          status,
          price,
          usd_size,
          resolved_at,
          trade_timestamp,
          case when status = 'resolved_win' then 1 else 0 end - price as edge
        from candidate_trades
        where side = 'BUY'
          and status in ('resolved_win', 'resolved_loss')
          and resolved_at is not null
          and resolved_at >= now() - ($1::integer * interval '1 day')
          and price is not null
          and price > 0
          and price < 1
      ),
      deduped_buy as (
        select *
        from (
          select
            *,
            row_number() over (
              partition by wallet, market_key
              order by resolved_at desc nulls last, trade_timestamp desc, id desc
            ) as rn
          from resolved_buy
        ) x
        where rn = 1
      ),
      resolved_stats as (
        select
          wallet,
          count(*)::integer as distinct_resolved_trade_count,
          count(*) filter (where status = 'resolved_win')::integer as win_count,
          avg(case when status = 'resolved_win' then 1 else 0 end)::numeric * 100 as win_rate_pct,
          avg(edge)::numeric as mean_edge,
          (sum(usd_size * edge) / nullif(sum(usd_size), 0))::numeric as usd_weighted_edge,
          sum(usd_size)::numeric as resolved_usd_volume,
          count(distinct event_key)::integer as distinct_event_count
        from deduped_buy
        group by wallet
      ),
      entry_stats as (
        select
          wallet,
          (sum(usd_size) / nullif(sum(shares), 0) * 100)::numeric as avg_entry_price_cents_30d,
          count(*)::integer as avg_entry_trade_count_30d
        from candidate_trades
        where side = 'BUY'
          and shares is not null
          and shares > 0
          and usd_size is not null
          and trade_timestamp >= now() - ($1::integer * interval '1 day')
        group by wallet
      )
      select
        t.wallet,
        t.display_name,
        t.pseudonym,
        t.profile_image,
        coalesce(r.distinct_resolved_trade_count, 0)::integer as distinct_resolved_trade_count,
        coalesce(r.win_count, 0)::integer as win_count,
        r.win_rate_pct,
        e.avg_entry_price_cents_30d,
        coalesce(e.avg_entry_trade_count_30d, 0)::integer as avg_entry_trade_count_30d,
        r.mean_edge,
        r.usd_weighted_edge,
        r.resolved_usd_volume,
        coalesce(r.distinct_event_count, 0)::integer as distinct_event_count
      from trader_base t
      left join resolved_stats r on r.wallet = t.wallet
      left join entry_stats e on e.wallet = t.wallet
    `,
    [windowDays]
  );
}

async function upsertCopyPoolRow(client, row) {
  await client.query(
    `
      insert into copy_pool_traders (
        wallet, source, status, protected, display_name, pseudonym, profile_image,
        distinct_resolved_trade_count, win_count, win_rate_pct, avg_entry_price_cents_30d,
        avg_entry_trade_count_30d, eligible, reason, first_added_at, added_at, removed_at,
        last_evaluated_at, payload, updated_at
      )
      values (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11,
        $12, $13, $14, $15, $16, $17,
        now(), $18::jsonb, now()
      )
      on conflict (wallet)
      do update set
        source = excluded.source,
        status = excluded.status,
        protected = excluded.protected,
        display_name = coalesce(excluded.display_name, copy_pool_traders.display_name),
        pseudonym = coalesce(excluded.pseudonym, copy_pool_traders.pseudonym),
        profile_image = coalesce(excluded.profile_image, copy_pool_traders.profile_image),
        distinct_resolved_trade_count = excluded.distinct_resolved_trade_count,
        win_count = excluded.win_count,
        win_rate_pct = excluded.win_rate_pct,
        avg_entry_price_cents_30d = excluded.avg_entry_price_cents_30d,
        avg_entry_trade_count_30d = excluded.avg_entry_trade_count_30d,
        eligible = excluded.eligible,
        reason = excluded.reason,
        first_added_at = coalesce(copy_pool_traders.first_added_at, excluded.first_added_at),
        added_at = excluded.added_at,
        removed_at = excluded.removed_at,
        last_evaluated_at = now(),
        payload = excluded.payload,
        updated_at = now()
    `,
    [
      row.wallet,
      row.source,
      row.status,
      Boolean(row.protected),
      row.displayName || null,
      row.pseudonym || null,
      row.profileImage || null,
      Number(row.distinctResolvedTradeCount || 0),
      Number(row.winCount || 0),
      nullableNumber(row.winRatePct),
      nullableNumber(row.avgEntryPriceCents30d),
      Number(row.avgEntryTradeCount30d || 0),
      Boolean(row.eligible),
      row.reason || null,
      row.firstAddedAt || null,
      row.addedAt || null,
      row.removedAt || null,
      JSON.stringify({
        distinctResolvedTradeCount: Number(row.distinctResolvedTradeCount || 0),
        winCount: Number(row.winCount || 0),
        winRatePct: nullableNumber(row.winRatePct),
        avgEntryPriceCents30d: nullableNumber(row.avgEntryPriceCents30d),
        avgEntryTradeCount30d: Number(row.avgEntryTradeCount30d || 0),
        eligible: Boolean(row.eligible),
        retained: Boolean(row.retained),
        reason: row.reason || null,
        retentionReason: row.retentionReason || null,
      }),
    ]
  );
}

async function insertCopyPoolEvent(client, wallet, action, source, reason, metrics) {
  await client.query(
    `
      insert into copy_pool_events (wallet, action, source, reason, metrics, created_at)
      values ($1, $2, $3, $4, $5::jsonb, now())
    `,
    [wallet, action, source, reason || null, JSON.stringify(metrics || {})]
  );
}

function queryCopyPoolEvents(pool, action) {
  return pool.query(
    `
      select
        e.id,
        e.wallet,
        e.action,
        e.source,
        e.reason,
        e.metrics,
        e.created_at,
        coalesce(c.display_name, t.display_name) as display_name,
        coalesce(c.pseudonym, t.pseudonym) as pseudonym,
        coalesce(c.profile_image, t.profile_image) as profile_image
      from copy_pool_events e
      left join copy_pool_traders c on c.wallet = e.wallet
      left join candidate_traders t on t.wallet = e.wallet
      where e.action = $1
      order by e.created_at desc
      limit 8
    `,
    [action]
  );
}

function metricsFromRow(row, thresholds) {
  const distinctResolvedTradeCount = Number(row.distinct_resolved_trade_count || 0);
  const winCount = Number(row.win_count || 0);
  const winRatePct = distinctResolvedTradeCount ? (winCount / distinctResolvedTradeCount) * 100 : null;
  const avgEntryPriceCents30d = nullableNumber(row.avg_entry_price_cents_30d);
  const avgEntryTradeCount30d = Number(row.avg_entry_trade_count_30d || 0);
  const base = {
    distinctResolvedTradeCount,
    winCount,
    winRatePct,
    avgEntryPriceCents30d,
    avgEntryTradeCount30d,
  };
  return {
    ...base,
    eligible: isCopyPoolEligible(base, thresholds),
    reason: copyPoolEligibilityReason(base, thresholds),
    retained: isCopyPoolRetained(base, thresholds),
    retentionReason: copyPoolRetentionReason(base, thresholds),
  };
}

function mapShadowMetricRow(row) {
  const wallet = normalizeWallet(row.wallet);
  return {
    wallet,
    displayName: row.display_name,
    pseudonym: row.pseudonym,
    profileImage: row.profile_image,
    distinctResolvedTradeCount: Number(row.distinct_resolved_trade_count || 0),
    winCount: Number(row.win_count || 0),
    winRatePct: nullableNumberFromPg(row.win_rate_pct),
    avgEntryPriceCents30d: nullableNumberFromPg(row.avg_entry_price_cents_30d),
    avgEntryTradeCount30d: Number(row.avg_entry_trade_count_30d || 0),
    meanEdge: nullableNumberFromPg(row.mean_edge),
    usdWeightedEdge: nullableNumberFromPg(row.usd_weighted_edge),
    resolvedUsdVolume: nullableNumberFromPg(row.resolved_usd_volume),
    distinctEventCount: Number(row.distinct_event_count || 0),
  };
}

function isHybridV1Eligible(metrics, criteria = SHADOW_TRADER_CRITERIA) {
  return (
    Boolean(metrics.wallet) &&
    metrics.distinctResolvedTradeCount >= criteria.minResolved &&
    numberAtLeast(metrics.winRatePct, criteria.minWinRatePct) &&
    numberAbove(metrics.meanEdge, criteria.minMeanEdge) &&
    numberAbove(metrics.usdWeightedEdge, criteria.minUsdWeightedEdge)
  );
}

function mapCopyPoolEventRow(row) {
  const metrics = row.metrics || {};
  return {
    id: Number(row.id),
    wallet: row.wallet,
    action: row.action,
    source: row.source,
    reason: row.reason,
    createdAt: isoOrNull(row.created_at),
    displayName: row.display_name,
    pseudonym: row.pseudonym,
    profileImage: row.profile_image,
    distinctResolvedTradeCount: Number(metrics.distinctResolvedTradeCount || 0),
    winRatePct: nullableNumber(metrics.winRatePct),
    avgEntryPriceCents30d: nullableNumber(metrics.avgEntryPriceCents30d),
  };
}

function mapLeaderboardRow(row) {
  const pnlTradeCount = Number(row.all_time_pnl_trade_count || 0);
  const winCount = Number(row.win_count || 0);
  const distinct30d = Number(row.resolved_distinct_trade_count_30d || 0);
  const winCountDistinct30d = Number(row.win_count_distinct_30d || 0);
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
    resolvedDistinctTradeCount30d: distinct30d,
    winCountDistinct30d,
    winRatePctDistinct30d: distinct30d ? (winCountDistinct30d / distinct30d) * 100 : null,
    recentFormResults: Array.isArray(row.recent_form_results) ? row.recent_form_results : [],
    monthlyPerformance: mapMonthlyPerformance(row.monthly_performance),
    metrics: {
      roiPct: nullableNumberFromPg(row.roi_pct),
      profitFactor: nullableNumberFromPg(row.profit_factor),
      profitFactorDisplayCapHit: Boolean(row.profit_factor_display_cap_hit),
      maxDrawdownUsd: nullableNumberFromPg(row.max_drawdown_usd),
      medianEntryCents: nullableNumberFromPg(row.median_entry_cents),
      avgTradeSizeUsd: nullableNumberFromPg(row.avg_trade_size_usd),
      avgWinUsd: nullableNumberFromPg(row.avg_win_usd),
      avgLossUsd: nullableNumberFromPg(row.avg_loss_usd),
      recent7dTradeCount: Number(row.recent_7d_trade_count || 0),
      recent7dWinRatePct: nullableNumberFromPg(row.recent_7d_win_rate_pct),
      recent14dTradeCount: Number(row.recent_14d_trade_count || 0),
      recent14dWinRatePct: nullableNumberFromPg(row.recent_14d_win_rate_pct),
      topWinSharePct: nullableNumberFromPg(row.top_win_share_pct),
    },
  };
}

function mapMonthlyPerformance(value) {
  const items = Array.isArray(value) ? value : [];
  return items
    .map((item) => ({
      index: Number(item.index || 0),
      label: item.label || null,
      startAt: isoOrNull(item.startAt),
      endAt: isoOrNull(item.endAt),
      distinctResolvedTradeCount: Number(item.distinctResolvedTradeCount || 0),
      winCount: Number(item.winCount || 0),
      winRatePct: nullableNumber(item.winRatePct),
      avgEntryPriceCents: nullableNumber(item.avgEntryPriceCents),
      avgEntryTradeCount: Number(item.avgEntryTradeCount || 0),
      pnlTradeCount: Number(item.pnlTradeCount || 0),
      profitUsd: numberFromPg(item.profitUsd),
      roiPct: nullableNumber(item.roiPct),
    }))
    .sort((a, b) => a.index - b.index);
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

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberAtLeast(value, minimum) {
  return value !== null && Number.isFinite(value) && value >= minimum;
}

function numberAbove(value, minimum) {
  return value !== null && Number.isFinite(value) && value > minimum;
}

function isoOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
