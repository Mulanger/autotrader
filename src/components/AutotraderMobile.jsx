import React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Layers3,
  Menu,
  PauseCircle,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Tag,
  TrendingUp,
  Wallet,
} from 'lucide-react';

const FILTERS = ['All', 'Filled', 'Skipped', 'Failed', 'High Confidence'];

const FAILURE_REASON_CODES = new Set([
  'live_order_error',
  'live_order_rejected',
  'quote_error',
]);

const SKIPPED_REASON_CODES = new Set([
  'above_max_entry_price',
  'above_price_guard',
  'insufficient_liquidity',
  'trader_market_already_copied',
  'market_already_copied',
  'missing_source_price',
  'invalid_stake',
  'empty_orderbook',
]);

export default function AutotraderMobile({ real }) {
  const [filter, setFilter] = React.useState('All');
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [rulesOpen, setRulesOpen] = React.useState(false);

  const orders = Array.isArray(real?.orders) ? real.orders : [];
  const maxEntryPriceCents = real?.runtime?.payload?.maxEntryPriceCents ?? real?.service?.maxEntryPriceCents;
  const events = React.useMemo(
    () => orders.map((order) => toMobileOrderEvent(order, { maxEntryPriceCents })),
    [orders, maxEntryPriceCents]
  );
  const visibleEvents = React.useMemo(() => filterEvents(events, filter), [events, filter]);
  const summary = buildSummaryCards(real, events);
  const runtime = real?.runtime || {};
  const service = real?.service || {};
  const status = runtime.status || service.status || 'loading';
  const mode = isLiveMode(real) ? 'Live' : 'Dry-run';
  const botActive = isBotActive(real) ? 'Bot Active' : 'Bot Offline';

  return (
    <section className="mobileTrader" aria-label="Autotrader mobile dashboard">
      <div className="mobileDeviceBar" aria-hidden="true">
        <span>9:41</span>
        <span className="mobileSystemIcons">
          <span className="mobileSignalBars"><i /><i /><i /><i /></span>
          <span className="mobileWifi" />
          <span className="mobileBattery" />
        </span>
      </div>

      <header className="mobileTraderHeader">
        <button
          className="mobileIconButton"
          type="button"
          aria-label="Open mobile navigation"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((value) => !value)}
        >
          <Menu size={28} />
        </button>
        <div className="mobileTitleBlock">
          <h1>Autotrader</h1>
          <p className={isBotActive(real) ? 'positive' : 'negative'}>
            <span />
            {mode} · {botActive}
          </p>
        </div>
        <button
          className="mobileIconButton"
          type="button"
          aria-label="Show copy rules"
          aria-expanded={rulesOpen}
          onClick={() => setRulesOpen((value) => !value)}
        >
          <SlidersHorizontal size={27} />
        </button>
      </header>

      {menuOpen && <MobileNavPanel real={real} status={status} />}
      {rulesOpen && <MobileRulesPanel real={real} />}

      <section className="mobileSummaryGrid" aria-label="Live account summary">
        {summary.map((item) => (
          <MobileSummaryCard key={item.label} {...item} />
        ))}
      </section>

      <nav className="mobileFilterRow" aria-label="Order filters">
        {FILTERS.map((item) => (
          <button
            key={item}
            className={`mobileFilterChip ${filter === item ? 'selected' : ''}`}
            type="button"
            onClick={() => setFilter(item)}
          >
            {item === 'High Confidence' && <Sparkles size={16} />}
            {item}
            {item !== 'All' && item !== 'High Confidence' && (
              <span>{countForFilter(events, item)}</span>
            )}
          </button>
        ))}
      </nav>

      <section className="mobileAuditFeed" aria-label="Live order audit stream">
        {visibleEvents.length ? (
          visibleEvents.map((event) => <MobileOrderCard event={event} key={event.id} />)
        ) : (
          <div className="mobileEmptyFeed">
            <Clock3 size={22} />
            <strong>No {filter.toLowerCase()} orders yet</strong>
            <span>New copied trades will appear here after the real worker audits them.</span>
          </div>
        )}
      </section>
    </section>
  );
}

function MobileSummaryCard({ label, value, subvalue, tone, icon: Icon }) {
  return (
    <article className="mobileSummaryCard">
      <div className={`mobileSummaryIcon ${tone}`}>
        <Icon size={22} />
      </div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small className={tone === 'blue' ? 'blueText' : ''}>{subvalue}</small>
      </div>
    </article>
  );
}

function MobileOrderCard({ event }) {
  const statusIcon = event.status === 'filled' ? CheckCircle2 : AlertTriangle;
  const StatusIcon = statusIcon;

  return (
    <article className={`mobileOrderCard ${event.status}`}>
      <div className="mobileOrderTopline">
        <div>
          <span className={`mobileStatusBadge ${event.status}`}>{event.badge}</span>
          <span className="mobileDot">·</span>
          <span>{event.meta}</span>
        </div>
        <ChevronRight size={22} />
      </div>

      <h2>{event.title}</h2>
      <p>{event.subtitle}</p>

      {event.status === 'filled' ? (
        <>
          <div className="mobileDetailRow">
            <span><Tag size={17} /> Ask <strong>{event.ask}</strong></span>
            <span><Layers3 size={17} /> Size <strong>{event.size}</strong></span>
            <span><TrendingUp size={17} /> Slippage <strong>{event.slippage}</strong></span>
          </div>
          <div className="mobileCardDivider" />
          <div className="mobileReason positive">
            <CheckCircle2 size={19} />
            <span>{event.reason}</span>
          </div>
        </>
      ) : (
        <div className={`mobileReason ${event.status}`}>
          <StatusIcon size={20} />
          <span>{event.reason}</span>
        </div>
      )}
    </article>
  );
}

function MobileNavPanel({ real, status }) {
  const activeFollows = (real?.follows || []).filter((follow) => follow.status === 'active').length;
  const openPositions = (real?.positions || []).filter((position) => String(position?.status || 'open').toLowerCase() === 'open').length;
  const lastPoll = real?.runtime?.lastPollAt || real?.service?.lastPollAt;

  return (
    <section className="mobileDropPanel">
      <div>
        <span>Worker</span>
        <strong>{status}</strong>
      </div>
      <div>
        <span>Follows</span>
        <strong>{activeFollows}</strong>
      </div>
      <div>
        <span>Open</span>
        <strong>{openPositions}</strong>
      </div>
      <div>
        <span>Last poll</span>
        <strong>{formatTimeAgo(lastPoll)}</strong>
      </div>
    </section>
  );
}

function MobileRulesPanel({ real }) {
  const payload = real?.runtime?.payload || {};
  const service = real?.service || {};
  const stakeUsd = payload.stakeUsd ?? service.stakeUsd;
  const maxEntry = payload.maxEntryPriceCents ?? service.maxEntryPriceCents;
  const guard = payload.priceGuardCents ?? service.priceGuardCents;
  const maxAge = payload.maxSourceTradeAgeSeconds ?? service.maxSourceTradeAgeSeconds;

  return (
    <section className="mobileDropPanel mobileRulesPanel">
      <div>
        <span>Stake</span>
        <strong>{formatUsd(stakeUsd)}</strong>
      </div>
      <div>
        <span>Max entry</span>
        <strong>{formatCents(maxEntry)}</strong>
      </div>
      <div>
        <span>Guard</span>
        <strong>+{formatCents(guard)}</strong>
      </div>
      <div>
        <span>Source age</span>
        <strong>{Number.isFinite(Number(maxAge)) ? `${Number(maxAge)}s` : 'n/a'}</strong>
      </div>
    </section>
  );
}

function buildSummaryCards(real, events) {
  const summary = real?.summary || {};
  const balance = real?.account?.collateral?.walletBalanceUsd ?? real?.account?.collateral?.balanceUsd;
  const exposure = summary.openValueUsd || 0;
  const exposurePct = Number(balance) > 0 ? (Number(exposure) / Number(balance)) * 100 : null;
  const todayEvents = events.filter((event) => isToday(event.checkedAt));
  const filledToday = todayEvents.filter((event) => event.status === 'filled').length;
  const skippedToday = todayEvents.filter((event) => event.status === 'skipped').length;

  return [
    {
      label: 'Balance',
      value: formatCompactUsd(balance),
      subvalue: 'USDC',
      tone: 'green',
      icon: CircleDollarSign,
    },
    {
      label: 'Exposure',
      value: formatCompactUsd(exposure),
      subvalue: Number.isFinite(exposurePct) ? `${exposurePct.toFixed(1)}%` : '0.0%',
      tone: 'blue',
      icon: ShieldCheck,
    },
    {
      label: 'Filled',
      value: String(filledToday || summary.wouldFillCount || 0),
      subvalue: 'Today',
      tone: 'green',
      icon: CheckCircle2,
    },
    {
      label: 'Skipped',
      value: String(skippedToday || events.filter((event) => event.status === 'skipped').length || 0),
      subvalue: 'Today',
      tone: 'amber',
      icon: PauseCircle,
    },
  ];
}

function toMobileOrderEvent(order, context = {}) {
  const status = classifyOrder(order);
  const sourcePrice = formatCents(order.sourcePriceCents);
  const bestAsk = formatCents(order.bestAskCents);
  const maxAsk = formatCents(order.maxGuardCents);
  const slippage = slippageCents(order);
  const reason = order.reason || order.reasonCode || (status === 'filled' ? 'Passed copy rules' : 'Order not copied');
  const outcome = formatOutcome(order.outcome);
  const metaParts = [
    outcome,
    sourcePrice !== 'n/a' ? sourcePrice : null,
    formatTimeAgo(order.checkedAt),
  ].filter(Boolean);

  return {
    id: order.id || `${order.sourceTradeId || order.marketTitle}-${order.checkedAt}`,
    status,
    badge: status.toUpperCase(),
    meta: metaParts.join(' · '),
    title: order.marketTitle || 'Unknown market',
    subtitle: `${outcome} · Trader ${shortWallet(order.traderWallet)}`,
    ask: bestAsk,
    size: formatUsd(order.stakeUsd),
    slippage,
    reason: status === 'skipped' ? skippedReason(order, reason, sourcePrice, maxAsk, context) : reason,
    checkedAt: order.checkedAt,
    highConfidence: status === 'filled' && Math.abs(Number(order.vwapCents || order.bestAskCents || 0) - Number(order.sourcePriceCents || 0)) <= 1,
  };
}

function classifyOrder(order) {
  if (['would_fill', 'filled', 'live_filled'].includes(String(order?.status || '').toLowerCase())) return 'filled';
  const reasonCode = String(order?.reasonCode || '').toLowerCase();
  if (FAILURE_REASON_CODES.has(reasonCode)) return 'failed';
  if (SKIPPED_REASON_CODES.has(reasonCode)) return 'skipped';

  const text = [order?.status, order?.reasonCode, order?.reason].filter(Boolean).join(' ').toLowerCase();
  if (/\b(api|timeout|failed|error|unauthorized|signature|signer|api key|submission|rejected by exchange)\b/.test(text)) {
    return 'failed';
  }
  return 'skipped';
}

function skippedReason(order, fallback, sourcePrice, maxAsk, context = {}) {
  const code = String(order?.reasonCode || '').toLowerCase();
  if (code === 'above_max_entry_price') {
    return `Entry ${sourcePrice}  ›  Max ${formatCents(context.maxEntryPriceCents || order.maxEntryPriceCents || 75)}`;
  }
  if (code === 'above_price_guard') return `Ask ${formatCents(order.bestAskCents)}  ›  Max ${maxAsk}`;
  if (code === 'insufficient_liquidity') return `Not enough liquidity for ${formatUsd(order.stakeUsd)}`;
  if (code.includes('already_copied')) return 'Already copied this market';
  return fallback;
}

function filterEvents(events, filter) {
  if (filter === 'All') return events;
  if (filter === 'High Confidence') return events.filter((event) => event.highConfidence);
  return events.filter((event) => event.status === filter.toLowerCase());
}

function countForFilter(events, filter) {
  return filterEvents(events, filter).length;
}

function isLiveMode(real) {
  if (real?.runtime) {
    return String(real.runtime.mode || '').toLowerCase() === 'live' && Boolean(real.runtime.liveExecutionEnabled);
  }
  return String(real?.mode || '').toLowerCase() === 'live' && Boolean(real?.service?.liveExecutionEnabled);
}

function isBotActive(real) {
  const heartbeat = Date.parse(real?.runtime?.heartbeatAt || real?.runtime?.updatedAt || 0);
  const online = Number.isFinite(heartbeat) && Date.now() - heartbeat < 150_000;
  return online && (real?.runtime?.liveExecutionReady ?? real?.service?.liveExecutionReady ?? true);
}

function slippageCents(order) {
  const fill = Number(order.vwapCents ?? order.bestAskCents);
  const source = Number(order.sourcePriceCents);
  if (!Number.isFinite(fill) || !Number.isFinite(source)) return 'n/a';
  return `${(fill - source).toFixed(1)}c`;
}

function formatUsd(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'n/a';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: number >= 100 ? 0 : 2,
  }).format(number);
}

function formatCompactUsd(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '$0';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: number >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits: number >= 100 ? 0 : 2,
  }).format(number);
}

function formatCents(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'n/a';
  return `${number.toFixed(1)}c`;
}

function formatTimeAgo(value) {
  if (!value) return 'never';
  const time = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(time)) return 'unknown';
  const diff = Math.max(0, Date.now() - time);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function shortWallet(wallet = '') {
  if (!wallet || wallet.length < 12) return wallet || 'Unknown';
  return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
}

function formatOutcome(value) {
  const text = String(value || 'Order').trim();
  if (text.length <= 6) return text.toUpperCase();
  return text;
}

function isToday(value) {
  const time = Date.parse(value || 0);
  if (!Number.isFinite(time)) return false;
  const date = new Date(time);
  const now = new Date();
  return date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
}
