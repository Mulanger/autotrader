import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  CircleDollarSign,
  Cpu,
  ExternalLink,
  Gauge,
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
const WATCHED_WALLETS = [
  '0x531b33c5e7b8c2610917f883a13a1b8b1a706022',
  '0x1887879a1bda615e88f280b582514c7d54e2678a',
  '0xc2e7800b5af46e6093872b177b7a5e7f0563be51',
  '0x7c585894ec02d5ed4fcd118ad8982f859360a5a1',
  '0x93abbc022ce98d6f45d4444b594791cc4b7a9723',
  '0xdd92232bcdfbbac04132b3cbacbf32c2e5b16b2a',
  '0x8b5239494dd65eed682f0d9f0481ddeae4ff568e',
  '0xf9c1190aa8184bcbe418e6f5321c53b0bfbc39e2',
  '0xfea31bc088000ff909be1dfd8d0e3f2c7ef2d227',
];

function App() {
  const { state, connected, refresh } = useAutotraderState();
  const [mode, setMode] = React.useState('demo');
  const [tab, setTab] = React.useState('overview');

  const data = state || emptyState();
  const metrics = data.demo.metrics;

  return (
    <main className="shell">
      <Sidebar mode={mode} setMode={setMode} connected={connected} service={data.service} />
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

function Sidebar({ mode, setMode, connected, service }) {
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
          active={service?.storage?.durable && ['ready', 'saving'].includes(service?.storage?.status)}
          label={storageLabel(service?.storage)}
        />
      </div>

      <div className="sidebarBlock">
        <span className="eyebrow">Risk model</span>
        <div className="riskLine"><span>Capital</span><strong>$100.00</strong></div>
        <div className="riskLine"><span>Copy size</span><strong>$10.00</strong></div>
        <div className="riskLine"><span>Wallets</span><strong>{WATCHED_WALLETS.length}</strong></div>
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
  if (tab === 'positions') return <PositionsView positions={data.demo.openPositions} />;
  if (tab === 'traders') return <TraderGrid traders={data.traders} />;

  return (
    <div className="dashboardGrid">
      <section className="mainColumn">
        <MetricStrip metrics={metrics} />
        <LiveFeed events={data.allTrades} />
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
        <LiveFeed events={data.copiedFeed.length ? data.copiedFeed : data.allTrades} realMode />
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
          <p className="eyebrow">Live tape</p>
          <h2>Whale trades and copy decisions</h2>
        </div>
        <ListFilter size={18} />
      </div>
      <div className="feedList">
        {visible.map((event) => (
          <TradeEventRow key={`${event.id}-${event.observedAt}`} event={event} realMode={realMode} />
        ))}
        {!visible.length && <EmptyState title="Waiting for trades" text="The service is connecting to the whale stream." />}
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
          <span>{event.source}</span>
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

function PositionsView({ positions }) {
  return (
    <section className="panel fullPanel">
      <div className="sectionHead">
        <div>
          <p className="eyebrow">Open exposure</p>
          <h2>Currently copied trades</h2>
        </div>
      </div>
      <PositionList positions={positions} expanded />
    </section>
  );
}

function PositionList({ positions, expanded = false }) {
  if (!positions.length) {
    return <EmptyState title="No open demo positions" text="The next watched BUY trade will open a $10 simulated position." />;
  }

  return (
    <div className={expanded ? 'positionList expanded' : 'positionList'}>
      {positions.map((position) => {
        const pnl = position.unrealizedPnlUsd || 0;
        return (
          <article className="positionRow" key={position.id}>
            <div className="marketThumb">
              {position.marketIcon ? <img src={position.marketIcon} alt="" /> : <Target size={18} />}
            </div>
            <div>
              <strong>{position.outcome}</strong>
              <p>{position.marketTitle}</p>
              <small>{shortWallet(position.traderWallet)} · entry {position.entryPriceCents.toFixed(1)}c</small>
            </div>
            <div className="positionNumbers">
              <strong>{position.currentPriceCents.toFixed(1)}c</strong>
              <span className={pnlTone(pnl)}>{signedUsd(pnl)} · {signedPct(position.unrealizedPnlPct || 0)}</span>
            </div>
            {expanded && position.polymarketUrl && (
              <a className="iconButton" href={position.polymarketUrl} target="_blank" rel="noreferrer" aria-label="Open Polymarket">
                <ExternalLink size={16} />
              </a>
            )}
          </article>
        );
      })}
    </div>
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
              <em className={trade.status === 'win' ? 'positive' : trade.status === 'loss' ? 'negative' : ''}>
                {trade.status || 'open'}
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
          <span>Total P/L on {metrics.copiedCount} copied actions</span>
        </div>
        <div className="profitBreakdown">
          <span>Realized <b className={pnlTone(metrics.realizedPnlUsd)}>{signedUsd(metrics.realizedPnlUsd)}</b></span>
          <span>Unrealized <b className={pnlTone(metrics.unrealizedPnlUsd)}>{signedUsd(metrics.unrealizedPnlUsd)}</b></span>
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
          {!bars.length && <EmptyState title="No closed demo trades" text="SELL copies will close matching demo positions and appear here." />}
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
    return <EmptyState title="No closed trades yet" text="Closed copied trades will persist here once Postgres storage is connected." />;
  }

  return (
    <div className="historyList">
      {positions.map((position) => (
        <article className="historyRow" key={`${position.id}-${position.closedAt}`}>
          <div>
            <strong>{position.outcome}</strong>
            <p>{position.marketTitle}</p>
            <small>{shortWallet(position.traderWallet)} · closed {formatTimeAgo(position.closedAt)}</small>
          </div>
          <div>
            <span className={position.status === 'win' ? 'positive' : 'negative'}>{position.status}</span>
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
    traders: WATCHED_WALLETS.map((wallet) => ({ wallet, label: shortWallet(wallet), recentTrades: [] })),
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
