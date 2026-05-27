import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Cpu,
  Database,
  Eye,
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
  Trophy,
  UserMinus,
  UserPlus,
  Users,
  Wallet,
} from 'lucide-react';
import './styles.css';

const API_BASE = '';
const CANDIDATE_TRADE_PAGE_SIZE = 80;
const DASHBOARD_TOKEN_KEY = 'AUTOTRADER_DASHBOARD_TOKEN';
const EMPTY_METRIC = '\u2014';

function dashboardAuthToken() {
  const params = new URLSearchParams(window.location.search);
  const queryToken = params.get('token');
  if (queryToken) {
    window.localStorage.setItem(DASHBOARD_TOKEN_KEY, queryToken);
    return queryToken;
  }
  return window.localStorage.getItem(DASHBOARD_TOKEN_KEY) || '';
}

function authHeaders() {
  const token = dashboardAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function App() {
  const { state, connected, refresh } = useAutotraderState();
  const [mode, setMode] = React.useState('demo');
  const [tab, setTab] = React.useState('overview');

  React.useEffect(() => {
    if (mode === 'real' && !['overview', 'traders'].includes(tab)) setTab('overview');
  }, [mode, tab]);

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
    const response = await fetch(`${API_BASE}/api/state`, { headers: authHeaders() });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'State request failed');
    setState(payload);
  }, []);

  React.useEffect(() => {
    let socket;
    let reconnectTimer;
    let stopped = false;

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsHost = window.location.port === '5173' ? '127.0.0.1:4101' : window.location.host;
    const token = dashboardAuthToken();
    const wsUrl = `${wsProtocol}//${wsHost}/events${token ? `?token=${encodeURIComponent(token)}` : ''}`;

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
        <StatusLine
          active={Boolean(service?.candidates?.enabled) && ['ready', 'polling', 'backfilling', 'resolving'].includes(service?.candidates?.status)}
          label={`Candidate tracker ${service?.candidates?.status || 'disabled'}`}
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
  const tabs = mode === 'demo' ? ['overview', 'shadow', 'profit', 'positions', 'traders', 'candidates'] : ['overview', 'traders'];
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
  if (tab === 'shadow') return <ShadowTraderView shadowTrader={data.shadowTrader} />;
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
  if (tab === 'candidates') return <CandidatesView service={data.service.candidates} copyPoolState={data.copyPool} />;

  return (
    <div className="dashboardGrid">
      <section className="mainColumn">
        <MetricStrip metrics={metrics} />
        <LiveFeed events={data.copiedFeed} />
      </section>
      <section className="sideColumn">
        <ShadowTraderCard shadowTrader={data.shadowTrader} />
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

function ShadowTraderCard({ shadowTrader }) {
  const metrics = shadowTrader?.metrics || {};
  return (
    <section className="panel shadowCard">
      <div className="sectionHead">
        <div>
          <p className="eyebrow">Shadow trader</p>
          <h2>Hybrid v1 paper copy</h2>
        </div>
        <Eye size={18} />
      </div>
      <div className="shadowCardStats">
        <div>
          <span>Selected</span>
          <strong>{shadowTrader?.selectedWalletCount || 0}</strong>
        </div>
        <div>
          <span>P/L</span>
          <strong className={pnlTone(metrics.totalPnlUsd)}>{signedUsd(metrics.totalPnlUsd)}</strong>
        </div>
        <div>
          <span>Copied</span>
          <strong>{metrics.copiedCount || 0}</strong>
        </div>
      </div>
      <div className="shadowStatus">
        <span className="statusBadge neutral">{shadowTrader?.strategy || 'hybrid_gate_v1'}</span>
        <small>Last evaluated {formatTimeAgo(shadowTrader?.lastEvaluatedAt)}</small>
      </div>
    </section>
  );
}

function ShadowTraderView({ shadowTrader }) {
  const shadow = shadowTrader || emptyState().shadowTrader;
  const metrics = shadow.metrics || {};
  const selectedWallets = Object.values(shadow.selectedWallets || {})
    .sort((a, b) => Number(b.distinctResolvedTradeCount || 0) - Number(a.distinctResolvedTradeCount || 0))
    .slice(0, 10);

  return (
    <div className="shadowWorkspace">
      <section className="panel fullPanel shadowPanel">
        <div className="sectionHead">
          <div>
            <p className="eyebrow">Hybrid v1 shadow</p>
            <h2>Second demo trader</h2>
          </div>
          <span className="statusBadge neutral">{shadow.status || 'starting'}</span>
        </div>
        <MetricStrip metrics={metrics} />
        <div className="shadowSummary">
          <div className="positionStat">
            <span>Selected wallets</span>
            <strong>{shadow.selectedWalletCount || 0}</strong>
          </div>
          <div className="positionStat">
            <span>Scored wallets</span>
            <strong>{shadow.candidatesScoredCount || 0}</strong>
          </div>
          <div className="positionStat">
            <span>Open</span>
            <strong>{metrics.openPositionCount || 0}</strong>
          </div>
          <div className="positionStat">
            <span>Closed</span>
            <strong>{metrics.closedPositionCount || 0}</strong>
          </div>
        </div>
        <div className="shadowCriteria">
          <span>n &gt;= {shadow.criteria?.minResolved ?? 15}</span>
          <span>win &gt;= {pct(shadow.criteria?.minWinRatePct ?? 70)}</span>
          <span>mean edge &gt; 0</span>
          <span>weighted edge &gt; 0</span>
        </div>
        <div className="shadowColumns">
          <section>
            <div className="sectionHead compactHead">
              <div>
                <p className="eyebrow">Positions</p>
                <h2>Hybrid v1 copied trades</h2>
              </div>
            </div>
            <PositionList
              positions={[...(shadow.openPositions || []), ...(shadow.closedPositions || [])].slice(0, 40)}
              expanded
              emptyTitle="No shadow positions yet"
              emptyText="Hybrid v1 will paper-copy future selected-wallet BUY trades here."
            />
          </section>
          <section>
            <div className="sectionHead compactHead">
              <div>
                <p className="eyebrow">Selected wallets</p>
                <h2>Current gate passers</h2>
              </div>
            </div>
            <div className="shadowWalletList">
              {selectedWallets.map((wallet) => (
                <div className="shadowWalletRow" key={wallet.wallet}>
                  <strong>{wallet.displayName || wallet.pseudonym || shortWallet(wallet.wallet)}</strong>
                  <span>{shortWallet(wallet.wallet)}</span>
                  <b>{Number(wallet.winRatePct || 0).toFixed(1)}%</b>
                  <small>{Number(wallet.distinctResolvedTradeCount || 0)} resolved</small>
                </div>
              ))}
              {!selectedWallets.length && <EmptyState title="No selected wallets" text="Hybrid v1 has not selected any wallets yet." />}
            </div>
          </section>
        </div>
      </section>
      <LiveFeed
        events={shadow.feed || []}
        shadowMode
        eyebrow="Shadow tape"
        title="Hybrid v1 trades and copy decisions"
        emptyTitle="Waiting for hybrid v1 trades"
        emptyText="Trades from selected hybrid v1 wallets will appear here."
      />
    </div>
  );
}

function LiveFeed({
  events,
  realMode = false,
  shadowMode = false,
  eyebrow = 'Copy-list tape',
  title = 'Watched trades and copy decisions',
  emptyTitle = 'Waiting for watched-wallet trades',
  emptyText = 'Only trades from the copy list appear here.',
}) {
  const visible = events.slice(0, 40);
  return (
    <section className="panel feedPanel">
      <div className="sectionHead">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h2>{title}</h2>
        </div>
        <ListFilter size={18} />
      </div>
      <div className="feedList">
        {visible.map((event) => (
          <TradeEventRow key={`${event.id}-${event.observedAt}`} event={event} realMode={realMode} shadowMode={shadowMode} />
        ))}
        {!visible.length && <EmptyState title={emptyTitle} text={emptyText} />}
      </div>
    </section>
  );
}

function TradeEventRow({ event, realMode, shadowMode }) {
  const trade = event.trade;
  const decision = shadowMode ? event.shadowDecision : realMode ? event.realDecision : event.copyDecision;
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
  if (source === 'candidate-live') return 'candidate live';
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
  const waitReason = open ? resolutionWaitLabel(position) : null;
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
          {waitReason && <span>{waitReason}</span>}
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

function useCandidateLeaderboard() {
  const [leaderboard, setLeaderboard] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);

  const refresh = React.useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/candidates/leaderboard?limit=100`, { headers: authHeaders() });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Candidate leaderboard failed');
      setLeaderboard(payload);
      setError(null);
    } catch (fetchError) {
      setError(fetchError.message);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return { leaderboard, loading, error, refresh };
}

function CandidatesView({ service, copyPoolState }) {
  const { leaderboard, loading, error, refresh } = useCandidateLeaderboard();
  const [expandedWallet, setExpandedWallet] = React.useState(null);
  const [detailsByWallet, setDetailsByWallet] = React.useState({});
  const [detailLoading, setDetailLoading] = React.useState({});
  const [detailErrors, setDetailErrors] = React.useState({});
  const rows = leaderboard?.rows || [];
  const summary = leaderboard?.summary || {};
  const copyPool = leaderboard?.copyPool?.wallets ? leaderboard.copyPool : copyPoolState || {};
  const enabled = leaderboard?.enabled ?? service?.enabled;

  const loadTraderDetails = React.useCallback(async (wallet, append = false) => {
    const current = detailsByWallet[wallet];
    const offset = append ? current?.trades?.length || 0 : 0;
    setDetailLoading((items) => ({ ...items, [wallet]: true }));
    try {
      const response = await fetch(
        `${API_BASE}/api/candidates/traders/${encodeURIComponent(wallet)}?limit=${CANDIDATE_TRADE_PAGE_SIZE}&offset=${offset}`,
        { headers: authHeaders() }
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Candidate trades failed');
      setDetailsByWallet((items) => ({
        ...items,
        [wallet]: {
          ...payload,
          trades: append ? [...(items[wallet]?.trades || []), ...(payload.trades || [])] : payload.trades || [],
        },
      }));
      setDetailErrors((items) => ({ ...items, [wallet]: null }));
    } catch (detailError) {
      setDetailErrors((items) => ({ ...items, [wallet]: detailError.message }));
    } finally {
      setDetailLoading((items) => ({ ...items, [wallet]: false }));
    }
  }, [detailsByWallet]);

  const toggleCandidate = React.useCallback((wallet) => {
    if (expandedWallet === wallet) {
      setExpandedWallet(null);
      return;
    }
    setExpandedWallet(wallet);
    if (!detailsByWallet[wallet]) loadTraderDetails(wallet, false);
  }, [detailsByWallet, expandedWallet, loadTraderDetails]);

  return (
    <section className="panel fullPanel candidatePanel">
      <div className="sectionHead">
        <div>
          <p className="eyebrow">Candidate discovery</p>
          <h2>$1k-$10k trader leaderboard</h2>
        </div>
        <button className="iconButton" onClick={refresh} aria-label="Refresh candidates"><RefreshCcw size={16} /></button>
      </div>

      {!enabled ? (
        <EmptyState
          title="Candidate tracker disabled"
          text="Set CANDIDATE_TRACKER_ENABLED=true on Railway to start polling, backfilling, and resolving candidate trades."
        />
      ) : error ? (
        <EmptyState title="Candidate leaderboard unavailable" text={error} />
      ) : (
        <>
          <div className="candidateSummary">
            <div className="candidateStat">
              <Users size={17} />
              <span>Traders</span>
              <strong>{summary.traderCount || 0}</strong>
            </div>
            <div className="candidateStat">
              <Database size={17} />
              <span>Tracked trades</span>
              <strong>{summary.tradeCount || 0}</strong>
            </div>
            <div className="candidateStat">
              <Target size={17} />
              <span>Open</span>
              <strong>{summary.openTradeCount || 0}</strong>
            </div>
            <div className="candidateStat">
              <CheckCircle2 size={17} />
              <span>Resolved</span>
              <strong>{summary.resolvedTradeCount || 0}</strong>
            </div>
          </div>

          <div className="candidateToolbar">
            <span className="statusBadge neutral">{candidateStatusLabel(leaderboard?.status || service?.status)}</span>
            <span className="muted">AEP is a rolling 30-day BUY average for visibility only; high-price entries are skipped at execution.</span>
          </div>

          <CopyPoolCards copyPool={copyPool} />

          <div className="candidateList">
            {rows.map((row) => (
              <React.Fragment key={row.wallet}>
                <CandidateRow
                  row={row}
                  copyPoolEntry={copyPool?.wallets?.[String(row.wallet || '').toLowerCase()]}
                  thresholds={copyPool?.thresholds}
                  expanded={expandedWallet === row.wallet}
                  onToggle={() => toggleCandidate(row.wallet)}
                />
                {expandedWallet === row.wallet && (
                  <CandidateTradeDrawer
                    row={row}
                    details={detailsByWallet[row.wallet]}
                    loading={Boolean(detailLoading[row.wallet])}
                    error={detailErrors[row.wallet]}
                    onCollapse={() => setExpandedWallet(null)}
                    onLoadMore={() => loadTraderDetails(row.wallet, true)}
                  />
                )}
              </React.Fragment>
            ))}
            {!rows.length && (
              <EmptyState
                title={loading ? 'Loading candidate traders' : 'No candidate traders yet'}
                text={loading ? 'Fetching the latest leaderboard snapshot.' : 'The tracker will populate this list after it sees qualifying $1k-$10k trades.'}
              />
            )}
          </div>
        </>
      )}
    </section>
  );
}

function CopyPoolCards({ copyPool }) {
  return (
    <div className="copyPoolCards">
      <CopyPoolCard
        title="Recently added"
        icon={UserPlus}
        empty="No automated promotions yet."
        events={copyPool?.recentAdded || []}
        tone="added"
      />
      <CopyPoolCard
        title="Recently removed"
        icon={UserMinus}
        empty="No automated removals yet."
        events={copyPool?.recentRemoved || []}
        tone="removed"
      />
    </div>
  );
}

function CopyPoolCard({ title, icon: Icon, empty, events, tone }) {
  return (
    <section className="copyPoolCard">
      <div className="copyPoolCardHead">
        <Icon size={16} />
        <strong>{title}</strong>
      </div>
      <div className="copyPoolEventList">
        {events.slice(0, 4).map((event) => (
          <div className="copyPoolEvent" key={`${event.id}-${event.createdAt}`}>
            <div>
              <strong>{event.displayName || event.pseudonym || shortWallet(event.wallet)}</strong>
              <span>{shortWallet(event.wallet)} - {formatTimeAgo(event.createdAt)}</span>
            </div>
            {tone === 'added' ? (
              <em>{pct(event.winRatePct)} - {event.distinctResolvedTradeCount || 0} trades - AEP {formatAep(event.avgEntryPriceCents30d)}</em>
            ) : (
              <em title={event.reason}>{event.reason || 'Eligibility dropped'}</em>
            )}
          </div>
        ))}
        {!events.length && <span className="muted">{empty}</span>}
      </div>
    </section>
  );
}

function CandidateRow({ row, copyPoolEntry, thresholds, expanded, onToggle }) {
  const display = row.displayName || row.pseudonym || shortWallet(row.wallet);
  const form = row.recentFormResults || [];
  const ExpandIcon = expanded ? ChevronDown : ChevronRight;
  const badge = copyPoolBadge(copyPoolEntry);
  const eligibility = candidateEligibility(row, copyPoolEntry, thresholds);
  const metrics = row.metrics || {};
  return (
    <article className={`candidateRow ${row.rank <= 3 ? 'topCandidate' : ''} ${expanded ? 'expanded' : ''}`}>
      <button
        className="candidateExpandButton"
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${display} trades`}
        aria-expanded={expanded}
      >
        <ExpandIcon size={16} />
      </button>
      <div className="candidateRank">
        {row.rank === 1 ? <Trophy size={16} /> : <span>{row.rank}</span>}
      </div>
      <div className="avatar">
        {row.profileImage ? <img src={row.profileImage} alt="" /> : <Cpu size={17} />}
      </div>
      <div className="candidateIdentity">
        <div className="candidateNameLine">
          <strong>{display}</strong>
          {badge && <small className={`copyPoolBadge ${badge.tone}`} title={badge.title}>{badge.label}</small>}
        </div>
        <span>{shortWallet(row.wallet)}</span>
      </div>
      <div className="candidateMetric">
        <span>P/L trades</span>
        <strong>{row.allTimePnlTradeCount || 0}</strong>
      </div>
      <div className="candidateMetric">
        <span>WR / PF</span>
        <strong>{pct(row.allTimeWinRatePct)} / {formatProfitFactor(metrics)}</strong>
      </div>
      <div className="candidateMetric" title={`${row.avgEntryTradeCount30d || 0} BUY entries in the last 30 days`}>
        <span>AEP / Med</span>
        <strong>{formatAep(row.avgEntryPriceCents30d)} / {formatNullableCents(metrics.medianEntryCents)}</strong>
      </div>
      <div className="candidateMetric">
        <span>ROI / DD</span>
        <strong className={pnlTone(metrics.roiPct)}>{formatNullableSignedPct(metrics.roiPct)} / {formatDrawdownUsd(metrics.maxDrawdownUsd)}</strong>
      </div>
      <div className="candidateEligibility" title={eligibility.reason}>
        <span>30D eligible</span>
        <strong className={eligibility.tone}>{eligibility.label}</strong>
        <small>{eligibility.meta}</small>
      </div>
      <div className="candidateForm" aria-label="Recent form">
        {form.length ? form.map((result, index) => (
          <span
            key={`${result}-${index}`}
            title={statusLabel(result)}
            className={`formSquare ${result === 'resolved_win' ? 'win' : 'loss'}`}
          />
        )) : <small className="muted">No resolved form</small>}
      </div>
      <div className="candidateProfit">
        <strong className={pnlTone(row.allTimeProfitUsd)}>{compactSignedUsd(row.allTimeProfitUsd || 0)}</strong>
        <span>{row.backfillStatus || 'queued'}</span>
      </div>
    </article>
  );
}

function CandidateTradeDrawer({ row, details, loading, error, onCollapse, onLoadMore }) {
  const trades = details?.trades || [];
  const total = details?.totalTrackedTradeCount ?? row.allTrackedTradeCount ?? trades.length;
  const hasMore = trades.length < total;

  return (
    <div className="candidateTradeDrawer">
      <div className="candidateTradeHead">
        <div>
          <strong>{trades.length ? `${trades.length} of ${total} tracked trades` : 'Tracked trades'}</strong>
          <span>Candidate range only: $1k-$10k entries and exits</span>
        </div>
        <button className="textButton candidateCollapseButton" onClick={onCollapse}>
          Collapse
        </button>
      </div>
      <CandidateMetricsSummary metrics={row.metrics || {}} />
      {error ? (
        <div className="candidateTradeMessage negative">{error}</div>
      ) : loading && !trades.length ? (
        <div className="candidateTradeMessage">Loading trader history...</div>
      ) : trades.length ? (
        <>
          <div className="candidateTradeRows">
            {trades.map((trade) => <CandidateTradeRow key={trade.id} trade={trade} />)}
          </div>
          {hasMore && (
            <button className="textButton candidateLoadMore" onClick={onLoadMore} disabled={loading}>
              {loading ? 'Loading...' : 'Load more trades'}
            </button>
          )}
        </>
      ) : (
        <div className="candidateTradeMessage">No tracked trades stored for this trader yet.</div>
      )}
    </div>
  );
}

function CandidateMetricsSummary({ metrics }) {
  const items = [
    { label: 'ROI', value: formatNullableSignedPct(metrics.roiPct), tone: pnlTone(metrics.roiPct) },
    { label: 'Profit factor', value: formatProfitFactor(metrics) },
    { label: 'Max drawdown', value: formatDrawdownUsd(metrics.maxDrawdownUsd), tone: metrics.maxDrawdownUsd < 0 ? 'negative' : 'neutral' },
    { label: 'Avg size', value: formatNullableCompactUsd(metrics.avgTradeSizeUsd) },
    { label: 'Avg W/L', value: `${formatNullableSignedCompactUsd(metrics.avgWinUsd)} / ${formatNullableSignedCompactUsd(metrics.avgLossUsd)}` },
    { label: 'Median entry', value: formatNullableCents(metrics.medianEntryCents) },
    { label: '7D', value: `${metrics.recent7dTradeCount || 0} trades / ${formatNullablePct(metrics.recent7dWinRatePct)}` },
    { label: '14D', value: `${metrics.recent14dTradeCount || 0} trades / ${formatNullablePct(metrics.recent14dWinRatePct)}` },
    { label: 'Top win share', value: formatNullablePct(metrics.topWinSharePct) },
  ];

  return (
    <div className="candidateMetricsSummary">
      {items.map((item) => (
        <div className="candidateMetricTile" key={item.label}>
          <span>{item.label}</span>
          <strong className={item.tone || ''}>{item.value}</strong>
        </div>
      ))}
    </div>
  );
}

function CandidateTradeRow({ trade }) {
  const pnlDisplay = candidateTradePnlDisplay(trade);
  return (
    <article className="candidateTradeRow">
      <div className="candidateTradeMarket">
        <strong>{trade.marketTitle || 'Unknown market'}</strong>
        <span>{trade.side} {trade.outcome} - {formatTimeAgo(trade.tradeTimestamp)} - {trade.source}</span>
      </div>
      <div className="candidateTradeCell">
        <span>Entry</span>
        <strong>{formatTradeEntry(trade)}</strong>
      </div>
      <div className="candidateTradeCell">
        <span>Size</span>
        <strong>{usd(trade.usdSize)}</strong>
      </div>
      <div className="candidateTradeCell">
        <span>Status</span>
        <strong className={statusTone(trade.status)}>{statusLabel(trade.status)}</strong>
      </div>
      <div className="candidateTradeCell">
        <span>P/L</span>
        <strong className={pnlDisplay.tone}>{pnlDisplay.label}</strong>
      </div>
      {trade.polymarketUrl && (
        <a className="iconButton" href={trade.polymarketUrl} target="_blank" rel="noreferrer" aria-label="Open market">
          <ExternalLink size={15} />
        </a>
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
        equityUsd: 1000,
        cashUsd: 1000,
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
    shadowTrader: {
      enabled: true,
      strategy: 'hybrid_gate_v1',
      label: 'Hybrid v1 shadow',
      status: 'starting',
      criteria: {
        minResolved: 15,
        minWinRatePct: 70,
        maxAvgEntryPriceCents: 75,
        minMeanEdge: 0,
        minUsdWeightedEdge: 0,
      },
      selectedWallets: {},
      selectedWalletCount: 0,
      candidatesScoredCount: 0,
      lastEvaluatedAt: null,
      metrics: {
        equityUsd: 1000,
        cashUsd: 1000,
        totalPnlUsd: 0,
        realizedPnlUsd: 0,
        unrealizedPnlUsd: 0,
        copiedCount: 0,
        openPositionCount: 0,
        closedPositionCount: 0,
        totalNotionalCopiedUsd: 0,
        knownEntryFeesUsd: 0,
        feeUnknownCount: 0,
        maxEntryPriceCents: 75,
      },
      openPositions: [],
      closedPositions: [],
      decisions: [],
      feed: [],
    },
    real: {},
    copyPool: {
      wallets: {},
      recentAdded: [],
      recentRemoved: [],
      counts: {},
    },
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

function compactSignedUsd(value) {
  const number = Number(value || 0);
  const prefix = number >= 0 ? '+' : '-';
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(Math.abs(number));
  return `${prefix}${formatted}`;
}

function compactUsd(value) {
  const number = Number(value || 0);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(number);
}

function formatAep(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'n/a';
  return `${number.toFixed(1)}c`;
}

function formatNullableCents(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return EMPTY_METRIC;
  return `${number.toFixed(1)}c`;
}

function formatTradeEntry(trade) {
  const price = Number(trade?.price);
  if (!Number.isFinite(price)) return 'n/a';
  return `${(price * 100).toFixed(1)}c`;
}

function formatProfitFactor(metrics = {}) {
  if (metrics.profitFactorDisplayCapHit) return '>5.0x';
  const number = Number(metrics.profitFactor);
  if (!Number.isFinite(number)) return EMPTY_METRIC;
  return `${number.toFixed(number >= 10 ? 1 : 2)}x`;
}

function formatNullablePct(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return EMPTY_METRIC;
  return `${number.toFixed(number >= 99 ? 0 : 1)}%`;
}

function formatNullableSignedPct(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return EMPTY_METRIC;
  const prefix = number >= 0 ? '+' : '';
  return `${prefix}${number.toFixed(1)}%`;
}

function formatNullableCompactUsd(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return EMPTY_METRIC;
  return compactUsd(number);
}

function formatNullableSignedCompactUsd(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return EMPTY_METRIC;
  return compactSignedUsd(number);
}

function formatDrawdownUsd(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return EMPTY_METRIC;
  if (Math.abs(number) < 0.005) return '$0';
  return compactSignedUsd(number);
}

function copyPoolBadge(entry) {
  if (!entry || entry.status !== 'active') return null;
  if (entry.protected) return { label: 'Following', tone: 'protected', title: 'Protected baseline wallet is being copied' };
  return { label: 'Following', tone: 'following', title: 'Auto-added trader is being copied' };
}

function candidateEligibility(row, entry, thresholds = {}) {
  const minDistinct = Number(thresholds?.minDistinctResolvedMarkets || 15);
  const minWinRate = Number(thresholds?.minWinRatePct || 75);
  const distinct = Number(entry?.distinctResolvedTradeCount ?? row.resolvedDistinctTradeCount30d);
  const winRate = Number(entry?.winRatePct ?? row.winRatePctDistinct30d);
  const aep = Number(entry?.avgEntryPriceCents30d ?? row.avgEntryPriceCents30d);
  const hasPoolMetrics = Number.isFinite(distinct) || Number.isFinite(winRate);
  if (!hasPoolMetrics) {
    return {
      label: 'Pending',
      tone: 'neutral',
      meta: `AEP ${formatAep(row.avgEntryPriceCents30d)}`,
      reason: 'Copy-pool evaluator has not persisted 30-day distinct metrics for this trader yet.',
    };
  }

  const status = String(entry?.status || '').toLowerCase();
  const reason = entry?.reason || eligibilityReason({ distinct, winRate }, { minDistinct, minWinRate });
  const eligible = distinct >= minDistinct && Number.isFinite(winRate) && winRate >= minWinRate;
  return {
    label: status === 'active' ? 'Pass' : eligible ? 'Pass' : 'No',
    tone: status === 'active' || eligible ? 'positive' : 'negative',
    meta: `${distinct || 0}/${minDistinct} distinct - ${pct(winRate)} WR - AEP ${formatAep(aep)}`,
    reason,
  };
}

function eligibilityReason(metrics, thresholds) {
  if (!Number.isFinite(metrics.distinct) || metrics.distinct < thresholds.minDistinct) {
    return `Needs ${thresholds.minDistinct} resolved distinct BUY markets in the last 30 days.`;
  }
  if (!Number.isFinite(metrics.winRate) || metrics.winRate < thresholds.minWinRate) {
    return `30-day distinct win rate is below ${thresholds.minWinRate.toFixed(1)}%.`;
  }
  return 'Eligible for automated following. AEP is display-only; individual entries above the max copy price are still skipped.';
}

function candidateTradePnlDisplay(trade) {
  const pnl = trade?.pnlUsd === null || trade?.pnlUsd === undefined ? null : Number(trade.pnlUsd);
  if (Number.isFinite(pnl)) return { label: signedUsd(pnl), tone: pnlTone(pnl) };
  if (String(trade?.status || '').toLowerCase() === 'open') return { label: 'pending', tone: 'neutral' };
  if (String(trade?.side || '').toUpperCase() === 'SELL') return { label: 'not scored', tone: 'neutral' };
  return { label: 'unscored', tone: 'neutral' };
}

function candidateStatusLabel(status) {
  const value = String(status || 'disabled');
  if (value === 'ready') return 'tracking';
  if (value === 'polling') return 'polling Data API';
  if (value === 'backfilling') return 'backfilling profiles';
  if (value === 'resolving') return 'resolving markets';
  return value.replace(/_/g, ' ');
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

function resolutionWaitLabel(position) {
  const code = String(position?.resolutionDiagnostic || '').trim();
  if (code === 'whale_fetch_failed') return 'whale fetch failed; using Gamma';
  if (code === 'gamma_open') return 'Gamma open';
  if (code === 'gamma_proposed') return 'Gamma proposed';
  if (code === 'gamma_near_final_open') return 'near-final; waiting close';
  if (code === 'gamma_closed_no_winner') return 'Gamma closed; awaiting winner';
  if (code === 'gamma_resolution_failed') return 'Gamma check failed';
  return null;
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
