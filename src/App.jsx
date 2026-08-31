import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cancelRun, createRun, getBrowserTabs, getHealth, getThread, getThreads } from './lib/api';
import { Brand, Icon } from './components/Ui';
import { SessionList } from './components/Sessions';
import { Composer } from './components/Composer';
import { PermissionSheet, SettingsSheet } from './components/Sheets';

const ThreadView = lazy(() => import('./components/Thread').then((module) => ({ default: module.ThreadView })));
const NEW_DRAFT_KEY = '__new__';

function storedValue(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function selectionIsActive() {
  const selection = window.getSelection?.();
  return Boolean(selection && !selection.isCollapsed && selection.toString());
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export default function App() {
  const [health, setHealth] = useState(null);
  const [tabs, setTabs] = useState([]);
  const [threads, setThreads] = useState([]);
  const [activeThreadId, setActiveThreadId] = useState(() => sessionStorage.getItem('tail-aside.active-thread'));
  const [activeThread, setActiveThread] = useState(null);
  const [threadRuns, setThreadRuns] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [mode, setMode] = useState('readonly');
  const [model, setModel] = useState(() => storedValue('tail-aside.model', ''));
  const [effort, setEffort] = useState(() => storedValue('tail-aside.effort', 'minimal'));
  const [speed, setSpeed] = useState(() => storedValue('tail-aside.speed', 'fast'));
  const [target, setTarget] = useState('');
  const [externalMessage, setExternalMessage] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [externalAction, setExternalAction] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [sheet, setSheet] = useState(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const metaSignatureRef = useRef('');
  const threadSignatureRef = useRef('');
  const preferencesInitializedRef = useRef(false);
  const threadScrollerRef = useRef(null);
  const previousThreadRef = useRef(null);
  const draftKey = activeThreadId || NEW_DRAFT_KEY;
  const draft = drafts[draftKey] || '';

  const updateDraft = useCallback((value) => {
    setDrafts((current) => {
      if (current[draftKey] === value) return current;
      const next = { ...current };
      if (value) next[draftKey] = value;
      else delete next[draftKey];
      return next;
    });
  }, [draftKey]);

  const activeRun = useMemo(
    () => threadRuns.find((run) => run.status === 'running') || null,
    [threadRuns],
  );
  const continuationBlocked = Boolean(
    activeThread
      && activeThread.turnCount > 0
      && !activeThread.canContinue
      && activeThread.status !== 'running',
  );

  const mergeThread = useCallback((thread) => {
    if (!thread) return;
    setThreads((current) => {
      const next = [thread, ...current.filter((item) => item.id !== thread.id)]
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      return sameValue(current, next) ? current : next;
    });
  }, []);

  const refreshMeta = useCallback(async ({ force = false } = {}) => {
    if (force) setRefreshing(true);
    try {
      const [healthValue, tabsValue, threadValue] = await Promise.all([
        getHealth(),
        getBrowserTabs(),
        getThreads(force),
      ]);
      const nextTabs = tabsValue.tabs || [];
      const nextThreads = threadValue.threads || [];
      const signature = JSON.stringify({ healthValue, nextTabs, nextThreads });
      if (signature !== metaSignatureRef.current) {
        metaSignatureRef.current = signature;
        setHealth(healthValue);
        setTabs(nextTabs);
        setThreads(nextThreads);
      }
      if (!preferencesInitializedRef.current) {
        preferencesInitializedRef.current = true;
        if (!localStorage.getItem('tail-aside.model')) setModel(healthValue.defaults?.model || '');
        if (!localStorage.getItem('tail-aside.effort')) setEffort(healthValue.defaults?.effort || 'minimal');
        if (!localStorage.getItem('tail-aside.speed')) setSpeed(healthValue.defaults?.speed || 'fast');
      }
      setError((current) => current.startsWith('Could not connect') ? '' : current);
    } catch (requestError) {
      setError(`Could not connect to tail-aside: ${requestError.message}`);
    } finally {
      if (force) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    refreshMeta();
    const timer = window.setInterval(() => {
      if (!selectionIsActive()) refreshMeta();
    }, 20_000);
    function onVisibilityChange() {
      if (!document.hidden && !selectionIsActive()) refreshMeta();
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [refreshMeta]);

  useEffect(() => {
    try {
      localStorage.setItem('tail-aside.model', model);
      localStorage.setItem('tail-aside.effort', effort);
      localStorage.setItem('tail-aside.speed', speed);
    } catch {
      // Preferences are optional; private browsing may reject local storage.
    }
  }, [model, effort, speed]);

  useEffect(() => {
    if (!activeThreadId) {
      sessionStorage.removeItem('tail-aside.active-thread');
      setActiveThread(null);
      setThreadRuns([]);
      threadSignatureRef.current = '';
      return undefined;
    }
    sessionStorage.setItem('tail-aside.active-thread', activeThreadId);
    let cancelled = false;
    let requestInFlight = false;

    async function refreshThread({ force = false } = {}) {
      if (requestInFlight || (!force && (selectionIsActive() || document.hidden))) return;
      requestInFlight = true;
      try {
        const value = await getThread(activeThreadId);
        if (cancelled || !value.thread) return;
        const signature = JSON.stringify(value);
        if (signature === threadSignatureRef.current) return;
        threadSignatureRef.current = signature;
        setActiveThread(value.thread);
        setThreadRuns(value.runs || []);
        mergeThread(value.thread);
      } catch (requestError) {
        if (!cancelled && requestError.status === 404) {
          setActiveThreadId(null);
          setError('That Aside session is no longer available. The session list was refreshed.');
          refreshMeta({ force: true });
        } else if (!cancelled) {
          setError(requestError.message);
        }
      } finally {
        requestInFlight = false;
      }
    }

    refreshThread({ force: true });
    const timer = window.setInterval(refreshThread, 1_200);
    function onVisibilityChange() {
      if (!document.hidden) refreshThread({ force: true });
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [activeThreadId, mergeThread, refreshMeta]);

  useEffect(() => {
    const scroller = threadScrollerRef.current;
    if (!scroller || selectionIsActive()) return;
    const switchedThread = previousThreadRef.current !== activeThreadId;
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
    if (switchedThread || nearBottom) {
      requestAnimationFrame(() => scroller.scrollTo({ top: scroller.scrollHeight, behavior: switchedThread ? 'auto' : 'smooth' }));
      setShowJumpToLatest(false);
    }
    previousThreadRef.current = activeThreadId;
  }, [activeThreadId, threadRuns]);

  function openThread(id) {
    threadSignatureRef.current = '';
    setActiveThreadId(id);
    setSheet(null);
    setError('');
    setShowJumpToLatest(false);
  }

  function newConversation() {
    setActiveThreadId(null);
    setActiveThread(null);
    setThreadRuns([]);
    setDrafts((current) => {
      const next = { ...current };
      delete next[NEW_DRAFT_KEY];
      return next;
    });
    setMode('readonly');
    setTarget('');
    setExternalMessage('');
    setConfirmation('');
    setExternalAction(false);
    setSheet(null);
    setError('');
    setShowJumpToLatest(false);
  }

  async function startRun() {
    setError('');
    if (!draft.trim()) return;
    if (continuationBlocked) {
      setError('This Aside session can no longer be continued. Start a new session instead.');
      return;
    }
    if (mode === 'send' && (!target.trim() || !externalMessage.trim() || confirmation !== 'SEND' || !externalAction)) {
      setError('External send needs an exact target, exact message, SEND, and approval.');
      setSheet('permission');
      return;
    }

    setLoading(true);
    try {
      const value = await createRun({
        threadId: activeThreadId,
        prompt: draft,
        mode,
        target,
        message: externalMessage,
        confirmation,
        externalAction,
        model,
        effort,
        speed,
      });
      mergeThread(value.thread);
      setActiveThread(value.thread);
      setActiveThreadId(value.thread.id);
      threadSignatureRef.current = '';
      setThreadRuns((current) => activeThreadId === value.thread.id ? [...current, value.run] : [value.run]);
      updateDraft('');
      setSheet(null);
      if (mode === 'send') {
        setConfirmation('');
        setExternalAction(false);
      }
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  async function stopActiveRun() {
    if (!activeRun) return;
    try {
      const value = await cancelRun(activeRun.id);
      if (value.thread) {
        setActiveThread(value.thread);
        mergeThread(value.thread);
      }
      if (value.run) setThreadRuns((current) => current.map((run) => run.id === value.run.id ? value.run : run));
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  function updateScrollPosition() {
    const scroller = threadScrollerRef.current;
    if (!scroller) return;
    setShowJumpToLatest(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 180);
  }

  function scrollToLatest() {
    const scroller = threadScrollerRef.current;
    if (!scroller) return;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
    setShowJumpToLatest(false);
  }

  const composer = (
    <Composer
      draft={draft}
      setDraft={updateDraft}
      onSubmit={startRun}
      onNew={newConversation}
      onOpenPermission={() => setSheet('permission')}
      onOpenSettings={() => setSheet('settings')}
      mode={mode}
      model={model}
      effort={effort}
      activeRun={activeRun}
      onStop={stopActiveRun}
      loading={loading}
      continuationBlocked={continuationBlocked}
      error={error.startsWith('Could not connect') ? '' : error}
      home={!activeThreadId}
    />
  );

  const sheets = (
    <>
      {sheet === 'permission' ? (
        <PermissionSheet
          mode={mode}
          setMode={setMode}
          target={target}
          setTarget={setTarget}
          message={externalMessage}
          setMessage={setExternalMessage}
          confirmation={confirmation}
          setConfirmation={setConfirmation}
          externalAction={externalAction}
          setExternalAction={setExternalAction}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === 'settings' ? (
        <SettingsSheet
          health={health}
          tabs={tabs}
          threads={threads}
          model={model}
          setModel={setModel}
          effort={effort}
          setEffort={setEffort}
          speed={speed}
          setSpeed={setSpeed}
          onRefresh={() => refreshMeta({ force: true })}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </>
  );

  const connectionNotice = error.startsWith('Could not connect') ? (
    <div className="connection-notice" role="alert">
      <span><strong>Connection lost.</strong> Your Mac or Tailnet may be temporarily unavailable.</span>
      <button type="button" onClick={() => refreshMeta({ force: true })} disabled={refreshing}>{refreshing ? 'Retrying…' : 'Retry'}</button>
    </div>
  ) : null;

  if (!activeThreadId) {
    return (
      <div className="app-shell home-shell">
        <header className="home-header">
          <Brand />
          <button type="button" className="connection-pill" onClick={() => setSheet('settings')}>
            <Icon name="lock" size={14} />
            <span className={`connection-dot ${health?.ok ? 'is-online' : ''}`} />
            {health?.ok ? 'Connected' : 'Check setup'}
          </button>
        </header>
        <main className="home-content">
          {connectionNotice}
          <section className="home-hero">
            <p className="eyebrow"><Icon name="lock" size={13} /> Private on your Tailnet</p>
            <h1>What should Aside do?</h1>
            <p>Run the same browser agent from your phone, then continue the session later.</p>
          </section>
          <SessionList
            threads={threads}
            loading={!health}
            onOpen={openThread}
            onNew={newConversation}
            onRefresh={() => refreshMeta({ force: true })}
            refreshing={refreshing}
          />
        </main>
        <footer className="composer-dock">{composer}</footer>
        {sheets}
      </div>
    );
  }

  return (
    <div className="app-shell thread-shell">
      <aside className="desktop-sidebar" aria-label="Aside sessions">
        <header className="sidebar-header">
          <Brand compact />
          <button type="button" className="icon-button" onClick={newConversation} aria-label="New session"><Icon name="plus" size={18} /></button>
        </header>
        <div className="sidebar-scroll">
          <SessionList
            compact
            threads={threads}
            loading={!health}
            onOpen={openThread}
            onNew={newConversation}
            onRefresh={() => refreshMeta({ force: true })}
            refreshing={refreshing}
            activeThreadId={activeThreadId}
          />
        </div>
        <button type="button" className="sidebar-status" onClick={() => setSheet('settings')}>
          <span className={`connection-dot ${health?.ok ? 'is-online' : ''}`} />
          <span><strong>{health?.ok ? 'Aside connected' : 'Check connection'}</strong><small>Private via Tailscale</small></span>
          <Icon name="settings" size={17} />
        </button>
      </aside>
      <section className="thread-pane">
        <header className="thread-header">
          <button type="button" className="icon-button back-button" onClick={() => setActiveThreadId(null)} aria-label="Back to sessions">
            <Icon name="arrowLeft" size={20} />
          </button>
          <span className="thread-heading">
            <span className="thread-title">{activeThread?.title || 'Aside session'}</span>
            <span className="thread-subtitle"><Icon name="lock" size={11} /> Private via Tailscale{activeThread?.canContinue ? ' · continuing' : ''}</span>
          </span>
          <button type="button" className="icon-button thread-new-button" onClick={newConversation} aria-label="New session">
            <Icon name="plus" size={18} />
          </button>
          <button type="button" className="icon-button" onClick={() => setSheet('settings')} aria-label="Agent settings">
            <Icon name="settings" size={19} />
          </button>
        </header>
        {connectionNotice}
        <main className="thread-scroll" ref={threadScrollerRef} onScroll={updateScrollPosition} aria-live="polite">
          <Suspense fallback={<div className="thread-empty">Loading conversation renderer…</div>}>
            <ThreadView runs={threadRuns} />
          </Suspense>
        </main>
        {showJumpToLatest ? (
          <button type="button" className="jump-to-latest" onClick={scrollToLatest} aria-label="Jump to latest message">
            <Icon name="arrowDown" size={17} /> Latest
          </button>
        ) : null}
        <footer className="composer-dock thread-dock">{composer}</footer>
      </section>
      {sheets}
    </div>
  );
}
