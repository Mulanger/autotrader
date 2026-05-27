# Candidate Leaderboard Metrics Implementation Guide

This document is a handoff for coding agents working on the Polywhale Autotrader candidate leaderboard.

The goal is to improve the candidate cards and expanded details so the app can better answer:

> Is this trader actually copyable and likely repeatable, or are they just lucky/noisy?

The current dashboard already shows useful basics: profit, P/L trade count, win rate, AEP, 30D eligibility, distinct resolved markets versus minimum requirement, and a compact recent result strip. This guide defines additional metrics that fit the project goal of finding wallets worth demo-copying and eventually auto-promoting into a safer copy pool.

## Product Context

The app is currently a demo-only copy-trading workbench. It uses candidate tracking to find Polymarket wallets in the target profit band and evaluates them for copy-trading suitability.

Important current assumptions:

- Demo account starts with `$1,000`.
- Demo copy size is `$10` per copied buy.
- Copy logic only copies watched BUY trades priced at or below the configured max entry price.
- Repeat-entry protection avoids copying multiple entries from the same wallet on the same market.
- Candidate tracking focuses on wallets in the configured profit band.
- Auto-copy promotion/retention currently depends mainly on resolved distinct BUY markets and win-rate thresholds.
- AEP is useful for display, but should not be the only safety metric.

The new metrics should help distinguish durable, copyable traders from traders with misleading profit, lucky single wins, poor risk/reward, or unstable recent performance.

## Recommended Visible Card Metrics

Keep the mobile card compact. The visible card should not become a dense analytics table.

Recommended compact card fields:

```text
Trades
127

WR / PF
66.1% / 1.72x

AEP / Med
48.5c / 44.0c

ROI / DD
+38.4% / -18.2%
```

The most valuable additions for the compact card are:

1. Profit factor
2. Max drawdown
3. ROI
4. Median entry price

These should be prioritized before adding lower-priority details.

## Recommended Expanded Metrics

The expanded trader view can include more diagnostic detail:

- Average trade size
- Median entry price
- Average win and average loss
- 7D and 14D performance
- Market-category concentration
- Largest-win dependency / top-win share
- Copyability score breakdown
- Recent activity count
- Days since last qualifying trade

## Metric Definitions

### 1. ROI / Return on Deployed Capital

Purpose: prevent the leaderboard from overvaluing wallets that made large absolute profit only because they deployed huge capital.

Suggested label:

```text
ROI
+38.4%
```

Definition:

```text
roi_pct = realized_profit_usd / deployed_capital_usd * 100
```

Where `deployed_capital_usd` should ideally mean the total amount spent on resolved BUY positions included in the candidate evaluation window.

Implementation notes:

- Use resolved trades only for the first version.
- If deployed capital is unavailable or zero, return `null` and display `—`.
- ROI should be shown with one decimal place.
- Consider wins/losses only for markets that have resolved enough data to calculate P/L reliably.

Priority: high.

### 2. Profit Factor

Purpose: capture risk/reward quality better than win rate.

Suggested label:

```text
PF
1.72x
```

Definition:

```text
profit_factor = gross_winning_pnl_usd / abs(gross_losing_pnl_usd)
```

Rules:

- `gross_winning_pnl_usd` is the sum of positive realized P/L.
- `gross_losing_pnl_usd` is the sum of negative realized P/L.
- If there are wins but no losses, return a capped value or `Infinity` internally, but display something like `>5.0x`.
- If there are no wins or no resolved P/L, display `—`.

Why it matters:

A trader can have a good win rate but still be poor if losses are much larger than wins. Profit factor catches this.

Priority: very high.

### 3. Max Drawdown

Purpose: estimate whether the path to the trader's profit was survivable.

Suggested label:

```text
Max DD
-18.2%
```

or, if percentage equity curve is not available:

```text
Max DD
-$2.4k
```

Preferred definition:

```text
max_drawdown_pct = largest peak-to-trough decline in cumulative realized P/L equity curve
```

Implementation approach:

1. Sort resolved P/L events by market resolution time or best available close timestamp.
2. Build a cumulative P/L curve.
3. Track each new peak.
4. For each subsequent point, calculate drawdown from the peak.
5. Store the worst drawdown.

If no starting equity or deployed capital basis is available, start with dollar drawdown. Add percentage drawdown later when a stable capital basis exists.

Why it matters:

A wallet with high profit and high win rate can still be unsuitable for auto-copying if it suffered large drawdowns.

Priority: very high.

### 4. Median Entry Price

Purpose: make AEP more robust. Average entry price can be distorted by a few extreme trades.

Suggested label:

```text
AEP / Med
48.5c / 44.0c
```

Definition:

```text
median_entry_price_cents = median(entry_price_cents for evaluated BUY trades)
```

Implementation notes:

- Use BUY trades only.
- Use trades in the same evaluation window as the current leaderboard row.
- Display with one decimal place, suffixed with `c`.
- Keep AEP, but pair it with median entry price.

Why it matters:

If AEP is much higher than median entry, the trader may occasionally chase expensive positions. That can be a copy-risk signal.

Priority: high.

### 5. Average Trade Size

Purpose: determine whether the trader's strategy is compatible with the app's fixed demo copy size.

Suggested label:

```text
Avg size
$420
```

Definition:

```text
avg_trade_size_usd = mean(abs(trade_size_usd) for evaluated trades)
```

Implementation notes:

- Prefer BUY trade notional size.
- If the data contains shares and price, calculate `shares * price`.
- Display as compact dollars: `$420`, `$1.2k`, etc.

Why it matters:

A whale may be profitable partly because of sizing, liquidity access, or market impact. A fixed `$10` copy strategy may not behave the same.

Priority: medium.

### 6. Average Win vs Average Loss

Purpose: make payoff structure visible and intuitive.

Suggested label:

```text
Avg W/L
+$82 / -$54
```

Definition:

```text
avg_win_usd = mean(pnl_usd where pnl_usd > 0)
avg_loss_usd = mean(pnl_usd where pnl_usd < 0)
```

Implementation notes:

- Use resolved P/L only.
- Display as compact signed dollars.
- If either side is missing, display `—` for that side.

Why it matters:

Win rate alone is incomplete. A 60% win rate with small wins and huge losses is not attractive.

Priority: medium.

### 7. Recent 7D / 14D Performance

Purpose: detect whether the trader is currently active and whether recent edge has cooled off.

Suggested labels:

```text
7D WR
75%
```

or:

```text
7D
+12 trades · 75% WR
```

Definitions:

```text
recent_7d_trade_count = count(evaluated resolved trades in last 7 days)
recent_7d_win_rate_pct = wins_7d / resolved_trades_7d * 100

recent_14d_trade_count = count(evaluated resolved trades in last 14 days)
recent_14d_win_rate_pct = wins_14d / resolved_trades_14d * 100
```

Implementation notes:

- If market resolution lags make 7D resolved data too sparse, use recent observed activity separately from recent resolved performance.
- Consider showing both `Recent activity` and `Recent resolved WR` in expanded details.
- Avoid over-penalizing traders when the sample is too small.

Priority: high for expanded view, medium for compact card.

### 8. Market-Category Concentration

Purpose: identify specialists versus broad traders.

Suggested label:

```text
Top cat.
Crypto 71%
```

Definition:

```text
top_category_share_pct = trades_in_top_category / evaluated_trades * 100
```

Implementation notes:

- Use Gamma market metadata where available.
- Store both top category name and share percentage.
- If category data is missing, display `Unknown` or `—`.
- This should start as an expanded-view metric.

Why it matters:

A trader may be excellent only in crypto, politics, sports, or another niche. Later, the app can use category-specific copy rules.

Priority: medium.

### 9. Largest-Win Dependency / Top-Win Share

Purpose: detect one-hit wonders.

Suggested label:

```text
Top win share
34%
```

Definition:

```text
top_win_share_pct = largest_single_trade_profit_usd / total_positive_profit_usd * 100
```

Alternative stricter version:

```text
top_profit_share_pct = largest_single_trade_profit_usd / total_realized_profit_usd * 100
```

Recommended first version: use share of total positive profit, because it is less unstable when total net profit is small.

Implementation notes:

- Use resolved positive P/L events only.
- If no positive P/L exists, display `—`.
- High values should reduce copyability score.

Why it matters:

A trader with `$120k` profit where `$90k` came from one trade is less attractive than one who built profit steadily.

Priority: high for expanded view, medium for compact card.

### 10. Copyability Score

Purpose: provide one sortable derived score that summarizes whether a wallet is attractive for demo-copying.

Suggested label:

```text
Copy score
82
```

The score should not replace raw metrics. It should summarize them.

Recommended first scoring components:

```text
copy_score =
  win_rate_component
+ distinct_markets_component
+ profit_factor_component
+ roi_component
+ recent_activity_component
- max_drawdown_penalty
- top_win_concentration_penalty
- high_entry_price_penalty
```

Suggested initial weights:

```text
Win rate:                20 points
Distinct markets:        20 points
Profit factor:           20 points
ROI:                     10 points
Recent activity:         10 points
Max drawdown penalty:   -10 points
Top-win penalty:        -10 points
High entry penalty:     -10 points
```

Normalize final output to `0..100`.

Implementation notes:

- Keep the score explainable. Expanded view should show the component breakdown.
- Do not use the score as an auto-copy hard gate until it has been backtested.
- The first version can be display-only.

Priority: medium-high, after raw metrics are reliable.

## Suggested Data Shape

Candidate leaderboard rows can add a nested `metrics` object rather than flattening every field.

Example:

```json
{
  "wallet": "0x3fd9...1ef0",
  "name": "therighteousdog",
  "profitUsd": 123100,
  "tradeCount": 127,
  "winRatePct": 66.1,
  "aepCents": 48.5,
  "distinctResolvedBuyMarkets": 59,
  "eligible30d": false,
  "metrics": {
    "roiPct": 38.4,
    "profitFactor": 1.72,
    "maxDrawdownUsd": -2400,
    "maxDrawdownPct": null,
    "medianEntryCents": 44.0,
    "avgTradeSizeUsd": 420,
    "avgWinUsd": 82,
    "avgLossUsd": -54,
    "recent7dTradeCount": 12,
    "recent7dWinRatePct": 75.0,
    "recent14dTradeCount": 28,
    "recent14dWinRatePct": 67.9,
    "topCategory": "Crypto",
    "topCategorySharePct": 71.0,
    "topWinSharePct": 34.0,
    "copyScore": 82
  }
}
```

Use `null` for unavailable metrics. The frontend should display `—` for null values.

## UI Guidance

### Compact Card

Recommended final compact card:

```text
P/L trades
127

WR / PF
66.1% / 1.72x

AEP / Med
48.5c / 44.0c

ROI / DD
+38.4% / -18.2%
```

Alternative if the card becomes too dense:

```text
Trades
127

WR
66.1%

PF
1.72x

DD
-18.2%
```

### Expanded View

Expanded details should include:

```text
ROI: +38.4%
Profit factor: 1.72x
Max drawdown: -18.2% / -$2.4k
Average trade size: $420
Average win/loss: +$82 / -$54
Median entry: 44.0c
7D: 12 trades, 75.0% WR
14D: 28 trades, 67.9% WR
Top category: Crypto, 71%
Top win share: 34%
Copy score: 82 / 100
```

### Visual Treatment

- Keep green/red recent result strip as-is.
- Add risk metrics in neutral text unless they cross thresholds.
- Consider subtle warning badges for:
  - `Top win share > 50%`
  - `Max drawdown worse than -30%`
  - `Profit factor < 1.2x`
  - `Recent 14D trade count < 5`
  - `Median entry price > configured max entry price`

## Sorting and Filtering Ideas

Add optional sorting by:

- Copy score
- Profit factor
- ROI
- Max drawdown
- Recent 14D win rate
- Top-win share ascending
- Average trade size

Add optional filters:

- Minimum profit factor
- Maximum drawdown
- Minimum recent activity
- Maximum top-win share
- Category
- Minimum ROI

Do not remove the existing eligibility logic. These filters should complement it.

## Backtesting Requirements Before Auto-Copy Use

Before any new metric affects real promotion/removal logic, run a backtest.

Recommended checks:

- Compare current promotion rules versus rules with profit factor and max drawdown.
- Test whether high copy score predicts better future 7D/14D performance.
- Test whether high top-win share predicts weaker future performance.
- Test whether low median entry improves copied-trade outcomes.
- Verify that stricter rules do not leave the copy pool empty.

Initial implementation should be display-only unless explicitly approved.

## Implementation Phases

### Phase 1: Raw Metric Calculation

- [ ] Add ROI.
- [ ] Add profit factor.
- [ ] Add max drawdown in dollars.
- [ ] Add median entry price.
- [ ] Add average trade size.
- [ ] Add average win/loss.
- [ ] Return all fields under `metrics` on candidate leaderboard rows.
- [ ] Use `null` for unavailable metrics.

### Phase 2: Frontend Display

- [ ] Update compact candidate card with `WR / PF`, `AEP / Med`, and `ROI / DD`.
- [ ] Add expanded details for all Phase 1 metrics.
- [ ] Add formatting helpers for percentage, cents, dollars, multiples, and null display.
- [ ] Keep card readable on mobile.

### Phase 3: Recent and Concentration Metrics

- [ ] Add 7D and 14D trade count.
- [ ] Add 7D and 14D win rate.
- [ ] Add top category and category share.
- [ ] Add top-win share.
- [ ] Add warning badges in expanded view.

### Phase 4: Copyability Score

- [ ] Implement first display-only copy score.
- [ ] Add score component breakdown in expanded view.
- [ ] Add sorting by copy score.
- [ ] Do not use for auto-copy promotion until backtested.

### Phase 5: Backtest and Promotion Rules

- [ ] Extend existing gate backtest script to compare metric-based gates.
- [ ] Test profit factor gate.
- [ ] Test max drawdown gate.
- [ ] Test top-win share penalty.
- [ ] Test combined copy score threshold.
- [ ] Only after validation, consider using metrics in auto-copy promotion/retention.

## Recommended Initial Thresholds

These are starting points only and should be tuned by backtest.

```text
Minimum profit factor:       1.30x
Maximum max drawdown:       -30%
Maximum top-win share:       50%
Minimum recent 14D trades:   5
Minimum ROI:                 10%
Preferred median entry:      <= 60c
```

Hard gates should remain conservative. Prefer warnings and sorting before automatic exclusion.

## Agent Notes

- Prioritize correctness over UI polish.
- Do not calculate these metrics from unresolved markets unless the metric explicitly uses observed activity rather than realized P/L.
- Keep metric names stable in API responses.
- Avoid breaking existing candidate leaderboard consumers.
- Add tests for metric edge cases: no losses, no wins, no deployed capital, single trade, missing category, and sparse recent data.
- First implementation should be safe for demo mode and display-only.
