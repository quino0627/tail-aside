import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Icon, Spinner, workedFor } from './Ui';

function isActivityLine(line) {
  return /^(thinking:|plan:|tool|repl\(|openTab\(|listBrowserTabs\(|readFile\(|writeFile\(|click\(|fill\(|navigate\(|browser|\[?step|\$ |> )/i.test(line);
}

function splitOutput(output = '') {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/created\s+new\s+session/i.test(line));
  return {
    activity: lines.filter(isActivityLine).slice(-32),
    prose: lines.filter((line) => !isActivityLine(line)).slice(-160),
  };
}

function WorkFold({ run }) {
  const { activity } = splitOutput(run.output);
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

function ConversationTurn({ run }) {
  const { prose } = splitOutput(run.output);
  const failed = ['failed', 'cancelled', 'interrupted'].includes(run.status);
  return (
    <article className="conversation-turn">
      <div className="user-message selectable">{run.prompt}</div>
      <WorkFold run={run} />
      {prose.length ? (
        <div className="assistant-message markdown-body selectable">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ node: _node, children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
              img: ({ node: _node, alt }) => <span className="markdown-image-placeholder">[Image: {alt || 'attachment'}]</span>,
            }}
          >
            {prose.join('\n')}
          </ReactMarkdown>
        </div>
      ) : null}
      {failed ? (
        <p className="run-error">
          {run.status === 'cancelled' ? 'Run stopped.' : 'Aside could not complete this run. Expand the work log for details.'}
        </p>
      ) : null}
    </article>
  );
}

export const ThreadView = memo(function ThreadView({ runs }) {
  if (!runs.length) return <p className="thread-empty">Loading this Aside session…</p>;
  return <div className="thread-view">{runs.map((run) => <ConversationTurn key={run.id} run={run} />)}</div>;
});
