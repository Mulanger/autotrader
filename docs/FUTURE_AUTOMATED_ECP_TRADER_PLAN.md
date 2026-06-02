# Future Automated ECP Trader Implementation Plan

Created: 2026-06-02

## Status

This is a future roadmap, not active production behavior.

Production trader selection is currently manual: the Real score page ranks wallets with the ECP copy-quality model, and the operator manually chooses which traders to follow. The old automated copy-pool promotion path and shadow trader are disabled. The live stake is 4 USD per copied trade.

The goal of this document is to preserve the requirements for a future fully automated ECP trader, and to explain why each requirement matters financially so a future agent does not treat automation as only a UI or scheduling task.

## Current Baseline

- ECP scoring is the production ranking model.
- Candidate discovery polling is disabled to avoid high Railway compute and network cost.
- Daily candidate maintenance stays enabled for the already discovered/scored trader universe.
- Real follows are manual.
- Auto copy-pool promotion is disabled.
- Shadow polling is disabled.
- Live stake is 4 USD.
- Copy scoring focuses on copyable edge, expected copy profit, fill rate, slippage, median entry, sample size, profit factor, ROI, win rate, top-win concentration, and drawdown.

## The Seven Requirements Before Full Automation

### 1. Actual Copy-Performance Feedback

Need:

Track how the score model performs after a wallet is actually followed. Store and review predicted ECP versus realized copied P/L, copied fill rate, rejected attempts, stale-source rejects, duplicate-market rejects, actual slippage, drawdown after follow, and realized return per copied trade.

Why:

The current score says, "this wallet appears profitable to copy based on historical copyable trades." Automation needs proof that the predicted edge converts into real copied profit at the actual 4 USD stake. Without this feedback loop, the system can keep following traders whose historical edge looks good but does not survive live execution.

Implementation shape:

- Add a per-follow or per-wallet performance rollup table.
- Update it from real orders, positions, and resolved copied outcomes.
- Compare pre-follow score values against post-follow realized values.
- Surface this on the score page or a trader detail view.

Acceptance criteria:

- For every active follow, the dashboard can show predicted ECP, realized copied P/L, realized copy ROI, attempts, fills, rejects, slippage, and drawdown since follow.
- The automation selector can use these realized fields as penalties or removal triggers.

### 2. Event And Theme Diversification

Need:

Measure and limit concentration across events, markets, and correlated themes. Require enough distinct events in the historical sample, and cap active exposure to one event or theme.

Why:

A wallet can look strong because it won one narrow cluster of related markets. If the system follows many traders all betting the same macro event, the portfolio can take a large correlated loss even when each wallet individually has a good score.

Implementation shape:

- Add distinct-event counts to score output.
- Track active open value by event and theme.
- Enforce max exposure per event and theme.
- Penalize traders whose edge comes from too few distinct events.

Acceptance criteria:

- Automation cannot select a trader if the portfolio is already over the event/theme exposure cap.
- Score rows show enough event diversity context to explain why a trader was accepted or rejected.

### 3. Trade-Size Matching

Need:

Score wallets in size bands that match what the system can actually copy. Compare large-trade edge against small-trade copy behavior, and avoid assuming that a trader's 1k to 10k USD trades imply the same edge at copied 4 USD entries.

Why:

Some traders have edge only when they move size, get different fills, or participate in liquidity conditions that do not match a tiny copy trade. If scoring learns from one size regime while live copying happens in another, ECP can be overstated.

Implementation shape:

- Add trade-size bucket metrics.
- Track whether copied opportunities came from the same size regime as the scoring sample.
- Consider lower-size historical trades as a secondary validation layer.
- Penalize wallets where the copyable edge is only visible in a size band that does not match the live strategy.

Acceptance criteria:

- Score output can explain the size band used for the edge estimate.
- Automation can reject or downgrade wallets with poor size-match confidence.

### 4. Throughput-Aware Profit

Need:

Rank not only by expected profit per copied trade, but also by expected profit over time. Estimate copyable trades per week/month and compute expected weekly or monthly copied profit.

Why:

A wallet with high ECP but one copyable trade per month can earn less than a wallet with lower ECP and frequent copyable trades. Manual picking can reason about this, but automation needs an explicit throughput signal.

Implementation shape:

- Track copyable trade frequency per wallet.
- Compute expected weekly/monthly copy profit as ECP times expected copyable trade count.
- Use both per-trade quality and throughput in the selector.

Acceptance criteria:

- Score rows include expected copy profit per trade and per week/month.
- Automation does not over-rank inactive wallets solely because their per-trade ECP is high.

### 5. Automatic Portfolio Rules

Need:

Define deterministic rules for who gets followed, who gets removed, and how many traders can be active. These rules should include minimum ECP, minimum sample, maximum active follows, max per event/theme, cooldowns, and removal conditions.

Why:

A fully automatic trader is not just "follow the top 20." It needs a portfolio policy. Without fixed rules, the system can churn follows, over-concentrate risk, or keep weak traders active because no removal logic exists.

Implementation shape:

- Add an auto-selector that produces a proposed portfolio from the score table.
- Start in read-only mode and log proposed adds/removes.
- Later allow guarded live mutations behind an explicit automation flag.
- Store each selection decision with reasons.

Acceptance criteria:

- The selector can explain every add, keep, skip, and remove.
- Automation can be run in dry-run mode with no follow mutations.
- Live auto-follow requires an explicit environment flag and can be disabled instantly.

### 6. Execution Safety Hardening

Need:

Implement claim-before-submit for live orders. Insert or claim a pending order attempt before calling live FOK execution. Only the process that wins the idempotency claim may submit the live order. Update that row after success or failure.

Why:

Right now the system is safe as long as only one live poller runs. A future second poller, dashboard worker, restart overlap, or deployment race could submit an order before the database records the attempt. Claim-before-submit makes duplicate pollers safe instead of hazardous.

Implementation shape:

- Add a pending order claim path using the existing idempotency key.
- Submit the live FOK order only after the database insert/claim succeeds.
- Mark the order as filled, failed, rejected, or expired after execution.
- Add duplicate-poller tests proving only one path can submit.

Acceptance criteria:

- Two simultaneous pollers cannot submit the same live order.
- Failed live submissions still leave an auditable attempt row.
- The system can safely tolerate accidental duplicate workers.

### 7. Kill Switches And Loss Limits

Need:

Add hard portfolio-level and trader-level limits: max daily realized loss, max open value, max open positions, max attempts/orders per hour, max exposure per trader, max exposure per event, and health-check failure stops.

Why:

Automation must fail closed. Even a good model can lose money during data issues, API failures, market shocks, duplicate workers, bad fills, or model drift. Loss limits cap the downside before the system can compound a bad condition.

Implementation shape:

- Add configurable environment limits.
- Check limits before follow additions and before order submission.
- Add a global auto-trading kill switch.
- Surface active limit state in health and the dashboard.

Acceptance criteria:

- Automation stops opening new positions when any configured limit is reached.
- Operators can see which limit stopped trading.
- A single env flag can disable all automatic add/order behavior.

## Phased Roadmap

### Phase 0: Keep Manual ECP Selection

Continue using the current score page manually. Collect more live copied outcomes at 4 USD stake. Do not re-enable candidate discovery, shadow trader, or old copy-pool automation.

### Phase 1: Read-Only Auto-Selector

Build the automated selector in dry-run mode. It should propose adds/removes from the ECP table, log decision reasons, and compare its proposed portfolio against manual choices. It must not mutate follows.

### Phase 2: Guarded Automation At Small Scale

Enable auto-add/remove only after claim-before-submit, realized performance feedback, diversification, and loss limits exist. Start with conservative caps and the current 4 USD stake.

### Phase 3: Scale Only After Calibration

Increase automation scope only after at least one to two weeks of reviewed live results show that expected ECP, realized copied profit, drawdown, fill rate, and throughput line up closely enough.

## Do Not Fully Automate Until

- Claim-before-submit is implemented and tested.
- Realized copy-performance feedback exists per followed wallet.
- Event/theme diversification is enforced.
- Trade-size matching is visible or accounted for.
- Throughput-aware expected profit is available.
- Portfolio rules are deterministic and auditable.
- Kill switches and loss limits are configured and visible.
- A manual rollback path is tested.

## Files A Future Agent Should Inspect

- `server/copy-quality-score.js`
- `server/candidate-tracker/storage.js`
- `server/real/service.js`
- `server/real/storage.js`
- `server/config.js`
- `src/main.jsx`
- `test/`

## Guiding Principle

The current ECP system is a strong manual ranking system. A fully automatic trader needs the same scoring quality, plus execution safety, portfolio rules, feedback loops, and hard downside limits. The goal is not only to pick high-profit traders, but to keep the system profitable when data, markets, or infrastructure behave differently than expected.
