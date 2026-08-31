import { memo, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { splitRunOutput } from '../lib/output';
import { Icon, Spinner, workedFor } from './Ui';

function WorkFold({ run, activity }) {
  const running = run.status === 'running';
  const failed = ['failed', 'cancelled', 'interrupted'].includes(run.status);
  if (!running && !activity.length) return null;
  const latest = activity.at(-1)?.replace(/^(thinking:|plan:|tool)\s*/i, '') || 'Working with Aside';
  return (
    <details className={`work-fold ${running ? 'is-live' : ''} ${failed ? 'is-failed' : ''}`} open={running}>
      <summary className="work-summary">
        {running ? <Spinner label="Aside is working" /> : <span className="work-check"><Icon name={failed ? 'close' : 'check'} size={12} /></span>}
        <span>{running
          ? `Aside is working · ${workedFor(run.startedAt)}`
          : failed ? `Run stopped after ${workedFor(run.startedAt, run.finishedAt)}` : `Worked for ${workedFor(run.startedAt, run.finishedAt)}`}</span>
        <span className="work-latest">{latest}</span>
        <Icon name="chevronRight" size={14} className="work-chevron" />
      </summary>
      {running ? <div className="work-progress" aria-hidden="true"><span /></div> : null}
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

function friendlyModelName(value = '') {
  if (!value) return '';
  return value.split('/').at(-1).replace(/^gpt/i, 'GPT').replace(/[-_]+/g, ' ');
}

function responseMeta(run) {
  if (run.imported) return 'Aside history';
  const values = ['Aside'];
  const model = friendlyModelName(run.model);
  if (model) values.push(model);
  if (run.finishedAt) values.push(workedFor(run.startedAt, run.finishedAt));
  return values.join(' · ');
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

const ConversationTurn = memo(function ConversationTurn({ run, isLatest, onFollowUp }) {
  const { activity, prose } = useMemo(() => splitRunOutput(run.output), [run.output]);
  const failed = ['failed', 'cancelled', 'interrupted'].includes(run.status);
  const meta = responseMeta(run);
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
          <div className="response-actions">
            <span className="response-meta" title={meta}>{meta}</span>
            <CopyResponse value={prose} />
            {isLatest && run.status !== 'running' && onFollowUp ? (
              <button type="button" className="response-action" onClick={onFollowUp} aria-label="Continue this Aside session">
                <Icon name="reply" size={14} />
                <span>Follow up</span>
              </button>
            ) : null}
          </div>
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
  && previous.run.model === next.run.model
  && previous.run.finishedAt === next.run.finishedAt
  && previous.isLatest === next.isLatest
  && previous.onFollowUp === next.onFollowUp
));

export const ThreadView = memo(function ThreadView({ runs, onFollowUp }) {
  if (!runs.length) {
    return (
      <div className="thread-empty" role="status">
        <Spinner />
        <span>Loading this Aside session…</span>
      </div>
    );
  }
  return (
    <div className="thread-view">
      {runs.map((run, index) => (
        <ConversationTurn
          key={run.id}
          run={run}
          isLatest={index === runs.length - 1}
          onFollowUp={onFollowUp}
        />
      ))}
    </div>
  );
});
