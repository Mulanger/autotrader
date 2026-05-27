# Real Copy Quality Scoring + Real Traders Tab Implementation Guide

This document is a handoff for the local AI agent that will implement the next version of the autotrader app.

## Goal

Add a new category/tab to the **Real trading control room** menu, similar to the demo-side `candidates` page, but focused on ranking the wallets that should be considered for real auto-copying.

The new real page should:

1. Backfill all currently copied / active candidate wallets, roughly 450 wallets at the time of writing.
2. Calculate a dedicated **Copy Quality Score** for each wallet.
3. Rank wallets by actual copyability, not just win rate.
4. Continue scoring every new wallet that enters the demo copy pool.
5. Help decide which wallets are safe enough to follow on the real trading side.

The main conceptual change: **a good trader is not always a good copy target**. The current real copier has max-entry, fixed-stake, source-price-guard, FOK, duplicate-prevention, and one-position-per-market behavior. The scoring system must rank traders based on how copyable their edge is under those constraints.

---

## Current repo context

Important files and current behavior:

- `README.md`
  - Demo starts with `$1,000` and uses `$10` copied BUY stake.
  - Demo max entry defaults to `75c`.
  - Real mode uses manual follows, fixed-stake FOK quote audits, strict source-price guard, max entry, one position per market, and duplicate source-trade prevention.

- `src/main.jsx`
  - `Topbar()` currently defines real tabs as:
    - `overview`
    - `following`
    - `positions`
    - `orders`
  - Demo tabs include:
    - `overview`
    - `shadow`
    - `profit`
    - `positions`
    - `traders`
    - `candidates`
  - `RealWorkspace()` currently renders:
    - `RealOverview`
    - `RealFollowingView`
    - `RealPositionsView`
    - `RealOrdersView`

- `server/real/routes.js`
  - Existing real API endpoints:
    - `GET /api/real/state`
    - `GET /api/real/orders`
    - `GET /api/real/positions`
    - `POST /api/real/follow`
    - `POST /api/real/unfollow`

- `server/candidate-tracker/storage.js`
  - Already has candidate tables:
    - `candidate_traders`
    - `candidate_trades`
    - `copy_pool_traders`
    - `copy_pool_events`
  - Existing leaderboard SQL already computes many fields needed for the new scoring layer:
    - `profit_usd`
    - `roi_pct`
    - `profit_factor`
    - `top_win_share_pct`
    - `avg_entry_price_cents_30d`
    - `median_entry_cents`
    - `avg_trade_size_usd`
    - `max_drawdown_usd`
    - recent 7d/14d win rates
    - distinct resolved market counts

- `server/copy-pool.js`
  - Current promotion/retention logic is still mostly based on:
    - minimum distinct resolved BUY markets
    - minimum win rate
  - This is not enough for real trading. It lets dangerous high-entry wallets through.

- `scripts/backtest-copy-gates.js`
  - Useful reference for better gates:
    - `meanEdge`
    - `usdWeightedEdge`
    - `edgeLowerBound`
    - `distinctEventCount`
    - `profitFactor`
    - `roiPct`
  - It already models the copy-side idea that BUY edge is not the same as raw win rate.

---

## New real menu category

Add a new tab in the Real dashboard menu.

Recommended tab key:

```js
'real-traders'
```

Recommended visible label:

```text
scored traders
```

Alternative visible labels:

```text
copy quality
ranked traders
real candidates
```

Implementation target in `src/main.jsx`:

```js
const tabs = mode === 'demo'
  ? ['overview', 'shadow', 'profit', 'positions', 'traders', 'candidates']
  : ['overview', 'following', 'real-traders', 'positions', 'orders'];
```

Then update `RealWorkspace()`:

```js
if (tab === 'real-traders') return <RealScoredTradersView />;
```

The new page should be distinct from `RealFollowingView`. `RealFollowingView` shows wallets already followed in real mode. `RealScoredTradersView` should show all eligible/scored candidate wallets and allow the operator to decide whether they should be added to real follows.

---

## Why the old metric is unsafe

The old selection rule was roughly:

```text
win_rate_30d >= 75%
and distinct winning/resolved BUY markets >= 15
```

This is not enough.

A wallet can have a 95% win rate by buying at 95c. That looks good historically, but it is dangerous for a copier:

```text
Buy at 95c:
Upside if right: about +5.3%
Downside if wrong: -100%
```

For real auto-copying, the app should strongly prefer wallets with:

- strong profit factor
- positive ROI
- meaningful sample size
- many distinct markets/events
- low drawdown relative to profit
- low dependence on one big win
- median entry prices that are realistically copyable
- positive conservative expected copy edge

The most important correction is to penalize or reject high median entry wallets.

---

## New metric: Copy Quality Score

Create a dedicated score, not a generic trader score.

Recommended name:

```text
copy_quality_score
```

The score should be 0 to 100.

It should be computed in two stages:

```text
1. Hard rejection / eligibility gates
2. Weighted score for survivors
```

Do not rely only on a weighted score. Hard gates are needed so statistically attractive but copy-hostile traders cannot slip into the real list.

---

## Stage 1: hard rejection gates

A wallet should be considered ineligible for real auto-copy ranking if it fails any of these baseline conditions:

```text
profit_usd_30d <= 0
profit_factor_30d < 1.25
distinct_resolved_markets_30d < 15
win_count_30d < 15
pnl_trade_count_30d < 25
median_entry_cents_30d > 90
top_win_share_pct_30d > 35
drawdown_to_profit_ratio > 0.80
```

For promotion to real follow candidates, use a stricter threshold:

```text
copy_quality_score >= 70
median_entry_cents_30d <= 82
profit_factor_30d >= 1.50
distinct_resolved_markets_30d >= 20
top_win_share_pct_30d <= 30
```

For watchlist/test-only candidates:

```text
copy_quality_score >= 60
median_entry_cents_30d <= 82
distinct_resolved_markets_30d >= 15
```

For automatic removal/downgrade from real consideration:

```text
copy_quality_score < 55
or median_entry_cents_30d > 90
or profit_factor_30d < 1.10
or drawdown_to_profit_ratio > 1.00
```

---

## Stage 2: Conservative Copy Edge

This should be the core metric.

Raw win rate is not enough. We need to estimate whether a copied BUY at the wallet's normal entry price still has positive expected value.

For a BUY trade:

```text
Expected copy ROI = win_rate / entry_price - 1
```

Example:

```text
win_rate = 80%
median_entry = 60c
expected_copy_roi = 0.80 / 0.60 - 1 = +33.3%
```

Bad high-entry example:

```text
win_rate = 94%
median_entry = 95c
expected_copy_roi = 0.94 / 0.95 - 1 = -1.1%
```

Use a Wilson lower-bound win rate so small samples do not get over-ranked.

```text
conservative_win_rate = WilsonLowerBound(win_count_30d, distinct_resolved_markets_30d)

conservative_copy_edge_pct =
  ((conservative_win_rate / (median_entry_cents_30d / 100)) - 1) * 100
```

This is the metric that protects the system from high-entry wallets.

Recommended Wilson z-score:

```text
z = 1.28
```

This is a moderate confidence penalty. If the app later becomes more conservative, use `z = 1.64`.

---

## Weighted score formula

Recommended formula:

```text
copy_quality_score =
  30% conservative_copy_edge_score
+ 20% entry_copyability_score
+ 15% sample_reliability_score
+ 12% risk_score
+ 10% profit_quality_score
+  8% profit_scale_score
+  5% concentration_score
```

### Component definitions

#### 1. conservative_copy_edge_score

Input:

```text
conservative_copy_edge_pct
```

Mapping:

```text
-5% or lower: 0.00
0%: around 0.20
+20% or higher: 1.00
```

Simple implementation:

```js
const conservativeCopyEdgeScore = clamp01((conservativeCopyEdgePct + 5) / 25);
```

#### 2. entry_copyability_score

Input:

```text
median_entry_cents_30d
```

Mapping:

```text
<= 65c: 1.00
65c to 75c: falls from 1.00 to 0.80
75c to 82c: falls from 0.80 to 0.45
82c to 90c: falls from 0.45 to 0.10
> 90c: 0.00 or hard reject
```

This is the most important protection layer for real copying.

#### 3. sample_reliability_score

Inputs:

```text
distinct_resolved_markets_30d
pnl_trade_count_30d
```

Example:

```js
sampleReliabilityScore =
  0.65 * clamp01(distinctResolvedMarkets30d / 80) +
  0.35 * clamp01(pnlTradeCount30d / 150);
```

#### 4. risk_score

Inputs:

```text
max_drawdown_usd_30d
profit_usd_30d
```

Derived:

```text
drawdown_to_profit_ratio = abs(max_drawdown_usd_30d) / profit_usd_30d
```

Example:

```js
riskScore = clamp01(1 - ((drawdownToProfitRatio - 0.05) / 0.70));
```

#### 5. profit_quality_score

Inputs:

```text
profit_factor_30d
roi_pct_30d
```

Example:

```js
profitFactorScore = clamp01(Math.log(Math.max(1, profitFactor30d)) / Math.log(5));
roiScore = clamp01(roiPct30d / 35);
profitQualityScore = 0.65 * profitFactorScore + 0.35 * roiScore;
```

#### 6. profit_scale_score

Input:

```text
profit_usd_30d
```

Use diminishing returns so large wallets do not dominate only because of scale.

Example:

```js
profitScaleScore = clamp01(Math.log1p(profitUsd30d) / Math.log1p(100000));
```

#### 7. concentration_score

Input:

```text
top_win_share_pct_30d
```

Penalize traders who made too much of their profit from one lucky market.

Example:

```js
concentrationScore = clamp01(1 - ((topWinSharePct30d - 8) / 27));
```

---

## Suggested JS scorer module

Create:

```text
server/copy-quality-score.js
```

Starter implementation:

```js
export function scoreCopyTrader(row) {
  const profit = Number(row.profit_usd_30d ?? row.profitUsd30d ?? row.profit_usd ?? 0);
  const roi = Number(row.roi_pct_30d ?? row.roiPct30d ?? row.roi_pct ?? 0);
  const profitFactor = Number(row.profit_factor_30d ?? row.profitFactor30d ?? row.profit_factor ?? 0);
  const maxDrawdown = Math.abs(Number(row.max_drawdown_usd_30d ?? row.maxDrawdownUsd30d ?? row.max_drawdown_usd ?? 0));
  const medianEntry = Number(row.median_entry_cents_30d ?? row.medianEntryCents30d ?? row.median_entry_cents ?? 0);
  const avgEntry = Number(row.avg_entry_price_cents_30d ?? row.avgEntryPriceCents30d ?? 0);
  const markets = Number(row.distinct_resolved_markets_30d ?? row.resolved_distinct_trade_count_30d ?? row.distinctResolvedMarkets30d ?? 0);
  const wins = Number(row.win_count_30d ?? row.win_count_distinct_30d ?? row.winCount30d ?? 0);
  const trades = Number(row.pnl_trade_count_30d ?? row.pnlTradeCount30d ?? row.pnl_trade_count ?? 0);
  const topWinShare = Number(row.top_win_share_pct_30d ?? row.topWinSharePct30d ?? row.top_win_share_pct ?? 100);

  const drawdownToProfitRatio = profit > 0 ? maxDrawdown / profit : Infinity;

  const hardReject =
    profit <= 0 ||
    profitFactor < 1.25 ||
    markets < 15 ||
    wins < 15 ||
    trades < 25 ||
    medianEntry > 90 ||
    topWinShare > 35 ||
    drawdownToProfitRatio > 0.8;

  if (hardReject) {
    return {
      eligible: false,
      copyQualityScore: 0,
      conservativeCopyEdgePct: null,
      conservativeWinRatePct: null,
      drawdownToProfitRatio: Number.isFinite(drawdownToProfitRatio) ? drawdownToProfitRatio : null,
      reason: buildRejectReason({
        profit,
        profitFactor,
        markets,
        wins,
        trades,
        medianEntry,
        topWinShare,
        drawdownToProfitRatio,
      }),
      flags: buildRiskFlags({
        medianEntry,
        avgEntry,
        topWinShare,
        drawdownToProfitRatio,
        profitFactor,
        markets,
        trades,
        conservativeCopyEdgePct: null,
      }),
    };
  }

  const conservativeWinRate = wilsonLowerBound(wins, markets, 1.28);
  const entryPrice = Math.max(0.05, medianEntry / 100);
  const conservativeCopyEdgePct = ((conservativeWinRate / entryPrice) - 1) * 100;

  const conservativeCopyEdgeScore = clamp01((conservativeCopyEdgePct + 5) / 25);
  const entryCopyabilityScore = scoreMedianEntry(medianEntry);
  const sampleReliabilityScore = 0.65 * clamp01(markets / 80) + 0.35 * clamp01(trades / 150);
  const riskScore = clamp01(1 - ((drawdownToProfitRatio - 0.05) / 0.70));
  const profitFactorScore = clamp01(Math.log(Math.max(1, profitFactor)) / Math.log(5));
  const roiScore = clamp01(roi / 35);
  const profitQualityScore = 0.65 * profitFactorScore + 0.35 * roiScore;
  const profitScaleScore = clamp01(Math.log1p(profit) / Math.log1p(100000));
  const concentrationScore = clamp01(1 - ((topWinShare - 8) / 27));

  const copyQualityScore = 100 * (
    0.30 * conservativeCopyEdgeScore +
    0.20 * entryCopyabilityScore +
    0.15 * sampleReliabilityScore +
    0.12 * riskScore +
    0.10 * profitQualityScore +
    0.08 * profitScaleScore +
    0.05 * concentrationScore
  );

  return {
    eligible: true,
    copyQualityScore,
    conservativeCopyEdgePct,
    conservativeWinRatePct: conservativeWinRate * 100,
    drawdownToProfitRatio,
    conservativeCopyEdgeScore,
    entryCopyabilityScore,
    sampleReliabilityScore,
    riskScore,
    profitQualityScore,
    profitScaleScore,
    concentrationScore,
    flags: buildRiskFlags({
      medianEntry,
      avgEntry,
      topWinShare,
      drawdownToProfitRatio,
      profitFactor,
      markets,
      trades,
      conservativeCopyEdgePct,
    }),
  };
}

export function scoreMedianEntry(medianEntry) {
  if (!Number.isFinite(medianEntry) || medianEntry <= 0) return 0;
  if (medianEntry <= 65) return 1.00;
  if (medianEntry <= 75) return lerp(1.00, 0.80, (medianEntry - 65) / 10);
  if (medianEntry <= 82) return lerp(0.80, 0.45, (medianEntry - 75) / 7);
  if (medianEntry <= 90) return lerp(0.45, 0.10, (medianEntry - 82) / 8);
  return 0;
}

export function wilsonLowerBound(wins, n, z = 1.28) {
  if (!n || n <= 0) return 0;
  const phat = wins / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) / n) + (z2 / (4 * n * n)));
  return (center - margin) / denominator;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function lerp(a, b, t) {
  return a + (b - a) * clamp01(t);
}

function buildRejectReason(metrics) {
  const reasons = [];
  if (metrics.profit <= 0) reasons.push('negative_or_zero_profit');
  if (metrics.profitFactor < 1.25) reasons.push('profit_factor_below_1_25');
  if (metrics.markets < 15) reasons.push('too_few_resolved_markets');
  if (metrics.wins < 15) reasons.push('too_few_winning_markets');
  if (metrics.trades < 25) reasons.push('too_few_pnl_trades');
  if (metrics.medianEntry > 90) reasons.push('median_entry_above_90c');
  if (metrics.topWinShare > 35) reasons.push('top_win_share_above_35_pct');
  if (metrics.drawdownToProfitRatio > 0.8) reasons.push('drawdown_too_large_relative_to_profit');
  return reasons.join(', ');
}

function buildRiskFlags(metrics) {
  const flags = [];
  if (metrics.medianEntry > 82) flags.push('execution_sensitive_high_median_entry');
  if (metrics.avgEntry > 82) flags.push('high_average_entry');
  if (metrics.topWinShare > 25) flags.push('concentrated_profit');
  if (metrics.drawdownToProfitRatio > 0.5) flags.push('large_drawdown_relative_to_profit');
  if (metrics.profitFactor < 1.75) flags.push('thin_profit_factor');
  if (metrics.markets < 25) flags.push('small_market_sample');
  if (metrics.trades < 35) flags.push('small_trade_sample');
  if (Number.isFinite(metrics.conservativeCopyEdgePct) && metrics.conservativeCopyEdgePct < 0) {
    flags.push('negative_conservative_copy_edge');
  }
  return flags;
}
```

---

## Persistence design

Add a new table for cached scores.

Migration target: `server/candidate-tracker/storage.js` or a new migration helper if the repo gets split later.

Recommended table:

```sql
create table if not exists real_copy_quality_scores (
  wallet text primary key,
  score numeric not null default 0,
  eligible boolean not null default false,
  tier text not null default 'ignore',
  reason text,
  flags jsonb not null default '[]'::jsonb,

  conservative_copy_edge_pct numeric,
  conservative_win_rate_pct numeric,
  drawdown_to_profit_ratio numeric,

  profit_usd_30d numeric,
  roi_pct_30d numeric,
  profit_factor_30d numeric,
  max_drawdown_usd_30d numeric,
  median_entry_cents_30d numeric,
  avg_entry_price_cents_30d numeric,
  distinct_resolved_markets_30d integer,
  pnl_trade_count_30d integer,
  win_count_30d integer,
  win_rate_pct_30d numeric,
  top_win_share_pct_30d numeric,

  payload jsonb not null default '{}'::jsonb,
  scored_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists real_copy_quality_scores_score_idx
  on real_copy_quality_scores (eligible, score desc);

create index if not exists real_copy_quality_scores_tier_idx
  on real_copy_quality_scores (tier, score desc);
```

Recommended tier logic:

```text
core: score >= 80 and eligible
candidate: score >= 70 and eligible
watchlist: score >= 60 and median_entry <= 82
manual_review: score >= 50
ignore: everything else
```

---

## Backfill requirement

When the feature is deployed, the app must backfill all current copied/active candidate wallets before the new real page is useful.

Sources of wallets to backfill:

1. Active `copy_pool_traders` where `status = 'active'`.
2. Baseline `WATCHED_WALLETS` from config.
3. Any wallets currently present in `state.watchedWallets` after restored durable state.
4. Optionally, all wallets in `candidate_traders` that have enough data.

The candidate tracker already seeds active copy pool wallets for longer history. Reuse that concept, but make the scoring feature explicit and observable.

Recommended behavior:

```text
On startup:
  - collect all active copy/demo pool wallets
  - ensure they are queued for backfill if they do not have recent full history
  - mark real scoring service status as backfilling/scoring
  - score wallets as soon as enough resolved data exists
  - update scores whenever new trades resolve
```

Backfill should not block the app from starting. It should run incrementally like the existing candidate backfill loop.

Add service status fields under `state.service.realCopyQuality` or similar:

```js
state.service.realCopyQuality = {
  enabled: true,
  status: 'starting',
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
```

---

## Ongoing scoring for new demo copy pool wallets

Every time a new wallet is added to the demo copy pool:

1. Ensure it exists in `candidate_traders`.
2. Queue it for backfill if needed.
3. Once enough resolved data exists, compute Copy Quality Score.
4. Add/update row in `real_copy_quality_scores`.
5. Show it on the new Real scored traders page.

Important: Do not automatically add new scored wallets to real follows unless the operator explicitly enables that behavior later. For now, this feature is ranking and decision support.

---

## API design

Add new real API endpoints. Use `requireConfiguredDashboardAuth` like existing real routes.

Recommended endpoints:

```text
GET /api/real/copy-quality
GET /api/real/copy-quality/:wallet
POST /api/real/copy-quality/recalculate
POST /api/real/copy-quality/:wallet/recalculate
```

### `GET /api/real/copy-quality`

Query params:

```text
limit: default 100, max 250
offset: default 0
q: optional wallet/display name search
tier: core|candidate|watchlist|manual_review|ignore|all
eligible: true|false|all
sort: score|profit|edge|entry|drawdown|updated
order: asc|desc
```

Response shape:

```js
{
  ok: true,
  summary: {
    total: 450,
    scored: 450,
    eligible: 38,
    core: 8,
    candidate: 17,
    watchlist: 31,
    manualReview: 44,
    ignore: 350,
    lastScoredAt: '...'
  },
  rows: [
    {
      wallet,
      displayName,
      pseudonym,
      profileImage,
      score,
      eligible,
      tier,
      reason,
      flags,
      conservativeCopyEdgePct,
      conservativeWinRatePct,
      drawdownToProfitRatio,
      profitUsd30d,
      roiPct30d,
      profitFactor30d,
      maxDrawdownUsd30d,
      medianEntryCents30d,
      avgEntryPriceCents30d,
      distinctResolvedMarkets30d,
      pnlTradeCount30d,
      winCount30d,
      winRatePct30d,
      topWinSharePct30d,
      scoredAt,
      realFollowStatus
    }
  ]
}
```

### `POST /api/real/copy-quality/recalculate`

Use this for manual dashboard refresh/re-score.

Body:

```js
{
  pin: '...',
  scope: 'active_copy_pool' // or 'all_candidates'
}
```

For the first version, this can be PIN-gated or dashboard-auth-gated only. Prefer PIN-gated if it can queue heavy backfills.

---

## UI design: RealScoredTradersView

Add a new React component in `src/main.jsx` initially, unless the frontend is split later.

The page should show:

### Header summary cards

- Scored wallets
- Eligible wallets
- Core candidates
- Watchlist
- Last scored time

### Main table/card list

Each row should include:

```text
Wallet/display name
Copy Quality Score
Tier
Conservative Copy Edge
Median Entry
Profit Factor
30d Profit
ROI
Win Rate
Markets / Trades
Max Drawdown
Top Win Share
Flags
Real follow status
Action button: Add to real follows / Already following / Remove if followed
```

### Filters

Minimum useful filters:

```text
Tier: all/core/candidate/watchlist/manual_review/ignore
Eligible only toggle
Search wallet
Sort dropdown
```

### Visual flag examples

```text
execution_sensitive_high_median_entry
concentrated_profit
large_drawdown_relative_to_profit
thin_profit_factor
small_market_sample
negative_conservative_copy_edge
```

### Row explanations

Each row should include a short reason/explanation field:

Good example:

```text
Strong copy edge, median entry 70.8c, profit factor 4.92, 85 resolved markets, low top-win concentration.
```

Rejected example:

```text
Rejected: median entry above 90c. High win rate is not enough because copied upside is too small.
```

---

## Recommended dashboard copy

Use language that makes the distinction clear:

```text
Copy Quality ranks wallets by how suitable they are for this copier, not by raw trader leaderboard performance.
```

```text
High-entry wallets may have excellent win rates but poor copy asymmetry. They are penalized or rejected when median entry is above the real copier's practical range.
```

---

## Implementation phases

### Phase 1 — Scoring module

- [ ] Add `server/copy-quality-score.js`.
- [ ] Add unit tests for:
  - Wilson lower bound
  - median entry score
  - hard reject logic
  - high win rate + high median entry rejection
  - low median entry + solid win rate promotion
  - top win concentration penalty

Important test case:

```text
94% win rate, 95c median entry should score poorly or be rejected.
80% win rate, 60c median entry should score well.
```

### Phase 2 — Persistence

- [ ] Add `real_copy_quality_scores` table migration.
- [ ] Add storage functions:
  - `saveRealCopyQualityScore(row)`
  - `getRealCopyQualityLeaderboard(params)`
  - `getRealCopyQualityScore(wallet)`
  - `markRealCopyQualityQueued(wallet)` if using an explicit queue

### Phase 3 — Metric SQL

- [ ] Build one SQL query that returns one row per wallet with the needed scoring inputs.
- [ ] Prefer 30d metrics for ranking.
- [ ] Use distinct market logic similar to existing candidate leaderboard.
- [ ] Make sure duplicate/repeat entries do not inflate market sample quality.
- [ ] Include median entry over recent BUY entries.
- [ ] Include drawdown curve from resolved PnL.
- [ ] Include top win share.

### Phase 4 — Backfill / scoring service

- [ ] Add a lightweight service that runs on startup after candidate storage is ready.
- [ ] Queue all active copy pool / watched wallets for backfill.
- [ ] Score wallets after backfill or when enough data exists.
- [ ] Re-score when new resolved trades are saved.
- [ ] Track service status in app state.

### Phase 5 — API

- [ ] Add `GET /api/real/copy-quality`.
- [ ] Add `GET /api/real/copy-quality/:wallet`.
- [ ] Add optional manual recalc endpoints.
- [ ] Reuse real route auth.

### Phase 6 — Frontend tab

- [ ] Add new real tab in `Topbar()`.
- [ ] Add `RealScoredTradersView`.
- [ ] Add fetch hook for `/api/real/copy-quality`.
- [ ] Add summary cards.
- [ ] Add ranked table/list.
- [ ] Add filters and sort.
- [ ] Add action button to follow/unfollow via existing real endpoints.

### Phase 7 — Acceptance checks

- [ ] The real menu shows the new tab.
- [ ] The page loads even while backfill is still running.
- [ ] The page shows scored wallets sorted by `copy_quality_score desc`.
- [ ] High median-entry wallets are not top-ranked even if win rate is very high.
- [ ] Existing followed wallets show their real follow status.
- [ ] New demo copy pool wallets eventually appear in the scored real list.
- [ ] Score explanation is visible enough to understand why a wallet was ranked or rejected.

---

## Final behavior target

The operator should be able to open the Real dashboard, click the new scored traders tab, and immediately answer:

```text
Which wallets are actually safe and copyable for real execution?
```

The top of the list should favor wallets with:

- copyable median entry prices
- positive conservative copy edge
- real 30d profit
- strong profit factor
- sufficient sample size
- low drawdown relative to profit
- low top-win concentration

The list should avoid or downgrade wallets with:

- median entry above 90c
- huge drawdown relative to profit
- low profit factor
- small samples
- one lucky win driving most of the profit
- negative conservative copy edge

This feature should become the real-trading equivalent of the demo candidate page, but with stricter scoring designed for actual copy execution.