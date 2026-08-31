import { useEffect, useId, useRef } from 'react';
import { Icon } from './Ui';

function Sheet({ title, subtitle, children, onClose }) {
  const sheetRef = useRef(null);
  const closeRef = useRef(onClose);
  const titleId = useId();
  closeRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement;
    const sheet = sheetRef.current;
    const focusableSelector = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';
    const initialFocus = sheet?.querySelector(focusableSelector) || sheet;
    requestAnimationFrame(() => initialFocus?.focus({ preventScroll: true }));

    function onKeyDown(event) {
      if (event.key === 'Escape') {
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || !sheet) return;
      const focusable = [...sheet.querySelectorAll(focusableSelector)];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus?.({ preventScroll: true });
    };
  }, []);

  return (
    <div className="sheet-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="sheet" ref={sheetRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="sheet-handle" />
        <header className="sheet-header">
          <span>
            <h2 id={titleId}>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </span>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="sheet-body">{children}</div>
      </section>
    </div>
  );
}

export function PermissionSheet({
  mode,
  setMode,
  target,
  setTarget,
  message,
  setMessage,
  confirmation,
  setConfirmation,
  externalAction,
  setExternalAction,
  onClose,
}) {
  return (
    <Sheet title="Agent permission" subtitle="External actions always need an exact one-time approval." onClose={onClose}>
      <div className="choice-list">
        <button type="button" className={`choice-row ${mode === 'readonly' ? 'is-selected' : ''}`} onClick={() => setMode('readonly')}>
          <span className="choice-icon"><Icon name="terminal" size={17} /></span>
          <span className="choice-copy"><strong>Agent chat</strong><small>Inspect, reason, and work without submitting external changes.</small></span>
          {mode === 'readonly' ? <Icon name="check" size={17} /> : null}
        </button>
        <button type="button" className={`choice-row ${mode === 'send' ? 'is-selected is-external' : ''}`} onClick={() => setMode('send')}>
          <span className="choice-icon"><Icon name="external" size={17} /></span>
          <span className="choice-copy"><strong>External send</strong><small>Approve one exact target and one exact message.</small></span>
          {mode === 'send' ? <Icon name="check" size={17} /> : null}
        </button>
      </div>

      {mode === 'send' ? (
        <div className="approval-fields">
          <label>Exact target<input value={target} onChange={(event) => setTarget(event.target.value)} placeholder="Site, account, or recipient" /></label>
          <label>Exact message<textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Text to submit" rows={3} /></label>
          <label>Approval phrase<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="Type SEND" autoCapitalize="characters" /></label>
          <label className="checkbox-row"><input type="checkbox" checked={externalAction} onChange={(event) => setExternalAction(event.target.checked)} /> I approve this exact external action.</label>
        </div>
      ) : null}
    </Sheet>
  );
}

const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultrabrowse'];

export function SettingsSheet({
  health,
  tabs,
  threads,
  model,
  setModel,
  effort,
  setEffort,
  speed,
  setSpeed,
  onRefresh,
  onClose,
}) {
  function resetDefaults() {
    setModel(health?.defaults?.model || '');
    setEffort(health?.defaults?.effort || 'minimal');
    setSpeed(health?.defaults?.speed || 'fast');
  }

  return (
    <Sheet title="Agent settings" subtitle="These values are passed directly to Aside CLI for each run." onClose={onClose}>
      <section className="settings-section">
        <h3>Model</h3>
        <input className="settings-input" value={model} onChange={(event) => setModel(event.target.value)} placeholder="Aside default" autoCapitalize="none" autoCorrect="off" spellCheck="false" />
      </section>
      <section className="settings-section">
        <h3>Reasoning effort</h3>
        <div className="chip-grid">
          {EFFORTS.map((value) => <button type="button" key={value} className={effort === value ? 'is-selected' : ''} onClick={() => setEffort(value)}>{value}</button>)}
        </div>
      </section>
      <section className="settings-section">
        <h3>Speed</h3>
        <div className="segmented-control">
          {['default', 'fast'].map((value) => <button type="button" key={value} className={speed === value ? 'is-selected' : ''} onClick={() => setSpeed(value)}>{value}</button>)}
        </div>
      </section>
      <button type="button" className="secondary-action" onClick={resetDefaults}>Reset to Aside defaults</button>
      <section className="status-panel">
        <div className="status-title">
          <span className={`connection-dot ${health?.ok ? 'is-online' : ''}`} />
          <strong>{health?.ok ? 'Aside connected' : 'Aside needs attention'}</strong>
          <button type="button" className="icon-button" onClick={onRefresh} aria-label="Refresh status"><Icon name="refresh" size={15} /></button>
        </div>
        <dl>
          <div><dt>CLI</dt><dd>{health?.aside?.version ? `v${health.aside.version}` : 'Not detected'}</dd></div>
          <div><dt>Session access</dt><dd>Private via Tailscale</dd></div>
          <div><dt>Sessions</dt><dd>{threads.length}</dd></div>
          <div><dt>Browser tabs</dt><dd>{tabs.length}</dd></div>
        </dl>
      </section>
      {tabs.length ? (
        <section className="settings-section">
          <h3>Open browser tabs</h3>
          <div className="tab-list">
            {tabs.slice(0, 5).map((tab) => (
              <div className="tab-row" key={tab.targetId}>
                <Icon name="panel" size={15} />
                <span><strong>{tab.title || 'Untitled tab'}</strong><small>{tab.url}</small></span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </Sheet>
  );
}
