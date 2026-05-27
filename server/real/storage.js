import { Pool } from 'pg';

const SCHEMA_VERSION = 1;

export async function createRealStorage() {
  if (!process.env.DATABASE_URL) return createMemoryRealStorage('memory_only');

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
    return createMemoryRealStorage('postgres_error', error.message);
  }

  return {
    mode: 'postgres',
    durable: true,
    migrateError: null,
    followTrader: (profile) => followTrader(pool, profile),
    unfollowTrader: (wallet) => unfollowTrader(pool, wallet),
    listActiveFollows: () => listActiveFollows(pool),
    hasOrderAttempt: (id) => hasOrderAttempt(pool, id),
    findPositionByMarketKeys: (params) => findPositionByMarketKeys(pool, params),
    recordOrderAttempt: (attempt) => recordOrderAttempt(pool, attempt),
    getOpenPositions: (limit) => getOpenPositions(pool, limit),
    updatePosition: (id, patch) => updatePosition(pool, id, patch),
    getState: (params) => getRealState(pool, params),
    close: () => pool.end(),
  };
}

export function createMemoryRealStorage(mode = 'memory_only', migrateError = null) {
  const follows = new Map();
  const orders = new Map();
  const positions = new Map();
  const events = [];

  function addEvent(event) {
    events.unshift({
      id: events.length + 1,
      createdAt: new Date().toISOString(),
      ...event,
    });
    events.splice(500);
  }

  return {
    mode,
    durable: false,
    migrateError,
    async followTrader(profile) {
      const wallet = normalizeWallet(profile?.wallet);
      if (!wallet) throw new Error('Invalid wallet');
      const now = new Date().toISOString();
      const existing = follows.get(wallet);
      const wasActive = existing?.status === 'active';
      const entry = {
        wallet,
        displayName: profile.displayName || existing?.displayName || null,
        pseudonym: profile.pseudonym || existing?.pseudonym || null,
        profileImage: profile.profileImage || existing?.profileImage || null,
        status: 'active',
        addedAt: wasActive ? existing.addedAt : now,
        removedAt: null,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      };
      follows.set(wallet, entry);
      if (!wasActive) addEvent({ wallet, action: 'followed', reason: 'Manual real follow added', payload: entry });
      return { entry, inserted: !existing, activated: !wasActive };
    },
    async unfollowTrader(walletInput) {
      const wallet = normalizeWallet(walletInput);
      if (!wallet) throw new Error('Invalid wallet');
      const existing = follows.get(wallet);
      if (!existing || existing.status !== 'active') return null;
      const now = new Date().toISOString();
      const entry = { ...existing, status: 'removed', removedAt: now, updatedAt: now };
      follows.set(wallet, entry);
      addEvent({ wallet, action: 'removed', reason: 'Manual real follow removed', payload: entry });
      return entry;
    },
    async listActiveFollows() {
      return [...follows.values()].filter((follow) => follow.status === 'active');
    },
    async hasOrderAttempt(id) {
      return orders.has(id);
    },
    async findPositionByMarketKeys({ marketKeys, traderWallet = null } = {}) {
      const keys = normalizeMarketKeys(marketKeys);
      if (!keys.length) return null;
      const wallet = normalizeWallet(traderWallet);
      return [...positions.values()]
        .filter((position) => position.status)
        .find((position) => {
          if (wallet && position.traderWallet !== wallet) return false;
          return positionMarketKeys(position).some((key) => keys.includes(key));
        }) || null;
    },
    async recordOrderAttempt(attempt) {
      if (orders.has(attempt.id)) return { inserted: false, order: orders.get(attempt.id), position: null };
      orders.set(attempt.id, attempt);
      let position = null;
      if (isFilledAttempt(attempt)) {
        position = buildPositionFromAttempt(attempt);
        positions.set(position.id, position);
      }
      addEvent({
        wallet: attempt.traderWallet,
        action: isFilledAttempt(attempt) ? attempt.status : 'rejected',
        reason: attempt.reason,
        payload: attempt,
      });
      return { inserted: true, order: attempt, position };
    },
    async getOpenPositions(limit = 250) {
      return [...positions.values()]
        .filter((position) => position.status === 'open')
        .sort((a, b) => Date.parse(b.openedAt || 0) - Date.parse(a.openedAt || 0))
        .slice(0, limit);
    },
    async updatePosition(id, patch) {
      const existing = positions.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
      positions.set(id, updated);
      return updated;
    },
    async getState(params = {}) {
      return buildState({
        mode,
        durable: false,
        migrateError,
        follows: [...follows.values()],
        orders: [...orders.values()],
        positions: [...positions.values()],
        events,
        limit: params.limit,
      });
    },
    async close() {},
  };
}

async function migrate(pool) {
  await pool.query(`
    create table if not exists real_schema_migrations (
      version integer primary key,
      applied_at timestamptz not null default now()
    );

    create table if not exists real_followed_traders (
      wallet text primary key,
      display_name text,
      pseudonym text,
      profile_image text,
      status text not null,
      added_at timestamptz,
      removed_at timestamptz,
      payload jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists real_orders (
      id text primary key,
      source_trade_id text not null,
      trader_wallet text not null,
      asset text,
      condition_id text,
      market_slug text,
      event_slug text,
      market_title text,
      market_icon text,
      polymarket_url text,
      outcome text,
      source_price_cents numeric,
      min_guard_cents numeric,
      max_guard_cents numeric,
      stake_usd numeric,
      status text not null,
      reason_code text,
      reason text,
      best_ask_cents numeric,
      worst_ask_cents numeric,
      vwap_cents numeric,
      estimated_shares numeric,
      notional_available_usd numeric,
      book_hash text,
      source_trade_timestamp timestamptz,
      checked_at timestamptz not null,
      payload jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    drop index if exists real_orders_source_trade_id_idx;
    create index if not exists real_orders_source_trade_id_idx on real_orders (source_trade_id);
    create index if not exists real_orders_trader_checked_idx on real_orders (trader_wallet, checked_at desc);
    create index if not exists real_orders_status_idx on real_orders (status, checked_at desc);

    create table if not exists real_positions (
      id text primary key,
      order_id text not null unique references real_orders(id) on delete cascade,
      source_trade_id text not null,
      trader_wallet text not null,
      asset text,
      condition_id text,
      market_slug text,
      market_title text,
      market_icon text,
      polymarket_url text,
      outcome text,
      status text not null,
      stake_usd numeric,
      shares numeric,
      source_price_cents numeric,
      entry_price_cents numeric,
      current_price_cents numeric,
      current_value_usd numeric,
      realized_pnl_usd numeric,
      unrealized_pnl_usd numeric,
      winning_outcome text,
      resolution_status text,
      opened_at timestamptz,
      resolved_at timestamptz,
      closed_at timestamptz,
      payload jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create index if not exists real_positions_status_idx on real_positions (status, opened_at desc);
    create index if not exists real_positions_trader_idx on real_positions (trader_wallet, opened_at desc);

    create table if not exists real_events (
      id bigserial primary key,
      wallet text,
      action text not null,
      reason text,
      payload jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );

    create index if not exists real_events_created_idx on real_events (created_at desc);
    create index if not exists real_events_wallet_idx on real_events (wallet, created_at desc);

    insert into real_schema_migrations (version)
    values (${SCHEMA_VERSION})
    on conflict (version) do nothing;
  `);
}

async function followTrader(pool, profile) {
  const wallet = normalizeWallet(profile?.wallet);
  if (!wallet) throw new Error('Invalid wallet');
  const client = await pool.connect();
  try {
    await client.query('begin');
    const existing = await client.query('select * from real_followed_traders where wallet = $1 for update', [wallet]);
    const wasActive = existing.rows[0]?.status === 'active';
    const result = await client.query(
      `
        insert into real_followed_traders (
          wallet, display_name, pseudonym, profile_image, status, added_at, removed_at, payload, updated_at
        )
        values ($1, $2, $3, $4, 'active', now(), null, $5::jsonb, now())
        on conflict (wallet)
        do update set
          display_name = coalesce(excluded.display_name, real_followed_traders.display_name),
          pseudonym = coalesce(excluded.pseudonym, real_followed_traders.pseudonym),
          profile_image = coalesce(excluded.profile_image, real_followed_traders.profile_image),
          status = 'active',
          added_at = case when real_followed_traders.status = 'active' then real_followed_traders.added_at else now() end,
          removed_at = null,
          payload = excluded.payload,
          updated_at = now()
        returning *
      `,
      [wallet, profile.displayName || null, profile.pseudonym || null, profile.profileImage || null, JSON.stringify(profile)]
    );
    const entry = mapFollowRow(result.rows[0]);
    if (!wasActive) {
      await insertEvent(client, { wallet, action: 'followed', reason: 'Manual real follow added', payload: entry });
    }
    await client.query('commit');
    return { entry, inserted: existing.rowCount === 0, activated: !wasActive };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function unfollowTrader(pool, walletInput) {
  const wallet = normalizeWallet(walletInput);
  if (!wallet) throw new Error('Invalid wallet');
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await client.query(
      `
        update real_followed_traders
        set status = 'removed', removed_at = now(), updated_at = now()
        where wallet = $1 and status = 'active'
        returning *
      `,
      [wallet]
    );
    if (!result.rowCount) {
      await client.query('commit');
      return null;
    }
    const entry = mapFollowRow(result.rows[0]);
    await insertEvent(client, { wallet, action: 'removed', reason: 'Manual real follow removed', payload: entry });
    await client.query('commit');
    return entry;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function listActiveFollows(pool) {
  const result = await pool.query("select * from real_followed_traders where status = 'active' order by added_at asc nulls last");
  return result.rows.map(mapFollowRow);
}

async function hasOrderAttempt(pool, id) {
  if (!id) return false;
  const result = await pool.query('select 1 from real_orders where id = $1', [id]);
  return result.rowCount > 0;
}

async function findPositionByMarketKeys(pool, { marketKeys, traderWallet = null } = {}) {
  const keys = normalizeMarketKeys(marketKeys);
  if (!keys.length) return null;
  const wallet = normalizeWallet(traderWallet);
  const values = [keys];
  let walletClause = '';
  if (wallet) {
    values.push(wallet);
    walletClause = `and trader_wallet = $${values.length}`;
  }
  const result = await pool.query(
    `
      select *
      from real_positions
      where (
        lower(coalesce(condition_id, '')) = any($1::text[])
        or lower(coalesce(market_slug, '')) = any($1::text[])
        or lower(coalesce(market_title, '')) = any($1::text[])
      )
      ${walletClause}
      order by opened_at asc nulls last, created_at asc
      limit 1
    `,
    values
  );
  return result.rowCount ? mapPositionRow(result.rows[0]) : null;
}

async function recordOrderAttempt(pool, attempt) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const insertResult = await client.query(
      `
        insert into real_orders (
          id, source_trade_id, trader_wallet, asset, condition_id, market_slug, event_slug,
          market_title, market_icon, polymarket_url, outcome, source_price_cents, min_guard_cents,
          max_guard_cents, stake_usd, status, reason_code, reason, best_ask_cents, worst_ask_cents,
          vwap_cents, estimated_shares, notional_available_usd, book_hash, source_trade_timestamp,
          checked_at, payload, updated_at
        )
        values (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, $13,
          $14, $15, $16, $17, $18, $19, $20,
          $21, $22, $23, $24, $25,
          $26, $27::jsonb, now()
        )
        on conflict (id) do nothing
        returning *
      `,
      [
        attempt.id,
        attempt.sourceTradeId,
        attempt.traderWallet,
        attempt.asset || null,
        attempt.conditionId || null,
        attempt.marketSlug || null,
        attempt.eventSlug || null,
        attempt.marketTitle || null,
        attempt.marketIcon || null,
        attempt.polymarketUrl || null,
        attempt.outcome || null,
        numberOrNull(attempt.sourcePriceCents),
        numberOrNull(attempt.minGuardCents),
        numberOrNull(attempt.maxGuardCents),
        numberOrNull(attempt.stakeUsd),
        attempt.status,
        attempt.reasonCode || null,
        attempt.reason || null,
        numberOrNull(attempt.bestAskCents),
        numberOrNull(attempt.worstAskCents),
        numberOrNull(attempt.vwapCents),
        numberOrNull(attempt.estimatedShares),
        numberOrNull(attempt.notionalAvailableUsd),
        attempt.bookHash || null,
        dateOrNull(attempt.sourceTradeTimestamp),
        dateOrNull(attempt.checkedAt) || new Date(),
        JSON.stringify(attempt),
      ]
    );
    if (!insertResult.rowCount) {
      await client.query('commit');
      return { inserted: false, order: attempt, position: null };
    }

    let position = null;
    if (isFilledAttempt(attempt)) {
      position = buildPositionFromAttempt(attempt);
      await upsertPosition(client, position);
    }
    await insertEvent(client, {
      wallet: attempt.traderWallet,
      action: isFilledAttempt(attempt) ? attempt.status : 'rejected',
      reason: attempt.reason,
      payload: attempt,
    });
    await client.query('commit');
    return { inserted: true, order: mapOrderRow(insertResult.rows[0]), position };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function getOpenPositions(pool, limit = 250) {
  const result = await pool.query(
    "select * from real_positions where status = 'open' order by opened_at desc nulls last limit $1",
    [limit]
  );
  return result.rows.map(mapPositionRow);
}

async function updatePosition(pool, id, patch) {
  const current = await pool.query('select payload from real_positions where id = $1', [id]);
  if (!current.rowCount) return null;
  const updated = { ...current.rows[0].payload, ...patch, updatedAt: new Date().toISOString() };
  const result = await pool.query(
    `
      update real_positions
      set
        status = $2,
        current_price_cents = $3,
        current_value_usd = $4,
        realized_pnl_usd = $5,
        unrealized_pnl_usd = $6,
        winning_outcome = $7,
        resolution_status = $8,
        resolved_at = $9,
        closed_at = $10,
        payload = $11::jsonb,
        updated_at = now()
      where id = $1
      returning *
    `,
    [
      id,
      updated.status || 'open',
      numberOrNull(updated.currentPriceCents),
      numberOrNull(updated.currentValueUsd),
      numberOrNull(updated.realizedPnlUsd),
      numberOrNull(updated.unrealizedPnlUsd),
      updated.winningOutcome || null,
      updated.resolutionStatus || null,
      dateOrNull(updated.resolvedAt),
      dateOrNull(updated.closedAt),
      JSON.stringify(updated),
    ]
  );
  return mapPositionRow(result.rows[0]);
}

async function getRealState(pool, params = {}) {
  const limit = boundedLimit(params.limit, 250);
  const [followResult, orderResult, positionResult, eventResult] = await Promise.all([
    pool.query('select * from real_followed_traders order by status asc, added_at desc nulls last'),
    pool.query('select * from real_orders order by checked_at desc limit $1', [Math.max(limit, 1000)]),
    pool.query('select * from real_positions order by opened_at desc nulls last limit $1', [Math.max(limit, 1000)]),
    pool.query('select * from real_events order by created_at desc limit $1', [limit]),
  ]);
  return buildState({
    mode: 'postgres',
    durable: true,
    follows: followResult.rows.map(mapFollowRow),
    orders: orderResult.rows.map(mapOrderRow),
    positions: positionResult.rows.map(mapPositionRow),
    events: eventResult.rows.map(mapEventRow),
    limit,
  });
}

async function upsertPosition(client, position) {
  await client.query(
    `
      insert into real_positions (
        id, order_id, source_trade_id, trader_wallet, asset, condition_id, market_slug, market_title,
        market_icon, polymarket_url, outcome, status, stake_usd, shares, source_price_cents,
        entry_price_cents, current_price_cents, current_value_usd, realized_pnl_usd, unrealized_pnl_usd,
        winning_outcome, resolution_status, opened_at, resolved_at, closed_at, payload, updated_at
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20,
        $21, $22, $23, $24, $25, $26::jsonb, now()
      )
      on conflict (id)
      do update set
        status = excluded.status,
        current_price_cents = excluded.current_price_cents,
        current_value_usd = excluded.current_value_usd,
        realized_pnl_usd = excluded.realized_pnl_usd,
        unrealized_pnl_usd = excluded.unrealized_pnl_usd,
        winning_outcome = excluded.winning_outcome,
        resolution_status = excluded.resolution_status,
        resolved_at = excluded.resolved_at,
        closed_at = excluded.closed_at,
        payload = excluded.payload,
        updated_at = now()
    `,
    [
      position.id,
      position.orderId,
      position.sourceTradeId,
      position.traderWallet,
      position.asset || null,
      position.conditionId || null,
      position.marketSlug || null,
      position.marketTitle || null,
      position.marketIcon || null,
      position.polymarketUrl || null,
      position.outcome || null,
      position.status,
      numberOrNull(position.stakeUsd),
      numberOrNull(position.shares),
      numberOrNull(position.sourcePriceCents),
      numberOrNull(position.entryPriceCents),
      numberOrNull(position.currentPriceCents),
      numberOrNull(position.currentValueUsd),
      numberOrNull(position.realizedPnlUsd),
      numberOrNull(position.unrealizedPnlUsd),
      position.winningOutcome || null,
      position.resolutionStatus || null,
      dateOrNull(position.openedAt),
      dateOrNull(position.resolvedAt),
      dateOrNull(position.closedAt),
      JSON.stringify(position),
    ]
  );
}

async function insertEvent(client, event) {
  await client.query(
    `
      insert into real_events (wallet, action, reason, payload, created_at)
      values ($1, $2, $3, $4::jsonb, now())
    `,
    [event.wallet || null, event.action, event.reason || null, JSON.stringify(event.payload || {})]
  );
}

export function buildPositionFromAttempt(attempt) {
  const entryPriceCents = numberOrNull(attempt.vwapCents) ?? numberOrNull(attempt.worstAskCents);
  const shares = numberOrNull(attempt.estimatedShares);
  const stakeUsd = numberOrNull(attempt.stakeUsd) ?? 10;
  return {
    id: `real-pos-${attempt.sourceTradeId}`,
    orderId: attempt.id,
    sourceTradeId: attempt.sourceTradeId,
    traderWallet: attempt.traderWallet,
    traderName: attempt.traderName || attempt.traderWallet,
    asset: attempt.asset || null,
    marketConditionId: attempt.conditionId || null,
    conditionId: attempt.conditionId || null,
    marketSlug: attempt.marketSlug || null,
    marketTitle: attempt.marketTitle || 'Unknown market',
    marketIcon: attempt.marketIcon || null,
    polymarketUrl: attempt.polymarketUrl || null,
    side: 'BUY',
    outcome: attempt.outcome || 'Unknown outcome',
    status: 'open',
    stakeUsd,
    shares,
    grossShares: shares,
    sourcePriceCents: numberOrNull(attempt.sourcePriceCents),
    entryPriceCents,
    currentPriceCents: entryPriceCents,
    currentValueUsd: stakeUsd,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
    unrealizedPnlPct: 0,
    feeStatus: 'unknown',
    openedAt: attempt.checkedAt,
    updatedAt: attempt.checkedAt,
    dryRun: attempt.dryRun !== false,
    liveExecution: Boolean(attempt.liveExecution),
    orderType: 'FOK',
    clobOrderId: attempt.clobOrderId || null,
    clobStatus: attempt.clobStatus || null,
    clobTradeIds: attempt.clobTradeIds || [],
    clobTransactionHashes: attempt.clobTransactionHashes || [],
    fillSlippageCents: Number.isFinite(entryPriceCents) && Number.isFinite(Number(attempt.sourcePriceCents))
      ? entryPriceCents - Number(attempt.sourcePriceCents)
      : null,
  };
}

function buildState({ mode, durable, migrateError = null, follows, orders, positions, events, limit = 250 }) {
  const sortedOrders = [...orders].sort((a, b) => Date.parse(b.checkedAt || 0) - Date.parse(a.checkedAt || 0));
  const sortedPositions = [...positions].sort((a, b) => Date.parse(b.openedAt || 0) - Date.parse(a.openedAt || 0));
  const followsWithMetrics = follows.map((follow) => ({
    ...follow,
    metrics: metricsForWallet(follow, sortedOrders, sortedPositions),
  }));
  return {
    ok: true,
    mode: 'dry_run',
    storageMode: mode,
    durable,
    migrateError,
    summary: aggregateMetrics(sortedOrders, sortedPositions, follows),
    follows: followsWithMetrics,
    orders: sortedOrders.slice(0, limit),
    positions: sortedPositions.slice(0, limit),
    events: [...events].slice(0, limit),
  };
}

function metricsForWallet(follow, orders, positions) {
  const addedAt = Date.parse(follow.addedAt || 0);
  const walletOrders = orders.filter((order) => (
    order.traderWallet === follow.wallet &&
    (!Number.isFinite(addedAt) || Date.parse(order.sourceTradeTimestamp || order.checkedAt || 0) >= addedAt)
  ));
  const walletPositions = positions.filter((position) => (
    position.traderWallet === follow.wallet &&
    (!Number.isFinite(addedAt) || Date.parse(position.openedAt || 0) >= addedAt)
  ));
  return aggregateMetrics(walletOrders, walletPositions, [follow]);
}

function aggregateMetrics(orders, positions, follows = []) {
  const attemptedCount = orders.length;
  const wouldFillCount = orders.filter(isFilledAttempt).length;
  const rejectedCount = orders.filter((order) => order.status === 'rejected').length;
  const openPositions = positions.filter((position) => position.status === 'open');
  const closedPositions = positions.filter((position) => position.status !== 'open');
  const realizedPnlUsd = positions.reduce((sum, position) => sum + (numberOrNull(position.realizedPnlUsd) ?? 0), 0);
  const unrealizedPnlUsd = openPositions.reduce((sum, position) => sum + (numberOrNull(position.unrealizedPnlUsd) ?? 0), 0);
  const openValueUsd = openPositions.reduce((sum, position) => sum + (numberOrNull(position.currentValueUsd) ?? 0), 0);
  const stakeUsd = positions.reduce((sum, position) => sum + (numberOrNull(position.stakeUsd) ?? 0), 0);
  const sourcePrices = orders.map((order) => numberOrNull(order.sourcePriceCents)).filter(Number.isFinite);
  const fillPrices = orders.map((order) => numberOrNull(order.vwapCents)).filter(Number.isFinite);
  const slippages = orders
    .map((order) => {
      const fill = numberOrNull(order.vwapCents);
      const source = numberOrNull(order.sourcePriceCents);
      return Number.isFinite(fill) && Number.isFinite(source) ? fill - source : null;
    })
    .filter(Number.isFinite);
  const rejectReasons = {};
  for (const order of orders) {
    if (order.status !== 'rejected') continue;
    const key = order.reasonCode || 'rejected';
    rejectReasons[key] = (rejectReasons[key] || 0) + 1;
  }

  return {
    activeFollowCount: follows.filter((follow) => follow.status === 'active').length,
    removedFollowCount: follows.filter((follow) => follow.status === 'removed').length,
    attemptedCount,
    wouldFillCount,
    rejectedCount,
    fillRatePct: attemptedCount ? (wouldFillCount / attemptedCount) * 100 : null,
    openPositionCount: openPositions.length,
    closedPositionCount: closedPositions.length,
    stakeUsd,
    openValueUsd,
    realizedPnlUsd,
    unrealizedPnlUsd,
    totalPnlUsd: realizedPnlUsd + unrealizedPnlUsd,
    avgSourcePriceCents: average(sourcePrices),
    avgFillPriceCents: average(fillPrices),
    avgSlippageCents: average(slippages),
    rejectReasons,
  };
}

function isFilledAttempt(order) {
  return ['would_fill', 'filled', 'live_filled'].includes(String(order?.status || '').toLowerCase());
}

function mapFollowRow(row) {
  return {
    wallet: row.wallet,
    displayName: row.display_name,
    pseudonym: row.pseudonym,
    profileImage: row.profile_image,
    status: row.status,
    addedAt: iso(row.added_at),
    removedAt: iso(row.removed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapOrderRow(row) {
  const payload = row.payload || {};
  return {
    ...payload,
    id: row.id,
    sourceTradeId: row.source_trade_id,
    traderWallet: row.trader_wallet,
    asset: row.asset,
    conditionId: row.condition_id,
    marketSlug: row.market_slug,
    eventSlug: row.event_slug,
    marketTitle: row.market_title,
    marketIcon: row.market_icon,
    polymarketUrl: row.polymarket_url,
    outcome: row.outcome,
    sourcePriceCents: numberFromPg(row.source_price_cents),
    minGuardCents: numberFromPg(row.min_guard_cents),
    maxGuardCents: numberFromPg(row.max_guard_cents),
    stakeUsd: numberFromPg(row.stake_usd),
    status: row.status,
    reasonCode: row.reason_code,
    reason: row.reason,
    bestAskCents: numberFromPg(row.best_ask_cents),
    worstAskCents: numberFromPg(row.worst_ask_cents),
    vwapCents: numberFromPg(row.vwap_cents),
    estimatedShares: numberFromPg(row.estimated_shares),
    notionalAvailableUsd: numberFromPg(row.notional_available_usd),
    bookHash: row.book_hash,
    sourceTradeTimestamp: iso(row.source_trade_timestamp),
    checkedAt: iso(row.checked_at),
  };
}

function mapPositionRow(row) {
  const payload = row.payload || {};
  return {
    ...payload,
    id: row.id,
    orderId: row.order_id,
    sourceTradeId: row.source_trade_id,
    traderWallet: row.trader_wallet,
    asset: row.asset,
    conditionId: row.condition_id,
    marketConditionId: row.condition_id,
    marketSlug: row.market_slug,
    marketTitle: row.market_title,
    marketIcon: row.market_icon,
    polymarketUrl: row.polymarket_url,
    outcome: row.outcome,
    status: row.status,
    stakeUsd: numberFromPg(row.stake_usd),
    shares: numberFromPg(row.shares),
    sourcePriceCents: numberFromPg(row.source_price_cents),
    entryPriceCents: numberFromPg(row.entry_price_cents),
    currentPriceCents: numberFromPg(row.current_price_cents),
    currentValueUsd: numberFromPg(row.current_value_usd),
    realizedPnlUsd: numberFromPg(row.realized_pnl_usd),
    unrealizedPnlUsd: numberFromPg(row.unrealized_pnl_usd),
    winningOutcome: row.winning_outcome,
    resolutionStatus: row.resolution_status,
    openedAt: iso(row.opened_at),
    resolvedAt: iso(row.resolved_at),
    closedAt: iso(row.closed_at),
  };
}

function mapEventRow(row) {
  return {
    id: row.id,
    wallet: row.wallet,
    action: row.action,
    reason: row.reason,
    payload: row.payload || {},
    createdAt: iso(row.created_at),
  };
}

function normalizeWallet(wallet) {
  const text = String(wallet || '').trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(text) ? text : null;
}

function normalizeMarketKeys(values) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean))];
}

function positionMarketKeys(position) {
  return normalizeMarketKeys([
    position?.conditionId,
    position?.marketConditionId,
    position?.marketSlug,
    position?.marketTitle,
  ]);
}

function average(values) {
  const usable = values.filter(Number.isFinite);
  if (!usable.length) return null;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

function boundedLimit(value, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(1000, Math.max(1, number));
}

function shouldUseSsl(databaseUrl) {
  if (process.env.PGSSLMODE === 'disable') return false;
  if (process.env.PGSSLMODE === 'require') return true;
  return /sslmode=require/i.test(databaseUrl);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberFromPg(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function dateOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function iso(value) {
  const date = dateOrNull(value);
  return date ? date.toISOString() : null;
}
