import { useEffect, useRef } from 'react';
import { Icon, Spinner } from './Ui';

export function Composer({
  draft,
  setDraft,
  onSubmit,
  onNew,
  onOpenPermission,
  onOpenSettings,
  mode,
  model,
  effort,
  activeRun,
  onStop,
  loading,
  continuationBlocked,
  error,
  home,
}) {
  const textareaRef = useRef(null);
  const canSend = Boolean(draft.trim()) && !loading && !activeRun && !continuationBlocked;
  const modelName = model ? model.split('/').at(-1).replace(/^gpt/i, 'GPT') : 'Default';
  const settingsLabel = `${modelName} · ${effort}`;

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 176)}px`;
  }, [draft]);

  function submit(event) {
    event.preventDefault();
    if (canSend) onSubmit();
  }

  function onKeyDown(event) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches;
    if (coarsePointer && !event.metaKey && !event.ctrlKey) return;
    event.preventDefault();
    if (canSend) onSubmit();
  }

  return (
    <form className={`composer ${home ? 'is-home' : 'is-reply'}`} onSubmit={submit}>
      <textarea
        ref={textareaRef}
        className="composer-input"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={continuationBlocked
          ? 'This session can no longer be continued.'
          : home ? 'Ask Aside to do something…' : 'Continue this session…'}
        aria-label="Message Aside"
        aria-describedby={error ? 'composer-error' : undefined}
        rows={1}
        disabled={continuationBlocked}
        enterKeyHint="enter"
        maxLength={8000}
      />
      {error ? <p className="composer-error" id="composer-error" role="alert">{error}</p> : null}
      <div className="composer-toolbar">
        <button type="button" className="tool-button icon-only" onClick={onNew} aria-label="New session">
          <Icon name="plus" size={18} />
        </button>
        <button
          type="button"
          className={`tool-button ${mode === 'send' ? 'is-external' : ''}`}
          onClick={onOpenPermission}
        >
          <span className="mode-dot" /> {mode === 'send' ? 'Send' : 'Agent'}
        </button>
        <button type="button" className="tool-button settings-tool" onClick={onOpenSettings} aria-label={`Agent settings: ${settingsLabel}`}>
          <span>{modelName}</span><span className="settings-detail"> · {effort}</span><Icon name="chevronDown" size={12} />
        </button>
        <span className="toolbar-spacer" />
        {draft.length > 7200 ? <span className="composer-count" aria-label={`${8000 - draft.length} characters remaining`}>{8000 - draft.length}</span> : null}
        {activeRun ? (
          <button type="button" className="send-button is-stop" onClick={onStop} aria-label="Stop run">
            <Icon name="stop" size={15} />
          </button>
        ) : (
          <button type="submit" className="send-button" disabled={!canSend} aria-label="Send to Aside">
            {loading ? <Spinner label="Starting Aside" /> : <Icon name="arrowUp" size={18} strokeWidth={2} />}
          </button>
        )}
      </div>
    </form>
  );
}
