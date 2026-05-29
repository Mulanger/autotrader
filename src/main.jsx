import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
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
import AutotraderMobile from './components/AutotraderMobile.jsx';
import './styles.css';
import './styles/autotrader-mobile.css';

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
  const [mode, setMode] = React.useState('real');
  const [tab, setTab] = React.useState('overview');

  React.useEffect(() => {
    if (mode === 'real' && !['overview', 'following', 'real-traders', 'positions', 'orders'].includes(tab)) setTab('overview');
  }, [mode, tab]);

  const data = state || emptyState();
  const metrics = data.demo.metrics;

  return (
    <main className={`shell ${mode === 'real' ? 'realMode' : 'demoMode'}`}>
        <Sidebar
          mode={mode}
          setMode={setMode}
          connected={connected}
          service={data.service}
          real={data.real}
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
          real={data.real}
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

function Sidebar({ mode, setMode, connected, service, real, metrics, watchedWalletCount }) {
  const realRuntime = real?.runtime || null;
  const realWorkerOnline = isRuntimeOnline(realRuntime);
  const realStatus = realRuntime?.status || service?.real?.status || 'disabled';
  const realMode = realRuntime?.mode || service?.real?.mode || 'dry_run';
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
        <StatusLine
          active={realWorkerOnline && ['ready', 'polling'].includes(realStatus)}
          label={realRuntime?.role === 'worker'
            ? `Real worker ${realMode === 'live' ? 'live' : 'dry-run'} ${realStatus}`
            : `Real dashboard ${realStatus}`}
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

function Topbar({ mode, tab, setTab, refresh, service, real }) {
  const tabs = mode === 'demo' ? ['overview', 'shadow', 'profit', 'positions', 'traders', 'candidates'] : ['overview', 'following', 'real-traders', 'positions', 'orders'];
  const runtime = mode === 'real' ? real?.runtime || null : null;
  const lastPollAt = mode === 'real' ? runtime?.lastPollAt || service?.real?.lastPollAt : service?.pollLastRunAt;
  const realLiveRequested = runtime
    ? String(runtime.mode || '').toLowerCase() === 'live' && Boolean(runtime.liveExecutionEnabled)
    : service?.real?.mode === 'live' && service?.real?.liveExecutionEnabled;
  const realLiveReady = realLiveRequested && (runtime?.liveExecutionReady ?? service?.real?.liveExecutionReady);
  const realEyebrow = realLiveReady
    ? 'Live execution enabled'
    : realLiveRequested
      ? 'Live execution blocked'
      : isRealDryRunMode(real)
        ? 'Dry-run execution'
        : 'Worker snapshot unavailable';
  return (
    <header className="topbar">
      <div>
        <p className="eyebrow">{mode === 'demo' ? 'Simulated execution' : realEyebrow}</p>
        <h1>{mode === 'demo' ? 'Demo copy trading dashboard' : 'Real trading control room'}</h1>
      </div>
      <nav className="tabs" aria-label="Dashboard views">
        {tabs.map((item) => (
          <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>
            {tabLabel(item)}
          </button>
        ))}
      </nav>
      <div className="topActions">
        <span className="lastSync">Last poll {formatTimeAgo(lastPollAt)}</span>
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

function RealWorkspace({ tab }) {
  const realState = useRealState();
  const real = realState.real;

  if (realState.error) {
    return (
      <section className="panel fullPanel realAuthPanel">
        <div className="lockPlate"><Lock size={22} /></div>
        <p className="eyebrow">Real dashboard</p>
        <h2>Real controls are locked</h2>
        <p>{realState.error}</p>
        <div className="adapterList">
          <StatusLine active={false} label="DASHBOARD_AUTH_TOKEN required for real routes" />
          <StatusLine active label="Demo dashboard remains separate" />
        </div>
      </section>
    );
  }

  if (realState.loading || !real) {
    return <section className="panel fullPanel"><EmptyState title="Loading real dashboard" text="Fetching real follow state." /></section>;
  }

  let desktopView = <RealOverview real={real} />;
  if (tab === 'following') desktopView = <RealFollowingView real={real} realState={realState} />;
  if (tab === 'real-traders') desktopView = <RealScoredTradersView realState={realState} />;
  if (tab === 'positions') desktopView = <RealPositionsView real={real} />;
  if (tab === 'orders') desktopView = <RealOrdersView real={real} />;

  return (
    <>
      <AutotraderMobile real={real} />
      <div className="realDesktopWorkspace">{desktopView}</div>
    </>
  );
}

function tabLabel(tab) {
  if (tab === 'real-traders') return 'scored traders';
  return tab;
}

function RealOverview({ real }) {
  const summary = real.summary || {};
  const live = isLiveRealMode(real);
  const activeFollows = (real.follows || []).filter((follow) => follow.status === 'active');
  const openPositions = (real.positions || []).filter((position) => isOpenPosition(position));
  return (
    <div className="realControlRoom">
      <RealAccountSurface real={real} />
      <RealMetricStrip summary={summary} real={real} />
      <div className="realOverviewGrid">
        <RealRiskPanel real={real} />
        <section className="panel realOrdersPanel realOverviewOrders">
          <div className="sectionHead">
            <div>
              <p className="eyebrow">Order audit</p>
              <h2>{live ? 'Live order stream' : isRealDryRunMode(real) ? 'Dry-run order stream' : 'Real order stream'}</h2>
            </div>
            <ListFilter size={18} />
          </div>
          <RealOrdersList orders={(real.orders || []).slice(0, 8)} compact live={live} dryRun={isRealDryRunMode(real)} />
        </section>
        <section className="panel realFollowPanel">
          <div className="sectionHead">
            <div>
              <p className="eyebrow">Following</p>
              <h2>Active copy list</h2>
            </div>
            <Users size={18} />
          </div>
          <RealFollowList follows={activeFollows.slice(0, 6)} compact />
        </section>
        <RealPositionsPreview real={real} positions={openPositions} />
      </div>
    </div>
  );
}

function RealAccountSurface({ real }) {
  const runtime = real.runtime || {};
  const account = real.account || {};
  const service = real.service || {};
  const live = isLiveRealMode(real);
  const workerOnline = isRuntimeOnline(runtime);
  const readiness = runtime.liveExecutionReady ?? service.liveExecutionReady;
  const lastError = runtime.lastError || account.lastError || service.lastError;
  const allowance = accountAllowanceHealth(account);
  const balance = account?.collateral?.walletBalanceUsd ?? account?.collateral?.balanceUsd;
  const balanceMeta = account?.collateral?.walletBalanceUsd !== null && account?.collateral?.walletBalanceUsd !== undefined
    ? `pUSD wallet, synced ${formatTimeAgo(account.checkedAt)}`
    : account.checkedAt
      ? `CLOB cache, synced ${formatTimeAgo(account.checkedAt)}`
      : 'not synced yet';
  const workerLabel = runtime.heartbeatAt
    ? `${formatTimeAgo(runtime.heartbeatAt)} heartbeat`
    : 'no worker heartbeat';
  return (
    <section className="realAccountSurface">
      <div className="realAccountLead">
        <p className="eyebrow">Polymarket account</p>
        <h2>{live ? 'Live trading control room' : isRealDryRunMode(real) ? 'Real dry-run control room' : 'Real trading control room'}</h2>
        <p>
          {runtime.role === 'worker'
            ? `Snapshot from the local PC worker, ${workerLabel}.`
            : 'Waiting for the local PC worker snapshot.'}
        </p>
      </div>
      <div className="realStatusCluster">
        <RealStatusPill active={workerOnline} label={workerOnline ? 'PC worker online' : 'PC worker offline'} icon={Activity} />
        <RealStatusPill active={Boolean(readiness)} label={readiness ? 'Ready for live orders' : 'Live orders blocked'} icon={ShieldCheck} />
        <RealStatusPill active={account.ok !== false && Boolean(account.signerAddress)} label={account.signerAddress ? 'Signer loaded' : 'Signer unknown'} icon={Lock} />
      </div>
      <div className="realAccountGrid">
        <RealAccountField label="Available balance" value={formatAccountUsd(balance)} meta={balanceMeta} />
        <RealAccountField label="Funder wallet" value={shortWallet(account.funderAddress)} meta="deposit wallet" />
        <RealAccountField label="Signer wallet" value={shortWallet(account.signerAddress)} meta="order signer" />
        <RealAccountField label="Allowance" value={allowance.label} meta={allowance.meta} tone={allowance.tone} />
        <RealAccountField label="Chain" value={account.chainId ? `Polygon ${account.chainId}` : 'unknown'} meta={account.clobHost || 'CLOB host unknown'} />
        <RealAccountField label="Signature" value={account.signatureType === null || account.signatureType === undefined ? 'unknown' : `type ${account.signatureType}`} meta={account.builderCodeConfigured ? 'builder code enabled' : 'no builder code'} />
      </div>
      {lastError && (
        <div className="realAccountAlert">
          <AlertTriangle size={16} />
          <span>{lastError}</span>
        </div>
      )}
    </section>
  );
}

function RealStatusPill({ active, label, icon: Icon }) {
  return (
    <span className={`realStatusPill ${active ? 'positive' : 'negative'}`}>
      <Icon size={14} />
      {label}
    </span>
  );
}

function RealAccountField({ label, value, meta, tone }) {
  return (
    <div className="realAccountField">
      <span>{label}</span>
      <strong className={tone || ''}>{value || 'unknown'}</strong>
      <small>{meta || EMPTY_METRIC}</small>
    </div>
  );
}

function RealRiskPanel({ real }) {
  const runtimePayload = real.runtime?.payload || {};
  const service = real.service || {};
  const stakeUsd = runtimePayload.stakeUsd ?? service.stakeUsd ?? 10;
  const maxEntry = runtimePayload.maxEntryPriceCents ?? service.maxEntryPriceCents ?? 75;
  const guard = runtimePayload.priceGuardCents ?? service.priceGuardCents ?? 4;
  const maxAge = runtimePayload.maxSourceTradeAgeSeconds ?? service.maxSourceTradeAgeSeconds ?? 30;
  return (
    <section className="panel realRiskPanel">
      <div className="sectionHead">
        <div>
          <p className="eyebrow">Risk rules</p>
          <h2>Copy guardrails</h2>
        </div>
        <ShieldCheck size={18} />
      </div>
      <div className="realRiskGrid">
        <RealMiniStat label="Stake" value={usd(stakeUsd)} />
        <RealMiniStat label="Max entry" value={formatCents(maxEntry)} />
        <RealMiniStat label="Price guard" value={`+${Number(guard).toFixed(1)}c`} />
        <RealMiniStat label="Source age" value={`${Number(maxAge)}s`} />
      </div>
      <div className="adapterList compactRules">
        <StatusLine active label="Manual real follow list only" />
        <StatusLine active label="One copied position per market" />
        <StatusLine active label="Duplicate source trades ignored" />
        <StatusLine active label="FOK order must fully fill" />
      </div>
    </section>
  );
}

function RealPositionsPreview({ real, positions }) {
  const live = isLiveRealMode(real);
  return (
    <section className="panel realPositionsPreview">
      <div className="sectionHead">
        <div>
          <p className="eyebrow">Positions</p>
          <h2>{live ? 'Open live exposure' : 'Open real exposure'}</h2>
        </div>
        <Layers3 size={18} />
      </div>
      <PositionList
        positions={positions.slice(0, 6)}
        emptyTitle={live ? 'No open live positions' : 'No open real positions'}
        emptyText="Approved copied entries will appear here after a FOK fill is recorded."
      />
    </section>
  );
}

function RealMetricStrip({ summary, real }) {
  const live = isLiveRealMode(real);
  const dryRun = isRealDryRunMode(real);
  const items = [
    { label: live ? 'Live P/L' : dryRun ? 'Dry-run P/L' : 'Real P/L', value: signedUsd(summary.totalPnlUsd || 0), icon: LineChart, tone: pnlTone(summary.totalPnlUsd) },
    { label: 'Open value', value: usd(summary.openValueUsd || 0), icon: Wallet },
    { label: 'Attempts', value: summary.attemptedCount || 0, icon: Activity },
    { label: live ? 'Filled' : 'Would fill', value: summary.wouldFillCount || 0, icon: CheckCircle2, tone: 'positive' },
    { label: 'Rejected', value: summary.rejectedCount || 0, icon: AlertTriangle, tone: summary.rejectedCount ? 'negative' : 'neutral' },
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

function RealScoredTradersView({ realState }) {
  const [tier, setTier] = React.useState('all');
  const [eligibleOnly, setEligibleOnly] = React.useState(true);
  const [sort, setSort] = React.useState('score');
  const [query, setQuery] = React.useState('');
  const [pinRequest, setPinRequest] = React.useState(null);
  const [actionError, setActionError] = React.useState(null);
  const [pendingWallet, setPendingWallet] = React.useState(null);
  const quality = useRealCopyQuality({ tier, eligibleOnly, sort, query });
  const rows = quality.payload?.rows || [];
  const summary = quality.payload?.summary || {};
  const cachedScores = Boolean(quality.payload?.cached);

  const requestRealAdd = React.useCallback((row) => {
    setActionError(null);
    setPinRequest({
      title: 'Add real follow',
      description: `${row.displayName || row.pseudonym || shortWallet(row.wallet)} will be tracked by the Real engine from now on.`,
      confirmLabel: 'Add',
      onSubmit: async (pin) => {
        setPendingWallet(row.wallet);
        try {
          const response = await fetch(`${API_BASE}/api/real/follow`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({
              pin,
              wallet: row.wallet,
              displayName: row.displayName,
              pseudonym: row.pseudonym,
              profileImage: row.profileImage,
            }),
          });
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error || 'Real follow failed');
          realState.setReal(payload.real);
          await quality.refresh();
          setPinRequest(null);
        } catch (submitError) {
          setActionError(submitError.message);
        } finally {
          setPendingWallet(null);
        }
      },
    });
  }, [quality, realState]);

  const requestRealRemove = React.useCallback((row) => {
    setActionError(null);
    setPinRequest({
      title: 'Remove real follow',
      description: `${row.displayName || row.pseudonym || shortWallet(row.wallet)} will stop being tracked for new real entries.`,
      confirmLabel: 'Remove',
      onSubmit: async (pin) => {
        setPendingWallet(row.wallet);
        try {
          const response = await fetch(`${API_BASE}/api/real/unfollow`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ pin, wallet: row.wallet }),
          });
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error || 'Real remove failed');
          realState.setReal(payload.real);
          await quality.refresh();
          setPinRequest(null);
        } catch (submitError) {
          setActionError(submitError.message);
        } finally {
          setPendingWallet(null);
        }
      },
    });
  }, [quality, realState]);

  const requestRecalculate = React.useCallback(() => {
    setActionError(null);
    setPinRequest({
      title: 'Recalculate copy quality',
      description: 'Scores will refresh from the latest resolved candidate history and active copy-pool wallets.',
      confirmLabel: 'Recalculate',
      onSubmit: async (pin) => {
        setPendingWallet('__recalculate__');
        try {
          const response = await fetch(`${API_BASE}/api/real/copy-quality/recalculate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ pin, scope: 'active_copy_pool' }),
          });
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error || 'Recalculate failed');
          await quality.refresh();
          setPinRequest(null);
        } catch (submitError) {
          setActionError(submitError.message);
        } finally {
          setPendingWallet(null);
        }
      },
    });
  }, [quality]);

  return (
    <section className="panel fullPanel realScoredPanel">
      <div className="sectionHead">
        <div>
          <p className="eyebrow">Copy quality</p>
          <h2>Scored real candidates</h2>
        </div>
        <div className="sectionActions">
          <button className="textButton" onClick={requestRecalculate} disabled={cachedScores || pendingWallet === '__recalculate__'}>
            <RefreshCcw size={14} /> {pendingWallet === '__recalculate__' ? 'Scoring' : 'Recalculate'}
          </button>
          <button className="iconButton" onClick={quality.refresh} aria-label="Refresh scored traders"><RefreshCcw size={16} /></button>
        </div>
      </div>

      <p className="panelCopy">
        {cachedScores
          ? 'Candidate tracking is disabled. Showing the last saved Copy Quality scores without running polling, backfill, or resolution workers.'
          : 'Copy Quality ranks wallets by how suitable they are for this copier, not by raw trader leaderboard performance.'}
      </p>

      <div className="candidateSummary">
        <CopyQualityStat icon={Users} label="Scored" value={summary.scored || 0} />
        <CopyQualityStat icon={ShieldCheck} label="Eligible" value={summary.eligible || 0} />
        <CopyQualityStat icon={Trophy} label="Core" value={summary.core || 0} />
        <CopyQualityStat icon={Eye} label="Watchlist" value={summary.watchlist || 0} />
        <CopyQualityStat icon={Clock3} label="Last scored" value={formatTimeAgo(summary.lastScoredAt)} />
      </div>

      <div className="candidateToolbar realQualityToolbar">
        <label>
          <span>Tier</span>
          <select value={tier} onChange={(event) => setTier(event.target.value)}>
            <option value="all">all</option>
            <option value="core">core</option>
            <option value="candidate">candidate</option>
            <option value="watchlist">watchlist</option>
            <option value="manual_review">manual review</option>
            <option value="ignore">ignore</option>
          </select>
        </label>
        <label>
          <span>Sort</span>
          <select value={sort} onChange={(event) => setSort(event.target.value)}>
            <option value="score">score</option>
            <option value="edge">copy edge</option>
            <option value="entry">entry</option>
            <option value="profit">profit</option>
            <option value="drawdown">drawdown</option>
            <option value="updated">updated</option>
          </select>
        </label>
        <label className="toggleLine">
          <input type="checkbox" checked={eligibleOnly} onChange={(event) => setEligibleOnly(event.target.checked)} />
          <span>Eligible only</span>
        </label>
        <input
          className="searchInput"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search wallet or name"
          aria-label="Search scored traders"
        />
        {cachedScores && <span className="statusBadge neutral">cached</span>}
        {actionError && <span className="negative">{actionError}</span>}
      </div>

      {quality.error ? (
        <EmptyState title="Copy quality unavailable" text={quality.error} />
      ) : (
        <div className="candidateList realQualityList">
          {rows.map((row) => (
            <RealScoredTraderRow
              key={row.wallet}
              row={row}
              onAdd={() => requestRealAdd(row)}
              onRemove={() => requestRealRemove(row)}
              pending={pendingWallet === row.wallet}
            />
          ))}
          {!rows.length && (
            <EmptyState
              title={quality.loading ? 'Loading scored traders' : 'No scored traders'}
              text={quality.loading ? 'Fetching copy quality scores.' : cachedScores ? 'No cached Copy Quality scores were found in storage.' : 'Run scoring after candidate backfill has resolved trade history.'}
            />
          )}
        </div>
      )}

      <PinPromptModal
        request={pinRequest}
        error={actionError}
        pending={Boolean(pendingWallet)}
        onCancel={() => {
          setPinRequest(null);
          setActionError(null);
        }}
      />
    </section>
  );
}

function CopyQualityStat({ icon: Icon, label, value }) {
  return (
    <div className="candidateStat">
      <Icon size={17} />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function RealScoredTraderRow({ row, onAdd, onRemove, pending }) {
  const display = row.displayName || row.pseudonym || shortWallet(row.wallet);
  const active = row.realFollowStatus === 'active';
  return (
    <article className={`candidateRow realQualityRow ${row.eligible ? 'eligible' : 'ineligible'}`}>
      <div className="candidateRank scoreRank">
        <span>{Math.round(row.score || 0)}</span>
      </div>
      <div className="avatar">
        {row.profileImage ? <img src={row.profileImage} alt="" /> : <Cpu size={17} />}
      </div>
      <div className="candidateIdentity">
        <div className="candidateNameLine">
          <strong>{display}</strong>
          <small className={`copyPoolBadge ${copyQualityTierTone(row.tier)}`} title={row.reason || row.explanation}>
            {copyQualityTierLabel(row.tier)}
          </small>
        </div>
        <span>{shortWallet(row.wallet)}</span>
        <small className="qualityExplanation">{row.explanation || row.reason}</small>
      </div>
      <div className="candidateMetric">
        <span>Edge / Med</span>
        <strong className={pnlTone(row.conservativeCopyEdgePct)}>
          {formatNullableSignedPct(row.conservativeCopyEdgePct)} / {formatNullableCents(row.medianEntryCents30d)}
        </strong>
      </div>
      <div className="candidateMetric">
        <span>PF / ROI</span>
        <strong>{formatPlainProfitFactor(row.profitFactor30d)} / {formatNullableSignedPct(row.roiPct30d)}</strong>
      </div>
      <div className="candidateMetric">
        <span>Markets / Trades</span>
        <strong>{row.distinctResolvedMarkets30d || 0} / {row.pnlTradeCount30d || 0}</strong>
      </div>
      <div className="candidateMetric">
        <span>Win / Top win</span>
        <strong>{formatNullablePct(row.winRatePct30d)} / {formatNullablePct(row.topWinSharePct30d)}</strong>
      </div>
      <div className="candidateMetric">
        <span>Profit / DD</span>
        <strong className={pnlTone(row.profitUsd30d)}>
          {formatNullableSignedCompactUsd(row.profitUsd30d)} / {formatDrawdownUsd(row.maxDrawdownUsd30d)}
        </strong>
      </div>
      <div className="qualityFlags">
        {(row.flags || []).slice(0, 3).map((flag) => <span key={flag}>{flagLabel(flag)}</span>)}
        {!(row.flags || []).length && <span>clean</span>}
      </div>
      <div className="candidateRealAction">
        {active ? (
          <button className="textButton realRemoveButton" onClick={onRemove} disabled={pending}>
            <UserMinus size={14} /> {pending ? 'Removing' : 'Remove'}
          </button>
        ) : (
          <button className="textButton realAddButton" onClick={onAdd} disabled={pending}>
            <UserPlus size={14} /> {pending ? 'Adding' : 'Add'}
          </button>
        )}
      </div>
    </article>
  );
}

function RealFollowingView({ real, realState }) {
  const [pinRequest, setPinRequest] = React.useState(null);
  const [actionError, setActionError] = React.useState(null);
  const [pendingWallet, setPendingWallet] = React.useState(null);

  const requestRemove = React.useCallback((follow) => {
    setActionError(null);
    setPinRequest({
      title: 'Remove real follow',
      description: `${follow.displayName || follow.pseudonym || shortWallet(follow.wallet)} will stop being tracked for new real entries.`,
      confirmLabel: 'Remove',
      onSubmit: async (pin) => {
        setPendingWallet(follow.wallet);
        try {
          const response = await fetch(`${API_BASE}/api/real/unfollow`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ wallet: follow.wallet, pin }),
          });
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error || 'Real remove failed');
          realState.setReal(payload.real);
          setPinRequest(null);
        } catch (submitError) {
          setActionError(submitError.message);
        } finally {
          setPendingWallet(null);
        }
      },
    });
  }, [realState]);

  return (
    <section className="panel fullPanel realFollowPanel">
      <div className="sectionHead">
        <div>
          <p className="eyebrow">Real follows</p>
          <h2>Manual copy list</h2>
        </div>
        <button className="iconButton" onClick={realState.refresh} aria-label="Refresh real follows"><RefreshCcw size={16} /></button>
      </div>
      {actionError && <div className="candidateTradeMessage negative">{actionError}</div>}
      <RealFollowList follows={real.follows || []} onRemove={requestRemove} pendingWallet={pendingWallet} />
      <PinPromptModal
        request={pinRequest}
        error={actionError}
        pending={Boolean(pendingWallet)}
        onCancel={() => {
          setPinRequest(null);
          setActionError(null);
        }}
      />
    </section>
  );
}

function RealFollowList({ follows, compact = false, onRemove, pendingWallet }) {
  if (!follows.length) {
    return <EmptyState title="No real follows yet" text="Use Add on a candidate row to start tracking from that moment forward." />;
  }
  return (
    <div className={compact ? 'realFollowList compact' : 'realFollowList'}>
      {follows.map((follow) => (
        <RealFollowRow
          key={follow.wallet}
          follow={follow}
          compact={compact}
          onRemove={onRemove}
          pending={pendingWallet === follow.wallet}
        />
      ))}
    </div>
  );
}

function RealFollowRow({ follow, compact, onRemove, pending }) {
  const metrics = follow.metrics || {};
  const active = follow.status === 'active';
  return (
    <article className="realFollowRow">
      <div className="avatar">
        {follow.profileImage ? <img src={follow.profileImage} alt="" /> : <Cpu size={17} />}
      </div>
      <div className="realFollowIdentity">
        <strong>{follow.displayName || follow.pseudonym || shortWallet(follow.wallet)}</strong>
        <span>{shortWallet(follow.wallet)} - {active ? `added ${formatTimeAgo(follow.addedAt)}` : `removed ${formatTimeAgo(follow.removedAt)}`}</span>
      </div>
      {!compact && (
        <>
          <RealMiniStat label="P/L" value={signedUsd(metrics.totalPnlUsd || 0)} tone={pnlTone(metrics.totalPnlUsd)} />
          <RealMiniStat label="Fill rate" value={formatNullablePct(metrics.fillRatePct)} />
          <RealMiniStat label="Attempts" value={`${metrics.wouldFillCount || 0}/${metrics.attemptedCount || 0}`} />
          <RealMiniStat label="Avg slip" value={formatNullableCents(metrics.avgSlippageCents)} tone={pnlTone(-Number(metrics.avgSlippageCents || 0))} />
          <RealMiniStat label="Open" value={usd(metrics.openValueUsd || 0)} />
        </>
      )}
      {active && onRemove && (
        <button className="textButton realRemoveButton" onClick={() => onRemove(follow)} disabled={pending}>
          <UserMinus size={14} /> {pending ? 'Removing' : 'Remove'}
        </button>
      )}
      {!active && <span className="statusBadge neutral">removed</span>}
    </article>
  );
}

function RealMiniStat({ label, value, tone }) {
  return (
    <div className="realMiniStat">
      <span>{label}</span>
      <strong className={tone || ''}>{value}</strong>
    </div>
  );
}

function RealPositionsView({ real }) {
  const positions = real.positions || [];
  const open = positions.filter((position) => isOpenPosition(position));
  const closed = positions.filter((position) => !isOpenPosition(position));
  const live = isLiveRealMode(real);
  const dryRun = isRealDryRunMode(real);
  return (
    <section className="panel fullPanel positionsWorkspace">
      <div className="sectionHead">
        <div>
          <p className="eyebrow">{live ? 'Live positions' : dryRun ? 'Real dry-run positions' : 'Real positions'}</p>
          <h2>{live ? 'Since-added live fills' : dryRun ? 'Since-added simulated fills' : 'Since-added fills'}</h2>
        </div>
        <Layers3 size={18} />
      </div>
      <div className="positionSummary">
        <div className="positionStat"><span>Open</span><strong>{open.length}</strong></div>
        <div className="positionStat"><span>Closed</span><strong>{closed.length}</strong></div>
        <div className="positionStat"><span>Realized</span><strong className={pnlTone(real.summary?.realizedPnlUsd)}>{signedUsd(real.summary?.realizedPnlUsd || 0)}</strong></div>
        <div className="positionStat"><span>Unrealized</span><strong className={pnlTone(real.summary?.unrealizedPnlUsd)}>{signedUsd(real.summary?.unrealizedPnlUsd || 0)}</strong></div>
      </div>
      <PositionList
        positions={positions}
        expanded
        emptyTitle={live ? 'No live positions' : dryRun ? 'No real dry-run positions' : 'No real positions'}
        emptyText={live
          ? 'Fresh BUY trades from manually followed wallets will submit fixed-stake FOK orders if the upper price guard passes.'
          : dryRun
            ? 'Fresh BUY trades from manually followed wallets will create dry-run positions if the FOK quote guard passes.'
            : 'Fresh BUY trades from manually followed wallets will appear here after a guarded fill is recorded.'}
      />
    </section>
  );
}

function RealOrdersView({ real }) {
  const live = isLiveRealMode(real);
  const dryRun = isRealDryRunMode(real);
  return (
    <section className="panel fullPanel realOrdersPanel">
      <div className="sectionHead">
        <div>
          <p className="eyebrow">FOK audit</p>
          <h2>{live ? 'Live orders' : dryRun ? 'Dry-run orders' : 'Real orders'}</h2>
        </div>
        <ListFilter size={18} />
      </div>
      <RealOrdersList orders={real.orders || []} live={live} dryRun={dryRun} />
    </section>
  );
}

function RealOrdersList({ orders, compact = false, live = false, dryRun = false }) {
  if (!orders.length) {
    return <EmptyState title={live ? 'No live orders yet' : dryRun ? 'No dry-run orders yet' : 'No real orders yet'} text="The real follow poller will log filled/would-fill and rejected entries after a followed trader buys." />;
  }
  return (
    <div className={compact ? 'realOrderList compact' : 'realOrderList'}>
      {orders.map((order) => <RealOrderRow key={order.id} order={order} compact={compact} />)}
    </div>
  );
}

function RealOrderRow({ order, compact }) {
  const filled = isFilledRealOrder(order);
  const live = order.dryRun === false || order.liveExecution;
  return (
    <article className={`realOrderRow ${filled ? 'wouldFill' : 'rejected'}`}>
      <div className="realOrderMarket">
        <strong>{order.marketTitle || 'Unknown market'}</strong>
        <span>{order.outcome} - {shortWallet(order.traderWallet)} - {formatTimeAgo(order.checkedAt)}</span>
      </div>
      <div className="realOrderStats">
        <RealMiniStat label="Source" value={formatCents(order.sourcePriceCents)} />
        <RealMiniStat label={compact ? 'Ask' : 'Best ask'} value={formatCents(order.bestAskCents)} />
        {!compact && <RealMiniStat label="Max ask" value={formatCents(order.maxGuardCents)} />}
        {!compact && <RealMiniStat label="VWAP" value={formatCents(order.vwapCents)} />}
      </div>
      <div className="realOrderStatus">
        <span className={`statusBadge ${filled ? 'positive' : 'negative'}`}>{filled ? (live ? 'filled' : 'would fill') : 'rejected'}</span>
        <small title={order.reason}>{order.reason || order.reasonCode || 'ok'}</small>
      </div>
    </article>
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

function useRealState() {
  const [real, setReal] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);

  const refresh = React.useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/real/state`, { headers: authHeaders() });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Real state request failed');
      setReal(payload);
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

  return { real, loading, error, refresh, setReal };
}

function useRealCopyQuality({ tier = 'all', eligibleOnly = true, sort = 'score', query = '' } = {}) {
  const [payload, setPayload] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);

  const refresh = React.useCallback(async () => {
    const params = new URLSearchParams();
    params.set('limit', '100');
    params.set('tier', tier || 'all');
    params.set('eligible', eligibleOnly ? 'true' : 'all');
    params.set('sort', sort || 'score');
    params.set('order', ['entry', 'drawdown'].includes(sort) ? 'asc' : 'desc');
    if (query.trim()) params.set('q', query.trim());
    try {
      const response = await fetch(`${API_BASE}/api/real/copy-quality?${params.toString()}`, { headers: authHeaders() });
      const nextPayload = await response.json();
      if (!response.ok) throw new Error(nextPayload.error || 'Copy quality request failed');
      setPayload(nextPayload);
      setError(null);
    } catch (fetchError) {
      setError(fetchError.message);
    } finally {
      setLoading(false);
    }
  }, [eligibleOnly, query, sort, tier]);

  React.useEffect(() => {
    setLoading(true);
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return { payload, loading, error, refresh };
}

function CandidatesView({ service, copyPoolState }) {
  const { leaderboard, loading, error, refresh } = useCandidateLeaderboard();
  const realState = useRealState();
  const [expandedWallet, setExpandedWallet] = React.useState(null);
  const [detailsByWallet, setDetailsByWallet] = React.useState({});
  const [detailLoading, setDetailLoading] = React.useState({});
  const [detailErrors, setDetailErrors] = React.useState({});
  const [pinRequest, setPinRequest] = React.useState(null);
  const [actionError, setActionError] = React.useState(null);
  const [actionPendingWallet, setActionPendingWallet] = React.useState(null);
  const rows = leaderboard?.rows || [];
  const summary = leaderboard?.summary || {};
  const copyPool = leaderboard?.copyPool?.wallets ? leaderboard.copyPool : copyPoolState || {};
  const enabled = leaderboard?.enabled ?? service?.enabled;
  const realFollows = React.useMemo(() => {
    const entries = {};
    for (const follow of realState.real?.follows || []) {
      entries[String(follow.wallet || '').toLowerCase()] = follow;
    }
    return entries;
  }, [realState.real]);

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

  const requestRealAdd = React.useCallback((row) => {
    setActionError(null);
    setPinRequest({
      title: 'Add real follow',
      description: `${row.displayName || row.pseudonym || shortWallet(row.wallet)} will be tracked by the Real engine from now on.`,
      confirmLabel: 'Add',
      onSubmit: async (pin) => {
        setActionPendingWallet(row.wallet);
        try {
          const response = await fetch(`${API_BASE}/api/real/follow`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({
              pin,
              wallet: row.wallet,
              displayName: row.displayName,
              pseudonym: row.pseudonym,
              profileImage: row.profileImage,
            }),
          });
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error || 'Real follow failed');
          realState.setReal(payload.real);
          setPinRequest(null);
        } catch (submitError) {
          setActionError(submitError.message);
        } finally {
          setActionPendingWallet(null);
        }
      },
    });
  }, [realState]);

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
            {actionError && <span className="negative">{actionError}</span>}
          </div>

          <CopyPoolCards copyPool={copyPool} />

          <div className="candidateList">
            {rows.map((row) => (
              <React.Fragment key={row.wallet}>
                <CandidateRow
                  row={row}
                  copyPoolEntry={copyPool?.wallets?.[String(row.wallet || '').toLowerCase()]}
                  thresholds={copyPool?.thresholds}
                  realFollowEntry={realFollows[String(row.wallet || '').toLowerCase()]}
                  expanded={expandedWallet === row.wallet}
                  onToggle={() => toggleCandidate(row.wallet)}
                  onRealAdd={() => requestRealAdd(row)}
                  realActionPending={actionPendingWallet === row.wallet}
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
          <PinPromptModal
            request={pinRequest}
            error={actionError}
            pending={Boolean(actionPendingWallet)}
            onCancel={() => {
              setPinRequest(null);
              setActionError(null);
            }}
          />
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

function PinPromptModal({ request, error, pending, onCancel }) {
  const [pin, setPin] = React.useState('');

  React.useEffect(() => {
    setPin('');
  }, [request]);

  if (!request) return null;

  return (
    <div className="modalBackdrop" role="presentation">
      <form
        className="pinModal"
        onSubmit={(event) => {
          event.preventDefault();
          request.onSubmit(pin);
        }}
      >
        <div>
          <p className="eyebrow">Real dashboard</p>
          <h3>{request.title}</h3>
          {request.description && <span>{request.description}</span>}
        </div>
        <input
          autoFocus
          type="password"
          inputMode="numeric"
          value={pin}
          onChange={(event) => setPin(event.target.value)}
          placeholder="PIN"
          aria-label="Real action PIN"
        />
        {error && <strong className="negative">{error}</strong>}
        <div className="pinModalActions">
          <button type="button" className="textButton" onClick={onCancel} disabled={pending}>Cancel</button>
          <button type="submit" className="textButton primaryAction" disabled={pending || !pin}>
            {pending ? 'Working...' : request.confirmLabel || 'Confirm'}
          </button>
        </div>
      </form>
    </div>
  );
}

function CandidateRow({ row, copyPoolEntry, thresholds, realFollowEntry, expanded, onToggle, onRealAdd, realActionPending }) {
  const display = row.displayName || row.pseudonym || shortWallet(row.wallet);
  const form = row.recentFormResults || [];
  const ExpandIcon = expanded ? ChevronDown : ChevronRight;
  const badge = copyPoolBadge(copyPoolEntry);
  const realActive = realFollowEntry?.status === 'active';
  const acceptedCopyWallet = copyPoolEntry?.status === 'active';
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
      {acceptedCopyWallet ? (
        <CandidateMonthCarousel row={row} />
      ) : (
        <>
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
        </>
      )}
      <div className="candidateProfit">
        <strong className={pnlTone(row.allTimeProfitUsd)}>{compactSignedUsd(row.allTimeProfitUsd || 0)}</strong>
        <span>{row.backfillStatus || 'queued'}</span>
      </div>
      <div className="candidateRealAction">
        {realActive ? (
          <span className="realFollowBadge">Real</span>
        ) : (
          <button className="textButton realAddButton" onClick={onRealAdd} disabled={realActionPending}>
            <UserPlus size={14} /> {realActionPending ? 'Adding' : 'Add'}
          </button>
        )}
      </div>
    </article>
  );
}

function CandidateMonthCarousel({ row }) {
  const cards = candidateMonthCards(row);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const activeCard = cards[activeIndex] || cards[0];

  React.useEffect(() => {
    if (activeIndex >= cards.length) setActiveIndex(0);
  }, [activeIndex, cards.length]);

  const move = React.useCallback((direction) => {
    setActiveIndex((index) => (index + direction + cards.length) % cards.length);
  }, [cards.length]);

  if (!activeCard) return null;

  return (
    <div className="candidateMonthCarousel" aria-label="Accepted wallet monthly stats">
      <div className="candidateMonthCardHead">
        <button
          type="button"
          className="candidateMonthNav"
          onClick={() => move(-1)}
          aria-label="Previous month card"
        >
          <ChevronLeft size={14} />
        </button>
        <div className="candidateMonthTitle">
          <span>{activeCard.label}</span>
          <strong className={winRateTone(activeCard.winRatePct)}>{formatNullablePct(activeCard.winRatePct)}</strong>
        </div>
        <button
          type="button"
          className="candidateMonthNav"
          onClick={() => move(1)}
          aria-label="Next month card"
        >
          <ChevronRight size={14} />
        </button>
      </div>
      <div className="candidateMonthViewport">
        <div className="candidateMonthTrack" style={{ transform: `translateX(-${activeIndex * 100}%)` }}>
          {cards.map((card) => (
            <div className="candidateMonthSlide" key={card.index}>
              <div className="candidateMonthStats" title={monthCardRangeTitle(card)}>
                <span><b>{card.distinctResolvedTradeCount || 0}</b> mkts</span>
                <span><b className={card.pnlTradeCount ? pnlTone(card.profitUsd) : 'neutral'}>{formatMonthProfit(card)}</b> P/L</span>
                <span><b className={card.pnlTradeCount ? pnlTone(card.roiPct) : 'neutral'}>{formatMonthRoi(card)}</b> ROI</span>
                <span><b>{formatNullableCents(card.avgEntryPriceCents)}</b> AEP</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
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

function formatPlainProfitFactor(value) {
  const number = Number(value);
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

function candidateMonthCards(row) {
  const cards = Array.isArray(row?.monthlyPerformance) ? row.monthlyPerformance : [];
  const normalized = cards.map((card, index) => ({
    index: Number.isFinite(Number(card.index)) ? Number(card.index) : index,
    label: card.label || monthWindowLabel(index),
    startAt: card.startAt || null,
    endAt: card.endAt || null,
    distinctResolvedTradeCount: Number(card.distinctResolvedTradeCount || 0),
    winCount: Number(card.winCount || 0),
    winRatePct: metricNumber(card.winRatePct),
    avgEntryPriceCents: metricNumber(card.avgEntryPriceCents),
    avgEntryTradeCount: Number(card.avgEntryTradeCount || 0),
    pnlTradeCount: Number(card.pnlTradeCount || 0),
    profitUsd: metricNumber(card.profitUsd) ?? 0,
    roiPct: metricNumber(card.roiPct),
  }));

  if (normalized.length) return normalized.sort((a, b) => a.index - b.index);

  return [{
    index: 0,
    label: 'Last 30D',
    startAt: null,
    endAt: null,
    distinctResolvedTradeCount: Number(row?.resolvedDistinctTradeCount30d || 0),
    winCount: Number(row?.winCountDistinct30d || 0),
    winRatePct: metricNumber(row?.winRatePctDistinct30d),
    avgEntryPriceCents: metricNumber(row?.avgEntryPriceCents30d),
    avgEntryTradeCount: Number(row?.avgEntryTradeCount30d || 0),
    pnlTradeCount: 0,
    profitUsd: 0,
    roiPct: null,
  }];
}

function monthWindowLabel(index) {
  if (index === 0) return 'Last 30D';
  return `${index * 30}-${(index + 1) * 30}D`;
}

function monthCardRangeTitle(card) {
  if (!card?.startAt || !card?.endAt) return card?.label || 'Month card';
  return `${formatShortDate(card.startAt)} to ${formatShortDate(card.endAt)}`;
}

function formatShortDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date);
}

function formatMonthProfit(card) {
  return card?.pnlTradeCount ? formatNullableSignedCompactUsd(card.profitUsd) : EMPTY_METRIC;
}

function formatMonthRoi(card) {
  return card?.pnlTradeCount ? formatNullableSignedPct(card.roiPct) : EMPTY_METRIC;
}

function metricNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function copyPoolBadge(entry) {
  if (!entry || entry.status !== 'active') return null;
  if (entry.protected) return { label: 'Following', tone: 'protected', title: 'Protected baseline wallet is being copied' };
  return { label: 'Following', tone: 'following', title: 'Auto-added trader is being copied' };
}

function copyQualityTierLabel(tier) {
  const value = String(tier || 'ignore');
  if (value === 'manual_review') return 'manual review';
  return value;
}

function copyQualityTierTone(tier) {
  const value = String(tier || 'ignore');
  if (value === 'core') return 'protected';
  if (value === 'candidate') return 'following';
  if (value === 'watchlist') return 'neutral';
  if (value === 'manual_review') return 'neutral';
  return 'removed';
}

function flagLabel(flag) {
  return String(flag || '').replace(/_/g, ' ');
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

function winRateTone(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'neutral';
  if (number >= 75) return 'positive';
  if (number < 70) return 'negative';
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

function isLiveRealMode(real) {
  if (real?.runtime) {
    return String(real.runtime.mode || '').toLowerCase() === 'live' && Boolean(real.runtime.liveExecutionEnabled);
  }
  return real?.mode === 'live' && Boolean(real?.service?.liveExecutionEnabled);
}

function isRealDryRunMode(real) {
  const mode = real?.runtime?.mode || real?.mode;
  return !isLiveRealMode(real) && String(mode || '').toLowerCase() === 'dry_run';
}

function isRuntimeOnline(runtime) {
  const heartbeat = Date.parse(runtime?.heartbeatAt || runtime?.updatedAt || 0);
  if (!Number.isFinite(heartbeat)) return false;
  return Date.now() - heartbeat < 150_000;
}

function accountAllowanceHealth(account = {}) {
  const collateral = account.collateral || {};
  if (collateral.onchainAllAllowancesPositive === true) {
    return { label: 'Healthy', meta: `${collateral.onchainPositiveAllowanceCount || 0} pUSD approvals`, tone: 'positive' };
  }
  if (collateral.onchainAllAllowancesPositive === false) {
    return { label: 'Needs approval', meta: `${collateral.onchainPositiveAllowanceCount || 0} pUSD approvals`, tone: 'negative' };
  }
  if (collateral.allAllowancesPositive === true) {
    return { label: 'Healthy', meta: `${collateral.positiveAllowanceCount || 0} CLOB allowances`, tone: 'positive' };
  }
  if (collateral.allAllowancesPositive === false) {
    return { label: 'Needs sync', meta: `${collateral.positiveAllowanceCount || 0} CLOB allowances`, tone: 'negative' };
  }
  if (account.ok) {
    return { label: 'Synced', meta: 'no allowance detail', tone: 'neutral' };
  }
  return { label: 'Unknown', meta: account.lastError || 'not reported', tone: 'neutral' };
}

function formatAccountUsd(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'not reported';
  return usd(number);
}

function isFilledRealOrder(order) {
  return ['would_fill', 'filled', 'live_filled'].includes(String(order?.status || '').toLowerCase());
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
