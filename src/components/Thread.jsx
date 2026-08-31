import { memo, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { splitRunOutput } from '../lib/output';
import { Icon, Spinner, workedFor } from './Ui';

function WorkFold({ run, activity }) {
  const running = run.status === 'running';
  if (!running && !activity.length) return null;
  const latest = activity.at(-1)?.replace(/^(thinking:|plan:|tool)\s*/i, '') || 'Working with Aside';
  return (
    <details className={`work-fold ${running ? 'is-live' : ''}`} open={running}>
      <summary className="work-summary">
        {running ? <Spinner /> : <span className="work-check"><Icon name="check" size={12} /></span>}
        <span>{running ? `Working · ${workedFor(run.startedAt)}` : `Worked for ${workedFor(run.startedAt, run.finishedAt)}`}</span>
        <span className="work-latest">{latest}</span>
        <Icon name="chevronRight" size={14} className="work-chevron" />
      </summary>
      <div className="work-timeline selectable">
        {(activity.length ? activity : ['Aside is checking the browser context.']).map((line, index) => (
          <div className="work-step" key={`${run.id}-step-${index}`}>
            <span className="work-dot" />
            <span>{line}</span>
          </div>
        ))}
      </div>
    </details>
  );
}

function CopyResponse({ value }) {
  const [state, setState] = useState('idle');

  useEffect(() => {
    if (state === 'idle') return undefined;
    const timer = window.setTimeout(() => setState('idle'), 1_800);
    return () => window.clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
  }

  return (
    <button type="button" className="response-action" onClick={copy} aria-label="Copy Aside response">
      <Icon name={state === 'copied' ? 'check' : 'copy'} size={14} />
      <span aria-live="polite">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}</span>
    </button>
  );
}

const ConversationTurn = memo(function ConversationTurn({ run }) {
  const { activity, prose } = useMemo(() => splitRunOutput(run.output), [run.output]);
  const failed = ['failed', 'cancelled', 'interrupted'].includes(run.status);
  return (
    <article className="conversation-turn">
      <div className="user-message selectable">{run.prompt}</div>
      <WorkFold run={run} activity={activity} />
      {prose ? (
        <div className="assistant-response">
          <div className="assistant-message markdown-body selectable">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ node: _node, children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
                img: ({ node: _node, alt }) => <span className="markdown-image-placeholder">[Image: {alt || 'attachment'}]</span>,
              }}
            >
              {prose}
            </ReactMarkdown>
          </div>
          <div className="response-actions"><CopyResponse value={prose} /></div>
        </div>
      ) : null}
      {failed ? (
        <p className="run-error">
          {run.status === 'cancelled' ? 'Run stopped.' : 'Aside could not complete this run. Expand the work log for details.'}
        </p>
      ) : null}
    </article>
  );
}, (previous, next) => (
  previous.run.id === next.run.id
  && previous.run.status === next.run.status
  && previous.run.output === next.run.output
  && previous.run.prompt === next.run.prompt
));

export const ThreadView = memo(function ThreadView({ runs }) {
  if (!runs.length) {
    return (
      <div className="thread-empty" role="status">
        <Spinner />
        <span>Loading this Aside session…</span>
      </div>
    );
  }
  return <div className="thread-view">{runs.map((run) => <ConversationTurn key={run.id} run={run} />)}</div>;
});
