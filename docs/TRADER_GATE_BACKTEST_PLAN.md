# Autotrader Trader-Gate Improvement + Backtest Plan

## Context

We are working on this repo:

- Repo: `Mulanger/autotrader`
- Project: Polywhale Autotrader
- Purpose: local/demo copy-trading workbench for selected Polymarket/Polywhale leaderboard wallets.
- Current state:
  - Demo trading only.
  - Starts with `$1,000`.
  - Uses `$10` per copied buy.
  - Copies watched BUY trades priced at `75c` or lower.
  - Only the first copied trade from a wallet on a given market is copied.
  - Candidate tracker is behind `CANDIDATE_TRACKER_ENABLED=true`.
  - Candidate tracker polls Polymarket Data API, stores candidate trades, backfills wallets, resolves markets through Gamma, and serves `/api/candidates/leaderboard`.

Important files:

- `server/config.js`
- `server/copy-pool.js`
- `server/candidate-tracker/service.js`
- `server/candidate-tracker/storage.js`
- `server/candidate-tracker/routes.js`

The current auto-copy promotion gate is probably too weak.

Current gate:

```text
AUTO_COPY_MIN_DISTINCT_MARKETS = 15
AUTO_COPY_MIN_WIN_RATE_PCT = 75
AUTO_COPY_REMOVE_MIN_WIN_RATE_PCT = 70
AUTO_COPY_MAX_AEP_CENTS = 75
```

Current eligibility logic is basically:

```js
distinctResolvedTradeCount >= minDistinctResolvedMarkets
winRatePct >= minWinRatePct
avgEntryPriceCents30d < maxAvgEntryPriceCents
```

This finds “good-looking” traders, but likely not “extremely smart traders with a durable edge.”

---

## Core Problem

The current gate uses raw win rate too heavily.

In prediction markets, raw win rate is misleading.

| Trader | Entry Price | Win Rate | Real Quality |
|---|---:|---:|---|
| A | 90c | 92% | May be weak or bad |
| B | 40c | 58% | Could be strong |
| C | 12c | 25% | Could be very strong |

A trader buying 90c outcomes and winning 80% may still be unprofitable or mediocre.

A trader buying 25c outcomes and winning 40% may have a real edge.

The question should not be:

```text
How often did they win?
```

The better question is:

```text
Did they win more often than the market-implied probability at the price they paid?
```

---

## Proposed Theory

Replace raw win-rate gating with price-adjusted edge.

For each resolved BUY trade:

```text
implied probability = entry_price
actual result = 1 if resolved_win, 0 if resolved_loss
edge = actual_result - entry_price
```

Examples:

```text
Bought at 0.70 and won  => edge = +0.30
Bought at 0.70 and lost => edge = -0.70
Bought at 0.20 and won  => edge = +0.80
Bought at 0.20 and lost => edge = -0.20
```

Then calculate per trader:

```text
mean_edge = avg(actual_result - entry_price)
usd_weighted_edge = sum(usd_size * edge) / sum(usd_size)
```

This measures whether the trader beats the probability they paid.

---

## Better Trader Metrics To Add

Add these metrics:

```text
mean_edge
edge_stddev
edge_lower_bound
usd_weighted_edge
resolved_usd_volume
roi_pct
profit_factor
distinct_event_count
max_event_exposure_pct
elite_score
copy_tier
```

### `mean_edge`

Average price-adjusted edge.

```text
avg(actual_result - entry_price)
```

### `usd_weighted_edge`

Capital-weighted edge.

```text
sum(usd_size * (actual_result - entry_price)) / sum(usd_size)
```

This is better than normal edge because it shows whether the trader puts size behind good bets.

### `edge_lower_bound`

Confidence-adjusted edge.

```text
edge_lower_bound = mean_edge - 1.64 * stddev(edge) / sqrt(n)
```

This prevents small-sample lucky traders from passing too easily.

### `resolved_usd_volume`

Total resolved USD volume used in the score.

### `distinct_event_count`

Number of distinct events/categories traded.

This avoids promoting traders who only won on one correlated market cluster.

### `max_event_exposure_pct`

How much of the trader’s resolved exposure came from their biggest event cluster.

Avoid cases where one event makes the trader look great.

### `elite_score`

Composite score used for ranking.

Potential formula:

```text
elite_score =
  30 * confidence_adjusted_edge
+ 20 * usd_weighted_edge
+ 15 * markout_quality
+ 10 * market_diversity
+ 10 * sample_size_quality
+ 10 * recent_form
+ 5  * drawdown_control
```

In the first implementation, skip `markout_quality` unless historical market price snapshots exist.

---

## Suggested New Gates

Do not immediately use this for real trading. First backtest.

### Old/current gate

```text
n_resolved >= 15
win_rate >= 75%
avg_entry_price < 75c
```

### Edge gate loose

```text
n_resolved >= 25
mean_edge >= 0.05
edge_lower_bound >= -0.01
usd_weighted_edge >= 0.04
distinct_events >= 6
```

### Edge gate strict

```text
n_resolved >= 40
mean_edge >= 0.08
edge_lower_bound >= 0.02
usd_weighted_edge >= 0.06
distinct_events >= 8
resolved_usd_volume >= 20_000
```

The strict gate is intended to find “extremely smart traders with edge.”

---

## Tier System Recommendation

Do not go directly from candidate to active copy.

Add tiers:

```text
observe_only
paper_copy
shadow_elite
real_eligible
disabled
```

| Tier | Meaning | Action |
|---|---|---|
| observe_only | Candidate looks interesting | Track only |
| paper_copy | Passes weak gate | Demo copy only |
| shadow_elite | Passes strong edge gate | Track as if copied, compare results |
| real_eligible | Durable edge with enough history | May later be real-money eligible |
| disabled | Edge decayed | Stop copying |

For now, implement only backtesting and maybe shadow labels. Do not enable real execution.

---

## Important Backtest Requirement

We have thousands of resolved trades already in the DB.

We need to test whether the edge theory would have been more profitable than the current gate.

The correct test is not:

```text
Which traders look best over the full database?
```

That leaks future information.

The correct test is:

```text
At each point in history, using only information known at that time, which traders would each gate have selected, and what would have happened if we copied their next trades?
```

This must be walk-forward / out-of-sample.

Use `resolved_at` for training eligibility, not just `trade_timestamp`.

Why:

- A trade placed on Monday may only resolve on Friday.
- On Tuesday, we would not know whether that trade won.
- Therefore, training data for a historical date must include only trades with `resolved_at < asof_date`.

---

## Backtest Design

Run a walk-forward simulation.

Example:

```text
Training window: previous 30 days of resolved trades
Evaluation window: next 7 days of new trades
Step size: 1 day
Stake: $10 per copied trade
Only BUY trades
Only resolved_win / resolved_loss trades
```

For each historical `asof_date`:

1. Look at trades resolved before `asof_date`.
2. Score every trader using only those known resolved trades.
3. Select traders using:
   - old_gate
   - edge_gate_loose
   - edge_gate_strict
4. Simulate copying their future BUY trades during the evaluation window.
5. When those trades resolve, calculate copied PnL.
6. Move forward one day.
7. Repeat.

Important: avoid double-counting the same copied trade across overlapping windows.

Dedupe by:

```text
strategy + trade_id
```

Copy a trade once, using the earliest date when the strategy would have selected that trader before the trade.

---

## PnL Formula For Simulated Copy

Assume fixed stake of `$10` per copied trade.

For a BUY at price `p`:

```text
if resolved_win:
  pnl = stake * ((1 - p) / p)

if resolved_loss:
  pnl = -stake
```

Example:

```text
Buy at 0.25 with $10:
- If win: profit = $10 * (0.75 / 0.25) = $30
- If loss: profit = -$10
```

This approximates buying shares at the same price as the trader.

---

## Backtest Outputs Needed

Create reports.

### Strategy summary

```text
strategy
copied_trade_count
copied_wallet_count
total_staked
total_pnl
roi_pct
win_rate
avg_entry_price
profit_factor
avg_pnl_per_trade
median_pnl_per_trade
max_drawdown
```

### Monthly performance

```text
strategy
month
trades
pnl
roi
max_drawdown
```

### Trader contribution

```text
strategy
wallet
copied_trades
pnl
roi
max_drawdown
first_copied_at
last_copied_at
```

### Sensitivity grid

Run multiple thresholds:

```text
min_resolved: 20, 30, 40, 60
mean_edge: 0.03, 0.05, 0.08, 0.10
edge_lcb: -0.02, 0.00, 0.02, 0.04
usd_weighted_edge: 0.03, 0.05, 0.08
```

The theory is credible only if nearby threshold settings also work.

If only one exact threshold works, it is probably overfit.

---

## What Would Prove The Theory?

The new edge gate is better if it shows:

```text
higher ROI than old gate
higher profit factor
lower max drawdown
similar or higher total PnL
performance spread across multiple wallets
performance across multiple months
performance survives stricter thresholds
performance survives nearby threshold variations
```

The main proof:

```text
Traders selected by price-adjusted edge outperform traders selected by raw win rate on future unseen trades.
```

---

## SQL Prototype For Backtest

Use this as a first SQL prototype. It compares old gate vs strict edge gate.

```sql
with params as (
  select
    interval '30 days' as train_window,
    interval '7 days' as test_window,
    40::int as min_resolved_markets,
    15::int as old_min_resolved_markets,
    0.75::numeric as old_min_win_rate,
    0.08::numeric as min_mean_edge,
    0.06::numeric as min_usd_weighted_edge,
    0.02::numeric as min_edge_lcb
),
calendar as (
  select generate_series(
    (select min(resolved_at)::date + interval '30 days' from candidate_trades where resolved_at is not null),
    (select max(trade_timestamp)::date - interval '7 days' from candidate_trades),
    interval '1 day'
  ) as asof_date
),
training_trades as (
  select
    c.asof_date,
    t.wallet,
    t.id,
    t.condition_id,
    t.market_slug,
    t.market_title,
    t.event_slug,
    t.price,
    t.usd_size,
    t.pnl_usd,
    t.status,
    t.resolved_at,
    t.trade_timestamp,
    case when t.status = 'resolved_win' then 1 else 0 end as outcome_value,
    case when t.status = 'resolved_win' then 1 else 0 end - t.price as edge
  from calendar c
  join candidate_trades t
    on t.side = 'BUY'
   and t.status in ('resolved_win', 'resolved_loss')
   and t.resolved_at < c.asof_date
   and t.resolved_at >= c.asof_date - (select train_window from params)
   and t.price is not null
   and t.price > 0
   and t.price < 1
),
deduped_training as (
  select *
  from (
    select
      *,
      row_number() over (
        partition by asof_date, wallet, coalesce(nullif(condition_id, ''), nullif(market_slug, ''), nullif(market_title, ''), id)
        order by resolved_at desc nulls last, trade_timestamp desc, id desc
      ) as rn
    from training_trades
  ) x
  where rn = 1
),
scores as (
  select
    asof_date,
    wallet,
    count(*)::int as n_resolved,
    count(*) filter (where status = 'resolved_win')::int as wins,
    avg(case when status = 'resolved_win' then 1 else 0 end)::numeric as win_rate,
    avg(price * 100)::numeric as avg_entry_price_cents,
    avg(edge)::numeric as mean_edge,
    stddev_samp(edge)::numeric as edge_stddev,
    case
      when count(*) >= 2 then avg(edge) - 1.64 * stddev_samp(edge) / sqrt(count(*))
      else null
    end as edge_lcb,
    sum(usd_size)::numeric as resolved_usd_volume,
    (sum(usd_size * edge) / nullif(sum(usd_size), 0))::numeric as usd_weighted_edge,
    count(distinct coalesce(nullif(event_slug, ''), nullif(market_slug, ''), 'unknown'))::int as distinct_events
  from deduped_training
  group by asof_date, wallet
),
selected_old_gate as (
  select
    asof_date,
    wallet,
    'old_gate' as strategy
  from scores
  where n_resolved >= (select old_min_resolved_markets from params)
    and win_rate >= (select old_min_win_rate from params)
    and avg_entry_price_cents < 75
),
selected_edge_gate as (
  select
    asof_date,
    wallet,
    'edge_gate_strict' as strategy
  from scores
  where n_resolved >= (select min_resolved_markets from params)
    and mean_edge >= (select min_mean_edge from params)
    and usd_weighted_edge >= (select min_usd_weighted_edge from params)
    and edge_lcb >= (select min_edge_lcb from params)
    and distinct_events >= 8
),
selected as (
  select * from selected_old_gate
  union all
  select * from selected_edge_gate
),
copied_trades_raw as (
  select
    s.strategy,
    s.asof_date,
    t.wallet,
    t.id as trade_id,
    t.trade_timestamp,
    t.resolved_at,
    t.condition_id,
    t.market_slug,
    t.event_slug,
    t.price,
    t.usd_size,
    t.shares,
    t.status,
    t.pnl_usd
  from selected s
  join candidate_trades t
    on t.wallet = s.wallet
   and t.side = 'BUY'
   and t.trade_timestamp >= s.asof_date
   and t.trade_timestamp < s.asof_date + (select test_window from params)
   and t.status in ('resolved_win', 'resolved_loss')
   and t.pnl_usd is not null
),
copied_trades_deduped as (
  select distinct on (strategy, trade_id)
    *
  from copied_trades_raw
  order by strategy, trade_id, asof_date asc
),
simulated_copy as (
  select
    *,
    10.0 as stake_usd,
    case
      when status = 'resolved_win' then 10.0 * ((1.0 - price) / nullif(price, 0))
      when status = 'resolved_loss' then -10.0
      else 0
    end as copied_pnl_usd
  from copied_trades_deduped
  where price > 0 and price < 1
)
select
  strategy,
  count(*) as copied_trade_count,
  count(distinct wallet) as copied_wallet_count,
  round(sum(copied_pnl_usd)::numeric, 2) as total_pnl_usd,
  round((sum(copied_pnl_usd) / nullif(count(*) * 10.0, 0) * 100)::numeric, 2) as roi_pct,
  round(avg(price * 100)::numeric, 2) as avg_entry_price_cents,
  round(avg(case when status = 'resolved_win' then 1 else 0 end)::numeric * 100, 2) as copied_win_rate_pct,
  round(avg(copied_pnl_usd)::numeric, 2) as avg_pnl_per_trade
from simulated_copy
group by strategy
order by total_pnl_usd desc;
```

---

## Recommended Implementation Plan For Local AI

### Phase 1: Add local backtest script only

Do not modify live gate yet.

Create:

```text
scripts/backtest-copy-gates.js
```

Add package script:

```json
"backtest:gates": "node scripts/backtest-copy-gates.js"
```

Script should:

1. Connect to `DATABASE_URL` using `pg`.
2. Query `candidate_trades`.
3. Run walk-forward backtest.
4. Compare:
   - `old_gate`
   - `edge_gate_loose`
   - `edge_gate_strict`
5. Output files:
   - `backtests/copy_gate_summary.json`
   - `backtests/copy_gate_equity.csv`
   - `backtests/copy_gate_trades.csv`
   - optionally `backtests/copy_gate_by_trader.csv`
   - optionally `backtests/copy_gate_by_month.csv`

### Phase 2: Add metrics to leaderboard, no behavior change

After backtest works, add these metrics to candidate leaderboard:

```text
meanEdge
edgeLowerBound
usdWeightedEdge
resolvedUsdVolume
roiPct
distinctEventCount
eliteScore
```

Do not change auto-copy yet.

### Phase 3: Add shadow tier

Add a non-trading tier:

```text
shadow_elite
```

This means:

```text
This wallet would be elite under the new gate, but we are only tracking it.
```

### Phase 4: Replace gate only if backtest proves it

Only replace current copy-pool eligibility if the walk-forward test shows the edge gate improves out-of-sample performance.

---

## Possible DB Migration Later

If we decide to store new metrics in `copy_pool_traders`, add:

```sql
alter table copy_pool_traders
add column if not exists mean_edge numeric,
add column if not exists edge_stddev numeric,
add column if not exists edge_lower_bound numeric,
add column if not exists usd_weighted_edge numeric,
add column if not exists resolved_usd_volume numeric,
add column if not exists roi_pct numeric,
add column if not exists profit_factor numeric,
add column if not exists distinct_event_count integer not null default 0,
add column if not exists max_event_exposure_pct numeric,
add column if not exists elite_score numeric,
add column if not exists copy_tier text not null default 'observe_only';
```

---

## Missing Data For Future Improvement

The current DB appears to have entry price and final resolution, which is enough for resolution-based edge.

But it likely does not yet store historical market prices after entry.

To detect timing skill, we need markouts:

```text
price_after_5m
price_after_30m
price_after_2h
price_before_resolution
```

Then calculate:

```text
markout_5m = price_after_5m - entry_price
markout_30m = price_after_30m - entry_price
markout_2h = price_after_2h - entry_price
```

This would help identify traders whose entries move in their favor shortly after they buy.

That is stronger evidence of skill than only final resolution.

But this is a future improvement. First backtest price-adjusted edge using existing resolved trades.

---

## Main Goal

We want to know:

```text
Would a price-adjusted edge gate have made more money than the current win-rate gate using our historical resolved trades?
```

Use a leakage-safe walk-forward backtest.

Do not use future outcomes when selecting traders.

Use `resolved_at < asof_date` for scoring.

Then simulate copying future trades and compare old gate vs edge gate.
