import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  BarChart3,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  Cpu,
  ExternalLink,
  Gauge,
  Layers3,
  LineChart,
  ListFilter,
  Lock,
  PauseCircle,
  PlayCircle,
  RefreshCcw,
  ShieldCheck,
  Target,
  Wallet,
} from 'lucide-react';
import './styles.css';

const API_BASE = '';

function App() {
  const { state, connected, refresh } = useAutotraderState();
  const [mode, setMode] = React.useState('demo');
  const [tab, setTab] = React.useState('overview');

  const data = state || emptyState();
  const metrics = data.demo.metrics;

  return (
    <main className="shell">
      <Sidebar
        mode={mode}
        setMode={setMode}
        connected={connected}
        service={data.service}
        metrics={metrics}
        watchedWalletCount={data.watchedWallets.length}
      />
      <section className="workspace">
        <Topbar
          mode={mode}
          tab={tab}
          setTab={setTab}
          refresh={refresh}
          service={data.service}
        />

        {mode === 'demo' ? (
          <DemoWorkspace data={data} metrics={metrics} tab={tab} />
        ) : (
          <RealWorkspace data={data} tab={tab} />
        )}
      </section>
    </main>
  );
}

function useAutotraderState() {
  const [state, setState] = React.useState(null);
  const [connected, setConnected] = React.useState(false);

  const refresh = React.useCallback(async () => {
    const response = await fetch(`${API_BASE}/api/state`);
    setState(await response.json());
  }, []);

  React.useEffect(() => {
    let socket;
    let reconnectTimer;
    let stopped = false;

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsHost = window.location.port === '5173' ? '127.0.0.1:4101' : window.location.host;
    const wsUrl = `${wsProtocol}//${wsHost}/events`;

    const connect = () => {
      if (stopped) return;
      socket = new WebSocket(wsUrl);

      socket.addEventListener('open', () => {
        setConnected(true);
        refresh().catch(() => {});
      });

      socket.addEventListener('close', () => {
        setConnected(false);
        if (!stopped) reconnectTimer = window.setTimeout(connect, 2_000);
      });

      socket.addEventListener('error', () => {
        setConnected(false);
        socket.close();
      });

      socket.addEventListener('message', (event) => {
        try {
          const parsed = JSON.parse(event.data);
          if (parsed.type === 'state') setState(parsed.payload);
        } catch {
          setConnected(false);
        }
      });
    };

    refresh().catch(() => {});
    connect();
    const fallbackRefresh = window.setInterval(() => refresh().catch(() => {}), 15_000);

    return () => {
      stopped = true;
      window.clearTimeout(reconnectTimer);
      window.clearInterval(fallbackRefresh);
      socket?.close();
    };
  }, [refresh]);

  return { state, connected, refresh };
}

function Sidebar({ mode, setMode, connected, service, metrics, watchedWalletCount }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brandMark">PW</div>
        <div>
          <strong>Autotrader</strong>
          <span>Polywhale copy desk</span>
        </div>
      </div>

      <div className="modeSwitch" role="tablist" aria-label="Trading mode">
        <button className={mode === 'demo' ? 'active' : ''} onClick={() => setMode('demo')}>
          <PlayCircle size={16} /> Demo
        </button>
        <button className={mode === 'real' ? 'active' : ''} onClick={() => setMode('real')}>
          <Lock size={16} /> Real
        </button>
      </div>

      <div className="sidebarBlock">
        <span className="eyebrow">Signal source</span>
        <StatusLine active={connected} label={connected ? 'Dashboard live updates online' : 'Dashboard live updates reconnecting'} />
        <StatusLine
          active={service?.streamStatus === 'connected'}
          label={`Whale stream ${service?.streamStatus || 'booting'}`}
        />
        <StatusLine
          active={['ready', 'polling', 'bootstrapping'].includes(service?.pollStatus)}
          label={`REST poll ${service?.pollStatus || 'idle'}`}
        />
        <StatusLine
          active={['ready', 'polling', 'idle'].includes(service?.resolutionStatus)}
          label={`Resolution tracker ${service?.resolutionStatus || 'idle'}`}
        />
        <StatusLine
          active={service?.storage?.durable && ['ready', 'saving'].includes(service?.storage?.status)}
          label={storageLabel(service?.storage)}
        />
      </div>

      <div className="sidebarBlock">
        <span className="eyebrow">Risk model</span>
        <div className="riskLine"><span>Capital</span><strong>$100.00</strong></div>
        <div className="riskLine"><span>Copy size</span><strong>$10.00</strong></div>
        <div className="riskLine"><span>Max entry</span><strong>{formatCents(metrics.maxEntryPriceCents || 75)}</strong></div>
        <div className="riskLine"><span>Wallets</span><strong>{watchedWalletCount}</strong></div>
      </div>
    </aside>
  );
}

function storageLabel(storage) {
  if (!storage) return 'Storage starting';
  if (storage.durable) return `Storage ${storage.status}`;
  if (storage.status === 'memory_only') return 'Storage memory only';
  return `Storage ${storage.status || 'unknown'}`;
}

function Topbar({ mode, tab, setTab, refresh, service }) {
  const tabs = ['overview', 'profit', 'positions', 'traders'];
  return (
    <header className="topbar">
      <div>
        <p className="eyebrow">{mode === 'demo' ? 'Simulated execution' : 'Live execution disabled'}</p>
        <h1>{mode === 'demo' ? 'Demo copy trading dashboard' : 'Real trading control room'}</h1>
      </div>
      <nav className="tabs" aria-label="Dashboard views">
        {tabs.map((item) => (
          <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>
            {item}
          </button>
        ))}
      </nav>
      <div className="topActions">
        <span className="lastSync">Last poll {formatTimeAgo(service?.pollLastRunAt)}</span>
        <button className="iconButton" onClick={refresh} aria-label="Refresh state"><RefreshCcw size={16} /></button>
      </div>
    </header>
  );
}

function DemoWorkspace({ data, metrics, tab }) {
  if (tab === 'profit') return <ProfitView metrics={metrics} closedPositions={data.demo.closedPositions} />;
  if (tab === 'positions') {
    return (
      <PositionsView
        openPositions={data.demo.openPositions}
        closedPositions={data.demo.closedPositions}
        metrics={metrics}
      />
    );
  }
  if (tab === 'traders') return <TraderGrid traders={data.traders} />;

  return (
    <div className="dashboardGrid">
      <section className="mainColumn">
        <MetricStrip metrics={metrics} />
        <LiveFeed events={data.copiedFeed} />
      </section>
      <section className="sideColumn">
        <OpenPositionsCard positions={data.demo.openPositions} />
        <TraderGrid traders={data.traders} compact />
      </section>
    </div>
  );
}

function RealWorkspace({ data, tab }) {
  if (tab === 'traders') return <TraderGrid traders={data.traders} />;

  return (
    <div className="realGrid">
      <section className="realPanel">
        <div className="lockPlate"><Lock size={22} /></div>
        <p className="eyebrow">Execution adapter</p>
        <h2>Real copy trading is not armed</h2>
        <p>
          This page is separate from demo state and only observes matched trades. Live orders need a reviewed
          Polymarket adapter, wallet signing, position checks, max-loss limits, and a manual arming step.
        </p>
        <div className="adapterList">
          <StatusLine active={false} label="Wallet signer missing" />
          <StatusLine active={false} label="Order placement adapter missing" />
          <StatusLine active={false} label="Manual live-trading arm switch missing" />
          <StatusLine active label="Read-only whale monitoring active" />
        </div>
      </section>
      <section>
        <LiveFeed events={data.copiedFeed} realMode />
      </section>
    </div>
  );
}

function MetricStrip({ metrics }) {
  const items = [
    { label: 'Equity', value: usd(metrics.equityUsd), icon: CircleDollarSign, tone: pnlTone(metrics.totalPnlUsd) },
    { label: 'Cash', value: usd(metrics.cashUsd), icon: Wallet },
    { label: 'Total P/L', value: signedUsd(metrics.totalPnlUsd), icon: LineChart, tone: pnlTone(metrics.totalPnlUsd) },
    { label: 'Copied trades', value: metrics.copiedCount, icon: Activity },
    { label: 'Open positions', value: metrics.openPositionCount, icon: Target },
  ];

  return (
    <section className="metricStrip">
      {items.map(({ label, value, icon: Icon, tone }) => (
        <div className={`metric ${tone || ''}`} key={label}>
          <Icon size={18} />
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </section>
  );
}

function LiveFeed({ events, realMode = false }) {
  const visible = events.slice(0, 40);
  return (
    <section className="panel feedPanel">
      <div className="sectionHead">
        <div>
          <p className="eyebrow">Copy-list tape</p>
          <h2>Watched trades and copy decisions</h2>
        </div>
        <ListFilter size={18} />
      </div>
      <div className="feedList">
        {visible.map((event) => (
          <TradeEventRow key={`${event.id}-${event.observedAt}`} event={event} realMode={realMode} />
        ))}
        {!visible.length && <EmptyState title="Waiting for watched-wallet trades" text="Only trades from the copy list appear here." />}
      </div>
    </section>
  );
}

function TradeEventRow({ event, realMode }) {
  const trade = event.trade;
  const decision = realMode ? event.realDecision : event.copyDecision;
  const copied = decision?.action === 'copied';
  const skipped = decision?.action === 'skipped' || decision?.action === 'blocked';
  const ignored = decision?.action === 'ignored';
  const Icon = copied ? ArrowUpRight : skipped ? PauseCircle : Activity;

  return (
    <article className={`feedRow ${event.watched ? 'watched' : ''}`}>
      <div className="marketThumb">
        {trade.market.icon ? <img src={trade.market.icon} alt="" /> : <BarChart3 size={18} />}
      </div>
      <div className="feedBody">
        <div className="feedTitle">
          <strong>{traderName(trade.trader)}</strong>
          <span>{trade.side} {trade.outcome}</span>
          <span>{usd(trade.usdSize)}</span>
        </div>
        <p>{trade.market.title}</p>
        <div className="feedMeta">
          <span>{formatTimeAgo(trade.timestamp * 1000)}</span>
          <span>{trade.priceCents ? `${trade.priceCents.toFixed(1)}c` : 'price unknown'}</span>
          <span>{sourceLabel(event.source)}</span>
        </div>
      </div>
      <div className="decisionCell">
        <span className={`decisionPill ${copied ? 'copied' : skipped ? 'skipped' : ignored ? 'ignored' : ''}`}>
          <Icon size={14} /> {copied ? 'Copied' : skipped ? (realMode ? 'Blocked' : 'Skipped') : 'Observed'}
        </span>
        <small>{decision?.reason}</small>
      </div>
    </article>
  );
}

function sourceLabel(source) {
  if (source === 'bootstrap') return 'loaded at startup';
  if (source === 'websocket') return 'live stream';
  if (source === 'poll') return 'poll sync';
  return source || 'unknown source';
}

function OpenPositionsCard({ positions }) {
  return (
    <section className="panel positionsPanel">
      <div className="sectionHead">
        <div>
          <p className="eyebrow">Demo portfolio</p>
          <h2>Currently copied trades</h2>
        </div>
        <Gauge size={18} />
      </div>
      <PositionList positions={positions.slice(0, 8)} />
    </section>
  );
}

function PositionsView({ openPositions, closedPositions, metrics }) {
  const [filter, setFilter] = React.useState('open');
  const allPositions = React.useMemo(() => [...openPositions, ...closedPositions], [openPositions, closedPositions]);
  const positions = filter === 'open' ? openPositions : filter === 'closed' ? closedPositions : allPositions;
  const filters = [
    { id: 'open', label: 'Open', count: openPositions.length, icon: Clock3 },
    { id: 'closed', label: 'Closed', count: closedPositions.length, icon: CheckCircle2 },
    { id: 'all', label: 'All', count: allPositions.length, icon: Layers3 },
  ];
  const emptyCopy = {
    open: {
      title: 'No open demo positions',
      text: 'The next watched BUY trade will open a $10 simulated position and wait for official resolution.',
    },
    closed: {
      title: 'No closed demo positions',
      text: 'Resolved copied trades will appear here with their final status and realized P/L.',
    },
    all: {
      title: 'No demo positions yet',
      text: 'Copied watched-wallet BUY trades will appear here once the demo engine opens a position.',
    },
  }[filter];

  return (
    <section className="panel fullPanel positionsWorkspace">
      <div className="sectionHead">
        <div>
          <p className="eyebrow">Demo positions</p>
          <h2>Open exposure and settled trades</h2>
        </div>
      </div>
      <div className="positionSummary">
        <div className="positionStat">
          <span>Open</span>
          <strong>{openPositions.length}</strong>
        </div>
        <div className="positionStat">
          <span>Closed</span>
          <strong>{closedPositions.length}</strong>
        </div>
        <div className="positionStat">
          <span>Realized</span>
          <strong className={pnlTone(metrics.realizedPnlUsd)}>{signedUsd(metrics.realizedPnlUsd)}</strong>
        </div>
        <div className="positionStat">
          <span>Unrealized</span>
          <strong className={pnlTone(metrics.unrealizedPnlUsd)}>{signedUsd(metrics.unrealizedPnlUsd)}</strong>
        </div>
      </div>
      <div className="positionControls" role="tablist" aria-label="Position status filter">
        {filters.map(({ id, label, count, icon: Icon }) => (
          <button key={id} className={filter === id ? 'active' : ''} onClick={() => setFilter(id)}>
            <Icon size={15} />
            <span>{label}</span>
            <b>{count}</b>
          </button>
        ))}
      </div>
      <PositionList positions={positions} expanded emptyTitle={emptyCopy.title} emptyText={emptyCopy.text} />
    </section>
  );
}

function PositionList({ positions, expanded = false, emptyTitle, emptyText }) {
  if (!positions.length) {
    return (
      <EmptyState
        title={emptyTitle || 'No open demo positions'}
        text={emptyText || 'The next watched BUY trade will open a $10 simulated position and wait for official resolution.'}
      />
    );
  }

  return (
    <div className={expanded ? 'positionList expanded' : 'positionList'}>
      {positions.map((position) => <PositionRow key={`${position.id}-${position.status}`} position={position} expanded={expanded} />)}
    </div>
  );
}

function PositionRow({ position, expanded }) {
  const open = isOpenPosition(position);
  const pnl = open ? position.unrealizedPnlUsd || 0 : position.realizedPnlUsd || 0;
  const dateLabel = marketDateLabel(position);
  const resolution = resolutionLabel(position);
  const timeline = open
    ? `opened ${formatTimeAgo(position.openedAt)}`
    : `resolved ${formatTimeAgo(position.resolvedAt || position.closedAt)}`;

  return (
    <article className={`positionRow ${open ? 'open' : 'closed'}`}>
      <div className="marketThumb">
        {position.marketIcon ? <img src={position.marketIcon} alt="" /> : <Target size={18} />}
      </div>
      <div className="positionMain">
        <div className="positionTitleLine">
          <strong>{position.outcome}</strong>
          <span className={`statusBadge ${statusClass(position.status)}`}>{statusLabel(position.status)}</span>
        </div>
        <p>{position.marketTitle}</p>
        <div className="positionMeta">
          {dateLabel && <span>{dateLabel}</span>}
          <span>{shortWallet(position.traderWallet)}</span>
          <span>entry {formatCents(position.entryPriceCents)}</span>
          {!open && <span>exit {formatCents(position.exitPriceCents)}</span>}
          <span>{timeline}</span>
          {resolution && <span>{resolution}</span>}
          <span>{feeLabel(position)}</span>
        </div>
      </div>
      <div className="positionNumbers">
        <span className="positionPriceLabel">{open ? 'Current' : 'Payout'}</span>
        <strong>{open ? formatCents(position.currentPriceCents) : usd(position.exitValueUsd)}</strong>
        <span className={pnlTone(pnl)}>
          {signedUsd(pnl)}
          {open ? ` - ${signedPct(position.unrealizedPnlPct || 0)}` : ''}
        </span>
      </div>
      {expanded && position.polymarketUrl && (
        <a className="iconButton" href={position.polymarketUrl} target="_blank" rel="noreferrer" aria-label="Open Polymarket">
          <ExternalLink size={16} />
        </a>
      )}
    </article>
  );
}

function TraderGrid({ traders, compact = false }) {
  return (
    <section className={compact ? 'panel traderPanel compact' : 'panel fullPanel traderPanel'}>
      <div className="sectionHead">
        <div>
          <p className="eyebrow">Copy list</p>
          <h2>Watched leaderboard accounts</h2>
        </div>
        <ShieldCheck size={18} />
      </div>
      <div className={compact ? 'traderList compact' : 'traderList'}>
        {traders.map((trader) => (
          <TraderCard key={trader.wallet} trader={trader} compact={compact} />
        ))}
      </div>
    </section>
  );
}

function TraderCard({ trader, compact }) {
  const recent = trader.recentTrades || [];
  return (
    <article className="traderCard">
      <div className="traderTop">
        <div className="avatar">
          {trader.profileImage ? <img src={trader.profileImage} alt="" /> : <Cpu size={17} />}
        </div>
        <div>
          <strong>{trader.displayName || trader.pseudonym || trader.label}</strong>
          <span>{shortWallet(trader.wallet)}</span>
        </div>
        {trader.rank && <em>#{trader.rank}</em>}
      </div>
      <div className="traderStats">
        <span><b>{usd(trader.allTimeProfitUsd)}</b> profit</span>
        <span><b>{pct(trader.allTimeWinRatePct)}</b> winrate</span>
        <span><b>{trader.copiedCount}</b> copied</span>
      </div>
      {!compact && (
        <div className="recentTradeStack">
          {recent.slice(0, 4).map((trade) => (
            <div className="miniTrade" key={trade.id}>
              <span>{trade.side} {trade.outcome}</span>
              <strong>{usd(trade.usdSize)}</strong>
              <em className={statusTone(trade.status)}>
                {statusLabel(trade.status)}
              </em>
            </div>
          ))}
          {!recent.length && <small className="muted">No watched trades seen this session.</small>}
        </div>
      )}
    </article>
  );
}

function ProfitView({ metrics, closedPositions }) {
  const bars = buildProfitBars(closedPositions);
  return (
    <div className="profitGrid">
      <section className="panel profitHero">
        <p className="eyebrow">Demo performance</p>
        <div className="profitNumber">
          <strong className={pnlTone(metrics.totalPnlUsd)}>{signedUsd(metrics.totalPnlUsd)}</strong>
          <span>Total P/L on {metrics.copiedCount} copied demo positions</span>
        </div>
        <div className="profitBreakdown">
          <span>Realized <b className={pnlTone(metrics.realizedPnlUsd)}>{signedUsd(metrics.realizedPnlUsd)}</b></span>
          <span>Unrealized <b className={pnlTone(metrics.unrealizedPnlUsd)}>{signedUsd(metrics.unrealizedPnlUsd)}</b></span>
          <span>Known fees <b>{feeMetric(metrics)}</b></span>
          <span>Notional copied <b>{usd(metrics.totalNotionalCopiedUsd)}</b></span>
        </div>
      </section>
      <section className="panel chartPanel">
        <div className="sectionHead">
          <div>
            <p className="eyebrow">Closed trades</p>
            <h2>Realized P/L distribution</h2>
          </div>
        </div>
        <div className="barChart">
          {bars.map((bar) => (
            <div className="barWrap" key={bar.id}>
              <div className={bar.value >= 0 ? 'bar positiveBar' : 'bar negativeBar'} style={{ height: `${bar.height}%` }} />
              <span>{signedUsd(bar.value)}</span>
            </div>
          ))}
          {!bars.length && <EmptyState title="No closed demo trades" text="Official market resolutions will settle demo positions and appear here." />}
        </div>
      </section>
      <section className="panel historyPanel">
        <div className="sectionHead">
          <div>
            <p className="eyebrow">Trade history</p>
            <h2>Closed demo trades</h2>
          </div>
        </div>
        <ClosedHistory positions={closedPositions} />
      </section>
    </div>
  );
}

function ClosedHistory({ positions }) {
  if (!positions.length) {
    return <EmptyState title="No closed trades yet" text="Resolved copied trades will persist here once the watched markets finish." />;
  }

  return (
    <div className="historyList">
      {positions.map((position) => (
        <article className="historyRow" key={`${position.id}-${position.closedAt}`}>
          <div>
            <strong>{position.outcome}</strong>
            <p>{position.marketTitle}</p>
            <div className="historyMeta">
              {marketDateLabel(position) && <span>{marketDateLabel(position)}</span>}
              <span>{shortWallet(position.traderWallet)}</span>
              <span>resolved {formatTimeAgo(position.resolvedAt || position.closedAt)}</span>
              {resolutionLabel(position) && <span>{resolutionLabel(position)}</span>}
              <span>{feeLabel(position)}</span>
            </div>
          </div>
          <div>
            <span className={position.status === 'win' ? 'positive' : position.status === 'loss' ? 'negative' : ''}>
              {statusLabel(position.status)}
            </span>
            <strong className={pnlTone(position.realizedPnlUsd)}>{signedUsd(position.realizedPnlUsd)}</strong>
          </div>
        </article>
      ))}
    </div>
  );
}

function StatusLine({ active, label }) {
  return (
    <div className="statusLine">
      <span className={active ? 'dot active' : 'dot'} />
      <span>{label}</span>
    </div>
  );
}

function EmptyState({ title, text }) {
  return (
    <div className="emptyState">
      <AlertTriangle size={18} />
      <strong>{title}</strong>
      <span>{text}</span>
    </div>
  );
}

function emptyState() {
  return {
    service: {},
    watchedWallets: [],
    traders: [],
    demo: {
      metrics: {
        equityUsd: 100,
        cashUsd: 100,
        totalPnlUsd: 0,
        realizedPnlUsd: 0,
        unrealizedPnlUsd: 0,
        copiedCount: 0,
        openPositionCount: 0,
        totalNotionalCopiedUsd: 0,
        knownEntryFeesUsd: 0,
        feeUnknownCount: 0,
        maxEntryPriceCents: 75,
      },
      openPositions: [],
      closedPositions: [],
    },
    real: {},
    allTrades: [],
    copiedFeed: [],
  };
}

function buildProfitBars(closedPositions) {
  const latest = closedPositions.slice(0, 14).reverse();
  const max = Math.max(1, ...latest.map((item) => Math.abs(item.realizedPnlUsd || 0)));
  return latest.map((item) => ({
    id: item.id,
    value: item.realizedPnlUsd || 0,
    height: Math.max(8, Math.abs(item.realizedPnlUsd || 0) / max * 100),
  }));
}

function traderName(trader) {
  return trader.displayName || trader.pseudonym || shortWallet(trader.proxyWallet);
}

function usd(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'n/a';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(number);
}

function signedUsd(value) {
  const number = Number(value || 0);
  const prefix = number >= 0 ? '+' : '-';
  return `${prefix}${usd(Math.abs(number))}`;
}

function pct(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'n/a';
  return `${number.toFixed(number >= 99 ? 0 : 1)}%`;
}

function formatCents(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'n/a';
  return `${number.toFixed(1)}c`;
}

function feeMetric(metrics) {
  if (metrics.feeUnknownCount > 0) return `${metrics.feeUnknownCount} unknown`;
  return usd(metrics.knownEntryFeesUsd || 0);
}

function feeLabel(position) {
  if (position.feeStatus === 'known') return `fee ${usd(position.entryFeeUsd || 0)}`;
  if (position.feeStatus === 'estimated') return `est. fee ${usd(position.entryFeeUsd || 0)}`;
  return 'fee unknown';
}

function signedPct(value) {
  const number = Number(value || 0);
  const prefix = number >= 0 ? '+' : '';
  return `${prefix}${number.toFixed(1)}%`;
}

function pnlTone(value) {
  const number = Number(value || 0);
  if (number > 0.005) return 'positive';
  if (number < -0.005) return 'negative';
  return 'neutral';
}

function statusLabel(status) {
  const value = String(status || 'open').toLowerCase();
  if (value === 'resolved_win' || value === 'win') return 'win';
  if (value === 'resolved_loss' || value === 'loss') return 'loss';
  if (value === 'invalid') return 'refunded';
  if (value === 'resolved') return 'resolved';
  if (value === 'closed') return 'closed';
  return 'open';
}

function statusClass(status) {
  const value = String(status || 'open').toLowerCase();
  if (value === 'resolved_win' || value === 'win') return 'positive';
  if (value === 'resolved_loss' || value === 'loss') return 'negative';
  if (value === 'invalid') return 'refunded';
  if (value === 'open') return 'open';
  return 'neutral';
}

function statusTone(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'resolved_win' || value === 'win') return 'positive';
  if (value === 'resolved_loss' || value === 'loss') return 'negative';
  return '';
}

function isOpenPosition(position) {
  return String(position?.status || 'open').toLowerCase() === 'open';
}

function marketDateLabel(position) {
  const date = extractDateText(position?.marketSlug) || extractDateText(position?.marketTitle) || extractDateText(position?.polymarketUrl);
  return date ? `Market ${formatDateOnly(date)}` : null;
}

function extractDateText(value) {
  const match = String(value || '').match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function formatDateOnly(value) {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(date);
}

function resolutionLabel(position) {
  if (!position?.winningOutcome) return null;
  const winner = String(position.winningOutcome).trim();
  const normalizedWinner = winner.toUpperCase();
  const normalizedOutcome = String(position.outcome || '').trim().toUpperCase();
  if (['YES', 'NO'].includes(normalizedWinner) && !['YES', 'NO'].includes(normalizedOutcome)) {
    return `winning side ${winner}`;
  }
  return `winner ${winner}`;
}

function shortWallet(wallet = '') {
  if (!wallet || wallet.length < 12) return wallet || 'Unknown';
  return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
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

createRoot(document.getElementById('root')).render(<App />);
