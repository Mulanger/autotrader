# Polywhale Autotrader Strategy Upgrade Plan

This document is written for the local coding agent working on the `Mulanger/autotrader` repository.

The current project is a demo copy-trading workbench for Polymarket whale/candidate wallets. It tracks trades, auto-promotes candidate wallets, copies eligible BUY trades in demo mode, and waits for market resolution. Real-money execution is intentionally disabled and should remain disabled until the strategy layer, risk layer, and execution adapter are reviewed.

The goal of this document is to explain what should be improved in the trading strategy, why the current rules are not enough, and how to implement the next iteration in a controlled way.

---

## 1. Current Strategy Summary

Based on the current repository, the demo strategy roughly does this:

- Starts with demo capital.
- Uses a fixed demo stake per copied trade.
- Watches baseline wallets and auto-promoted candidate wallets.
- Copies BUY trades only.
- Skips SELL trades.
- Only copies trades at or below a configured max entry price, currently defaulting to 75c.
- Avoids repeated entries by source trade, market, and trader-market combination.
- Waits for official market resolution to settle demo positions.
- Candidate tracker filters for wallets making trades between `$1,000` and `$10,000`.
- Auto-copy pool promotion is mainly based on distinct resolved BUY markets, win rate, and average entry price.

This is a good scaffold, but it is not yet a strong profit-maximizing strategy.

The current selection logic is too close to:

> “Copy historically successful wallets if they win often and do not enter above 75c.”

The desired strategy should become:

> “Copy only when a specific wallet, category, market, price, timing, liquidity, and expected value all indicate positive copyable edge after fees, latency, spread, slippage, and risk limits.”

---

## 2. Core Problem With the Current Strategy

The largest weakness is that the current strategy relies too much on **win rate**.

Win rate alone is not expected value.

Example:

```text
Trader A:
- Buys 80c contracts
- Wins 75% of the time
- Expected value = 0.75 * $1.00 - $0.80 = -$0.05 before fees
- Looks good by win rate, but loses money long term

Trader B:
- Buys 20c contracts
- Wins 35% of the time
- Expected value = 0.35 * $1.00 - $0.20 = +$0.15 before fees
- Looks bad by win rate, but can be highly profitable
```

Therefore, the promotion system should not primarily ask:

```text
Does this wallet win often?
```

It should ask:

```text
Would copying this wallet at the actual price available to our bot have made money after fees, latency, spread, and slippage?
```

This is the central concept: **copyable expected value**.

---

## 3. Polymarket Liquidity, Spread, and Slippage

Polymarket is an order-book marketplace, not a fixed-price sportsbook.

That means the strategy must account for:

- Best bid
- Best ask
- Bid/ask spread
- Order book depth
- Available size at each price level
- Price impact
- Fill quality
- Latency between whale trade and bot entry

Even if the UI does not always use the word “slippage,” slippage exists mechanically because an order consumes available liquidity from the book.

Example:

```text
YES ask book:

100 shares at 42c
200 shares at 43c
500 shares at 45c
1000 shares at 48c
```

If the bot buys only `$10`, it may fill at 42c.

If the bot buys `$1,000`, it may consume multiple price levels and average 46c or worse.

The visible best ask was 42c, but the actual average fill became 46c. That is price impact / slippage.

This matters heavily for copy trading.

Example:

```text
Whale buys at 38c.
Bot sees the trade 3 seconds later.
Best ask is now 44c.
Only $25 is available at 44c.
Bot tries to buy $200.
Average fill becomes 47c.
```

The whale may have had edge at 38c. The bot may no longer have edge at 47c.

### Required Strategy Rule

Before copying any trade, the bot should fetch current market/order book data and calculate:

```text
best_bid
best_ask
spread_cents
available_depth_at_best_ask
available_depth_within_1c
available_depth_within_2c
estimated_average_fill_price
estimated_slippage_cents
estimated_price_chase_cents
```

Reject trades where:

```text
spread_cents > configured max spread
estimated_average_fill_price > whale_trade_price + max_price_chase_cents
estimated_slippage_cents > configured max slippage
available_depth_within_2c < intended stake
best_ask > max allowed entry price
```

Suggested starting defaults:

```text
MAX_SPREAD_CENTS=3
MAX_PRICE_CHASE_CENTS=2
MAX_SLIPPAGE_CENTS=1.5
MIN_DEPTH_WITHIN_2C_USD=stake_usd * 2
```

---

## 4. Replace Win-Rate Promotion With ROI / EV Promotion

Current auto-promotion should be upgraded from a win-rate system to an expected-value system.

### Current Candidate Promotion Inputs

The current system uses metrics similar to:

```text
distinctResolvedTradeCount
winCount
winRatePct
avgEntryPriceCents30d
avgEntryTradeCount30d
```

These are useful but insufficient.

### Add New Wallet Metrics

Implement these per wallet:

```text
realized_roi_pct = sum(pnl_usd) / sum(usd_size)
avg_profit_per_trade = sum(pnl_usd) / resolved_trade_count
median_profit_per_trade
profit_factor = gross_wins / abs(gross_losses)
max_drawdown_usd
largest_loss_usd
gross_win_usd
gross_loss_usd
resolved_trade_count
resolved_distinct_market_count
recent_7d_roi_pct
recent_14d_roi_pct
recent_30d_roi_pct
```

### Add Expected Value Metrics

For each resolved BUY trade:

```text
entry_price = price paid by trader
resolved_value = 1.00 if outcome won, else 0.00
edge_cents = resolved_value * 100 - entry_price_cents
```

At wallet level:

```text
avg_edge_cents
weighted_avg_edge_cents
edge_per_dollar
```

Weighted edge should weight larger trades more heavily, but cap extreme weights so one massive trade does not dominate the entire score.

### New Promotion Rule

Initial suggested rule:

```text
min_resolved_distinct_markets >= 30
realized_roi_pct >= 8
profit_factor >= 1.25
avg_edge_cents > 0
avg_entry_price_cents_30d <= 75
recent_14d_roi_pct is not sharply negative
```

Lower confidence tier:

```text
30-50 resolved distinct markets = tiny copy only
50-100 resolved distinct markets = normal copy
100+ resolved distinct markets + stable positive ROI = larger copy allowed
```

### Why This Matters

A trader can look good over 15 markets by luck. Raising the threshold and using ROI/profit factor reduces overfitting.

Win rate should remain visible in the dashboard, but it should not be the primary promotion signal.

---

## 5. Add Copyable ROI

Historical wallet ROI is not enough. We need **copyable ROI**.

A whale’s actual trade price is not necessarily the price our bot can get.

The bot should simulate what would have happened if it copied the wallet under realistic timing and liquidity assumptions.

### Add a Shadow Copy Table

Create a table such as:

```sql
create table if not exists shadow_copy_trades (
  id text primary key,
  source_trade_id text not null,
  wallet text not null,
  condition_id text,
  market_slug text,
  outcome text,
  side text not null,
  whale_trade_price_cents numeric,
  whale_trade_timestamp timestamptz,
  bot_seen_at timestamptz,
  simulated_delay_ms integer,
  best_bid_cents numeric,
  best_ask_cents numeric,
  spread_cents numeric,
  estimated_fill_price_cents numeric,
  estimated_slippage_cents numeric,
  estimated_price_chase_cents numeric,
  simulated_stake_usd numeric,
  simulated_shares numeric,
  simulated_fee_usd numeric,
  status text not null default 'open',
  payout_usd numeric,
  pnl_usd numeric,
  roi_pct numeric,
  resolved_at timestamptz,
  reject_reason text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### Simulate Multiple Copy Modes

For every observed candidate trade, simulate:

```text
copy_immediate
copy_after_5s
copy_after_15s
copy_after_30s
copy_only_if_no_price_chase
copy_only_if_spread_below_2c
copy_with_dynamic_sizing
copy_with_sell_exit_signal
```

This lets us compare which rules actually improve performance.

### Promotion Should Use Copyable ROI

A wallet should not be promoted because its own historical trades were profitable. It should be promoted because the bot’s simulated copied version was profitable.

Preferred metric:

```text
copyable_roi_pct = sum(shadow_copy_pnl_usd) / sum(shadow_copy_stake_usd)
```

Promotion rule should eventually become:

```text
copyable_resolved_count >= 30
copyable_roi_pct >= 5
copyable_profit_factor >= 1.2
copyable_max_drawdown_pct <= configured limit
```

---

## 6. Add Price-Chase Protection

Copy trading can fail when the market moves immediately after the whale entry.

Example:

```text
Whale entry: 42c
Bot current best ask: 50c
```

Blindly copying at 50c may destroy the edge.

### Required Rule

Before entering:

```text
price_chase_cents = current_best_ask_cents - whale_trade_price_cents
```

Reject if:

```text
price_chase_cents > MAX_PRICE_CHASE_CENTS
```

Suggested default:

```text
MAX_PRICE_CHASE_CENTS=2
```

For very high-scoring wallets, the system may allow 3c or 4c, but this should be explicitly controlled and backtested.

### Implementation Notes

Add config values:

```js
export const MAX_PRICE_CHASE_CENTS = Number(process.env.MAX_PRICE_CHASE_CENTS || 2);
export const MAX_SPREAD_CENTS = Number(process.env.MAX_SPREAD_CENTS || 3);
export const MAX_SLIPPAGE_CENTS = Number(process.env.MAX_SLIPPAGE_CENTS || 1.5);
```

The copy decision should include the reason if rejected:

```text
Skipped: current ask 50c is 8c above whale entry 42c
```

---

## 7. Add Liquidity Gate

For the current demo stake of `$10`, liquidity may not matter much. But if the strategy scales to larger stakes, it becomes essential.

### Required Liquidity Calculations

Given order book asks for the copied outcome:

```text
level price
level size
level notional_usd = price * size
```

Calculate:

```text
available_depth_at_best_ask_usd
available_depth_within_1c_usd
available_depth_within_2c_usd
average_fill_price_cents_for_stake
slippage_cents = average_fill_price_cents_for_stake - best_ask_cents
```

### Reject Conditions

```text
spread_cents > MAX_SPREAD_CENTS
available_depth_within_2c_usd < intended_stake_usd
average_fill_price_cents_for_stake > max_entry_price_cents
slippage_cents > MAX_SLIPPAGE_CENTS
```

### Required Output in Decision Log

Every copy decision should store:

```text
bestBidCents
bestAskCents
spreadCents
depthAtBestAskUsd
depthWithin1cUsd
depthWithin2cUsd
estimatedFillPriceCents
estimatedSlippageCents
liquidityDecision
liquidityRejectReason
```

This makes later strategy analysis possible.

---

## 8. Add Dynamic Position Sizing

The current fixed stake is safe but not optimal.

A better strategy uses confidence-based sizing.

### Suggested Score Components

```text
wallet_copyable_roi_score
wallet_sample_size_score
wallet_recent_form_score
wallet_category_edge_score
market_liquidity_score
price_chase_score
spread_score
market_quality_score
```

Combine them:

```text
trade_confidence_score =
  wallet_copyable_roi_score
  * wallet_sample_size_score
  * wallet_recent_form_score
  * wallet_category_edge_score
  * market_liquidity_score
  * price_chase_score
  * spread_score
  * market_quality_score
```

### Suggested Stake Tiers

```text
score < 0.50: skip
0.50-0.65: $10
0.65-0.80: $25
0.80-0.90: $50
0.90+: $100, subject to exposure limits
```

### Exposure Limits

Add hard caps:

```text
max 5% bankroll per market
max 15% bankroll per wallet
max 25% bankroll per category
max 40% bankroll total open exposure
max 10 open positions per wallet
max 3 active positions in highly correlated markets
```

### Why This Matters

A bot should not stake the same amount on:

- A newly promoted wallet with 30 trades.
- A proven wallet with 150 copyable resolved trades.
- A liquid market with tight spread.
- A thin market with poor depth.

Fixed sizing ignores risk quality.

---

## 9. Use SELL Trades as Exit Signals

The current demo engine skips SELL trades and waits for official resolution.

This is acceptable for a basic demo, but weak for profit optimization.

SELL trades from copied wallets can signal:

- Taking profit.
- Thesis changed.
- Risk reduction.
- Market rotation.
- Exit before negative information.

### Do Not Blindly Mirror Every SELL

Instead, record SELLs as exit signals and test whether acting on them improves ROI.

### Suggested Exit Rules to Simulate

```text
If copied wallet sells same market/outcome:
  mark position exit_signal_seen

If copied wallet sells >50% of estimated position:
  simulate selling 50% of our position

If copied wallet fully exits:
  simulate full exit

If two or more high-score wallets sell same side:
  simulate full exit

If position is in profit and copied wallet sells:
  simulate trailing stop or partial exit
```

### Required New Fields on Demo Positions

```text
exitSignalSeen
exitSignalAt
exitSignalWallet
exitSignalSourceTradeId
exitSignalPriceCents
simulatedExitPriceCents
simulatedExitPnlUsd
```

### Important

Keep the first implementation in demo/shadow mode only. Do not use this for live execution until backtests prove it improves results.

---

## 10. Add Category-Specific Wallet Edges

A trader may be good in one category and bad in another.

Examples:

```text
Wallet A: strong in crypto, weak in sports
Wallet B: strong in politics, weak in culture
Wallet C: good in short-term markets, poor in long-dated markets
```

The current strategy should not treat a wallet as globally good.

### Add Per-Category Metrics

For each wallet/category:

```text
resolved_trade_count
resolved_distinct_market_count
win_rate_pct
realized_roi_pct
profit_factor
avg_entry_price_cents
avg_edge_cents
copyable_roi_pct
copyable_profit_factor
recent_30d_roi_pct
```

### Copy Rule

Only copy a wallet in a category if:

```text
wallet_category_resolved_count >= configured minimum
wallet_category_roi_pct > 0
wallet_category_profit_factor > 1
```

If category data is insufficient, allow only tiny stake or skip.

---

## 11. Add Market Quality Filters

Some Polymarket markets are structurally worse for copy trading.

The bot should penalize or reject:

```text
ambiguous resolution criteria
very thin markets
markets with very low total volume
markets with very wide spread
markets with very long time to resolution
markets that already moved sharply after whale trade
markets near resolution with poor liquidity
markets where the title/rules suggest subjective interpretation
```

### Required Market Features

Collect and store:

```text
market_volume
market_liquidity
market_category
market_end_date
time_to_resolution_hours
is_near_resolution
has_clear_resolution_source
spread_cents
order_book_depth
```

### Market Quality Score

Create:

```text
market_quality_score = 0.0 to 1.0
```

Example scoring:

```text
+ tight spread
+ strong volume
+ clear category
+ clear resolution criteria
+ enough time remaining
- low liquidity
- ambiguous title
- long-dated low-volume market
- near-resolution but poor depth
```

Use this score in dynamic sizing and skip rules.

---

## 12. Add Consensus Scaling

The current strategy avoids copying a market more than once. This is safe but throws away useful signal.

A better method:

```text
First strong wallet buys side: small entry
Second independent strong wallet confirms: add
Third independent strong wallet confirms: add again
Strong wallet buys opposite side: freeze or reduce
```

### Consensus Signal

For each market/outcome:

```text
signal_score = sum(wallet_weight * side_signal * recency_decay)
```

Where:

```text
wallet_weight = wallet copyable ROI / reliability score
side_signal = +1 for target outcome, -1 for opposite outcome
recency_decay = lower weight as trade gets older
```

### Entry Logic

```text
signal_score < threshold: skip
signal_score >= threshold_1: small entry
signal_score >= threshold_2: add position
signal_score >= threshold_3: max allowed position
```

### Why This Matters

One wallet can be wrong. Multiple independent profitable wallets entering the same side is stronger information.

---

## 13. Add Strategy Analytics Dashboard

The dashboard should answer whether the strategy actually works.

Add panels or endpoints for:

```text
copyable ROI by wallet
copyable ROI by category
copyable ROI by market type
latency cost
price chase cost
spread cost
slippage cost
fees paid
skipped trade analysis
best filters by backtest
worst wallets after copying
best wallets after copying
open exposure by wallet/category/market
```

### Skipped Trade Analysis

Every skipped trade should be stored with reason:

```text
skip_reason = price_chase | wide_spread | low_depth | bad_category | low_wallet_score | duplicate | max_exposure | cash_limit | unsupported_side
```

Then compare:

```text
Did skipped trades lose money?
Did copied trades make money?
Which skip filter saved the most losses?
Which skip filter rejected too many winners?
```

This is how the strategy improves scientifically instead of by guessing.

---

## 14. Backtesting / Validation Requirements

Before live execution, run shadow backtests comparing strategies.

### Baselines

Compare against:

```text
Baseline A: copy every eligible watched BUY under 75c
Baseline B: current strategy
Baseline C: ROI-based wallet promotion
Baseline D: ROI + price-chase filter
Baseline E: ROI + price-chase + liquidity filter
Baseline F: ROI + liquidity + dynamic sizing
Baseline G: consensus scaling
Baseline H: SELL-exit strategy
```

### Metrics

Track:

```text
total_pnl_usd
roi_pct
max_drawdown_usd
max_drawdown_pct
profit_factor
win_rate_pct
avg_profit_per_trade
median_profit_per_trade
copy_count
skip_count
avg_entry_price_cents
avg_exit_or_resolution_value
category_pnl
wallet_pnl
latency_cost_cents
slippage_cost_cents
fee_cost_usd
```

### Promotion Gate

Do not enable real execution unless the best strategy beats the current strategy on:

```text
higher ROI
higher profit factor
lower drawdown
stable performance across multiple categories
acceptable sample size
positive results after fees and realistic fill assumptions
```

---

## 15. Suggested Implementation Phases

## Phase 1 — Add Metrics, No Trading Behavior Change

Goal: collect better data without changing copy decisions.

Tasks:

- [ ] Add wallet ROI metrics to candidate storage queries.
- [ ] Add profit factor.
- [ ] Add gross win and gross loss.
- [ ] Add average/median PnL per resolved trade.
- [ ] Add max drawdown calculation.
- [ ] Add category-level metrics.
- [ ] Add these metrics to `/api/candidates/leaderboard`.
- [ ] Update dashboard to display ROI and profit factor next to win rate.
- [ ] Keep existing copy rules unchanged during this phase.

Acceptance criteria:

- [ ] Existing tests pass.
- [ ] Candidate leaderboard still loads.
- [ ] Win rate is no longer the only visible performance metric.
- [ ] ROI/profit factor are visible and sortable.

---

## Phase 2 — Add Shadow Copy Simulation

Goal: estimate whether the bot could actually copy profitably.

Tasks:

- [ ] Add `shadow_copy_trades` table.
- [ ] Record a shadow copy row for every observed eligible candidate trade.
- [ ] Store whale entry price, bot seen time, simulated entry price, and delay mode.
- [ ] Resolve shadow copy rows when market resolves.
- [ ] Calculate copyable PnL and copyable ROI.
- [ ] Add API endpoint for shadow copy stats by wallet.
- [ ] Add dashboard section for copyable ROI.

Acceptance criteria:

- [ ] Shadow rows are created without affecting demo positions.
- [ ] Shadow rows resolve correctly.
- [ ] Copyable ROI can be calculated per wallet.
- [ ] Current copy behavior remains unchanged.

---

## Phase 3 — Add Price-Chase Filter

Goal: prevent copying trades after the market has already moved too far.

Tasks:

- [ ] Add config: `MAX_PRICE_CHASE_CENTS`.
- [ ] Capture whale trade price.
- [ ] Fetch or estimate current best ask before copying.
- [ ] Calculate `price_chase_cents`.
- [ ] Reject if chase exceeds threshold.
- [ ] Store rejection reason in decision log.
- [ ] Add test cases for accepted and rejected trades.

Acceptance criteria:

- [ ] Trades within chase limit can still copy.
- [ ] Trades above chase limit are skipped with clear reason.
- [ ] Dashboard shows price-chase skip reason.

---

## Phase 4 — Add Order Book Liquidity Gate

Goal: prevent entries with bad spread/depth/slippage.

Tasks:

- [ ] Add Polymarket order book client.
- [ ] Fetch order book for token/outcome before copy.
- [ ] Calculate best bid, best ask, spread, and depth.
- [ ] Estimate average fill price for intended stake.
- [ ] Add config: `MAX_SPREAD_CENTS`, `MAX_SLIPPAGE_CENTS`, `MIN_DEPTH_MULTIPLIER`.
- [ ] Reject poor-liquidity entries.
- [ ] Store liquidity metrics in copy decision.
- [ ] Add unit tests for fill price calculation.

Acceptance criteria:

- [ ] Copy decision includes liquidity metrics.
- [ ] Thin markets are skipped.
- [ ] Wide-spread markets are skipped.
- [ ] Estimated fill price respects available depth.

---

## Phase 5 — Upgrade Auto-Copy Pool Promotion

Goal: promote wallets based on ROI/EV/copyable performance instead of raw win rate.

Tasks:

- [ ] Add new promotion thresholds.
- [ ] Use realized ROI and profit factor.
- [ ] Use copyable ROI once shadow data is mature.
- [ ] Add sample-size tiers.
- [ ] Add category-specific eligibility.
- [ ] Keep protected baseline wallets active unless manually changed.
- [ ] Add reason strings explaining promotion/removal.

Acceptance criteria:

- [ ] Wallets are not promoted only because of high win rate.
- [ ] Wallets with negative ROI are not promoted.
- [ ] Wallets with insufficient sample size are watch-only or tiny-copy.
- [ ] Auto-copy reasons are clear in dashboard/API.

---

## Phase 6 — Add Dynamic Position Sizing

Goal: scale stake according to confidence and risk.

Tasks:

- [ ] Add bankroll/exposure model.
- [ ] Add confidence scoring function.
- [ ] Add stake tiers.
- [ ] Add per-wallet exposure cap.
- [ ] Add per-market exposure cap.
- [ ] Add per-category exposure cap.
- [ ] Add total open exposure cap.
- [ ] Add tests for cap enforcement.

Acceptance criteria:

- [ ] Low-confidence trades are skipped or tiny-sized.
- [ ] High-confidence trades can receive larger demo stake.
- [ ] Exposure caps cannot be exceeded.
- [ ] Decision log explains stake size.

---

## Phase 7 — Add SELL Exit Simulation

Goal: test whether following whale exits improves ROI.

Tasks:

- [ ] Track SELL trades from copied wallets.
- [ ] Match SELLs to open demo/shadow positions.
- [ ] Add exit signal fields.
- [ ] Simulate partial exit.
- [ ] Simulate full exit.
- [ ] Compare hold-to-resolution vs sell-following.
- [ ] Add dashboard metrics for exit strategy.

Acceptance criteria:

- [ ] SELLs do not trigger real execution.
- [ ] SELLs are recorded as signals.
- [ ] Shadow simulations show whether SELL-following improves results.

---

## Phase 8 — Strategy Report

Goal: make strategy performance auditable.

Tasks:

- [ ] Add `/api/strategy/summary`.
- [ ] Add `/api/strategy/wallets`.
- [ ] Add `/api/strategy/categories`.
- [ ] Add `/api/strategy/filters`.
- [ ] Add dashboard strategy tab.
- [ ] Show copied vs skipped trade outcomes.
- [ ] Show best/worst filters.
- [ ] Show latency/slippage/fee impact.

Acceptance criteria:

- [ ] User can see exactly why the strategy made or lost money.
- [ ] User can compare strategy variants.
- [ ] User can identify which filters improve profit.

---

## 16. Suggested File/Code Areas To Modify

Likely relevant files:

```text
server/config.js
server/demo-engine.js
server/copy-pool.js
server/candidate-tracker/service.js
server/candidate-tracker/storage.js
server/candidate-tracker/normalizer.js
server/fee-model.js
server/polymarket-client.js
server/stream-service.js
src/* dashboard components
```

Potential new files:

```text
server/orderbook-client.js
server/liquidity-gate.js
server/strategy-score.js
server/shadow-copy.js
server/risk-engine.js
server/exit-signal-engine.js
server/strategy-report.js
```

Potential tests:

```text
tests/liquidity-gate.test.js
tests/strategy-score.test.js
tests/shadow-copy.test.js
tests/risk-engine.test.js
tests/copy-pool-roi.test.js
tests/exit-signal-engine.test.js
```

---

## 17. Implementation Principles

Follow these principles:

1. Do not enable real-money trading yet.
2. Do not store private keys in this app.
3. Add metrics first, then strategy changes.
4. Keep demo/shadow modes separate from live execution.
5. Store every decision and rejection reason.
6. Prefer explicit config values over hardcoded thresholds.
7. Make every strategy rule testable.
8. Build dashboards that explain the strategy rather than hiding logic.
9. Avoid optimizing only for win rate.
10. Promote wallets based on copyable ROI after realistic costs.

---

## 18. Minimum Viable Upgrade

If time is limited, implement these first:

- [ ] ROI and profit factor per wallet.
- [ ] Copyable ROI shadow table.
- [ ] Price-chase filter.
- [ ] Order book liquidity gate.
- [ ] Skip reason tracking.
- [ ] Strategy summary endpoint.

These six changes will make the bot significantly more realistic than the current version.

---

## 19. Final Target Strategy

The final strategy should behave like this:

```text
1. Observe large candidate trades.
2. Backfill wallet history.
3. Score wallets by realized ROI, profit factor, category edge, and copyable ROI.
4. When a watched wallet buys:
   - check wallet score
   - check category score
   - check market quality
   - check current order book
   - check price chase
   - check spread/depth/slippage
   - check exposure caps
5. If all checks pass, copy with dynamic stake.
6. If checks fail, log skip reason.
7. Track SELLs as exit signals.
8. Resolve positions and compare copied vs skipped outcomes.
9. Continuously update wallet/category/filter performance.
10. Only consider live execution after the demo proves positive EV after realistic costs.
```

This moves the project from a simple whale copier to a measurable expected-value trading system.
