import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cancelRun, createRun, getBrowserTabs, getHealth, getThread, getThreads } from './lib/api';
import { Brand, Icon } from './components/Ui';
import { SessionList } from './components/Sessions';
import { ThreadView } from './components/Thread';
import { Composer } from './components/Composer';
import { PermissionSheet, SettingsSheet } from './components/Sheets';

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
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState('readonly');
  const [model, setModel] = useState(() => storedValue('tail-aside.model', ''));
  const [effort, setEffort] = useState(() => storedValue('tail-aside.effort', 'minimal'));
  const [speed, setSpeed] = useState(() => storedValue('tail-aside.speed', 'fast'));
  const [target, setTarget] = useState('');
  const [externalMessage, setExternalMessage] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [externalAction, setExternalAction] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sheet, setSheet] = useState(null);
  const metaSignatureRef = useRef('');
  const threadSignatureRef = useRef('');
  const preferencesInitializedRef = useRef(false);
  const threadScrollerRef = useRef(null);
  const previousThreadRef = useRef(null);

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

  const refreshMeta = useCallback(async () => {
    try {
      const [healthValue, tabsValue, threadValue] = await Promise.all([
        getHealth(),
        getBrowserTabs(),
        getThreads(),
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
    }
  }, []);

  useEffect(() => {
    refreshMeta();
    const timer = window.setInterval(() => {
      if (!selectionIsActive()) refreshMeta();
    }, 20_000);
    return () => window.clearInterval(timer);
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

    async function refreshThread({ force = false } = {}) {
      if (!force && selectionIsActive()) return;
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
        if (!cancelled) setError(requestError.message);
      }
    }

    refreshThread({ force: true });
    const timer = window.setInterval(refreshThread, 1_200);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeThreadId, mergeThread]);

  useEffect(() => {
    const scroller = threadScrollerRef.current;
    if (!scroller || selectionIsActive()) return;
    const switchedThread = previousThreadRef.current !== activeThreadId;
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
    if (switchedThread || nearBottom) {
      requestAnimationFrame(() => scroller.scrollTo({ top: scroller.scrollHeight, behavior: switchedThread ? 'auto' : 'smooth' }));
    }
    previousThreadRef.current = activeThreadId;
  }, [activeThreadId, threadRuns]);

  function openThread(id) {
    threadSignatureRef.current = '';
    setActiveThreadId(id);
    setSheet(null);
    setError('');
  }

  function newConversation() {
    setActiveThreadId(null);
    setActiveThread(null);
    setThreadRuns([]);
    setDraft('');
    setMode('readonly');
    setTarget('');
    setExternalMessage('');
    setConfirmation('');
    setExternalAction(false);
    setSheet(null);
    setError('');
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
      setDraft('');
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

  const composer = (
    <Composer
      draft={draft}
      setDraft={setDraft}
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
      error={error}
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
          onRefresh={refreshMeta}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </>
  );

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
          <section className="home-hero">
            <p className="eyebrow">Aside on your tailnet</p>
            <h1>What should Aside do?</h1>
            <p>Run the same browser agent from your phone, then continue the session later.</p>
          </section>
          <SessionList threads={threads} loading={!health} onOpen={openThread} onNew={newConversation} />
        </main>
        <footer className="composer-dock">{composer}</footer>
        {sheets}
      </div>
    );
  }

  return (
    <div className="app-shell thread-shell">
      <header className="thread-header">
        <button type="button" className="icon-button" onClick={() => setActiveThreadId(null)} aria-label="Back to sessions">
          <Icon name="arrowLeft" size={20} />
        </button>
        <span className="thread-heading">
          <span className="thread-title">{activeThread?.title || 'Aside session'}</span>
          <span className="thread-subtitle"><Icon name="lock" size={11} /> Private via Tailscale{activeThread?.canContinue ? ' · continuing' : ''}</span>
        </span>
        <button type="button" className="icon-button" onClick={() => setSheet('settings')} aria-label="Agent settings">
          <Icon name="settings" size={19} />
        </button>
      </header>
      <main className="thread-scroll" ref={threadScrollerRef} aria-live="polite">
        <ThreadView runs={threadRuns} />
      </main>
      <footer className="composer-dock thread-dock">{composer}</footer>
      {sheets}
    </div>
  );
}
