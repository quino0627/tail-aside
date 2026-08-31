import { memo, useDeferredValue, useMemo, useState } from 'react';
import { formatRelative, Icon, Spinner } from './Ui';

function groupLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Older';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  const difference = Math.round((today - day) / 86_400_000);
  if (difference <= 0) return 'Today';
  if (difference === 1) return 'Yesterday';
  if (difference < 7) return 'Previous 7 days';
  if (date.getFullYear() === today.getFullYear()) {
    return new Intl.DateTimeFormat(undefined, { month: 'long' }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(date);
}

function groupThreads(threads) {
  const groups = [];
  const running = threads.filter((thread) => thread.status === 'running');
  if (running.length) groups.push({ label: 'Running', threads: running });
  for (const thread of threads) {
    if (thread.status === 'running') continue;
    const label = groupLabel(thread.updatedAt);
    const current = groups.at(-1);
    if (current?.label === label) current.threads.push(thread);
    else groups.push({ label, threads: [thread] });
  }
  return groups;
}

export const SessionList = memo(function SessionList({
  threads,
  loading,
  onOpen,
  onNew,
  onRefresh,
  refreshing = false,
  compact = false,
  activeThreadId = null,
}) {
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const visible = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    if (!needle) return threads;
    return threads.filter((thread) => `${thread.title} ${thread.preview}`.toLowerCase().includes(needle));
  }, [deferredQuery, threads]);
  const groups = useMemo(() => groupThreads(visible), [visible]);
  const headingId = compact ? 'sidebar-session-heading' : 'recent-heading';

  return (
    <section className={`session-section ${compact ? 'is-compact' : ''}`} aria-labelledby={headingId}>
      <div className="section-heading">
        <h2 id={headingId}>{compact ? 'Sessions' : 'Recent sessions'}</h2>
        <span className="section-heading-actions">
          {onRefresh ? (
            <button type="button" className="mini-icon-button" onClick={onRefresh} aria-label="Refresh Aside sessions" disabled={refreshing}>
              {refreshing ? <Spinner label="Refreshing sessions" /> : <Icon name="refresh" size={15} />}
            </button>
          ) : null}
          {!compact ? (
            <button type="button" className="text-button" onClick={onNew}>
              <Icon name="plus" size={15} /> New session
            </button>
          ) : null}
        </span>
      </div>
      <label className="search-field">
        <Icon name="search" size={17} />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={compact ? 'Search' : 'Search sessions'}
          aria-label="Search sessions"
          autoCapitalize="none"
          autoCorrect="off"
        />
      </label>

      {loading && !threads.length ? <p className="session-empty">Loading your Aside sessions…</p> : null}
      {!loading && !visible.length ? (
        <div className="session-empty-state">
          <Icon name={query ? 'search' : 'terminal'} size={20} />
          <p>{query ? 'No sessions match that search.' : 'Your Aside sessions will appear here.'}</p>
          {!query ? <button type="button" onClick={onNew}>Start a session</button> : null}
        </div>
      ) : null}

      <div className="session-groups">
        {groups.map((group) => (
          <section className="session-group" key={group.label} aria-label={group.label}>
            <h3 className="session-group-label">{group.label}</h3>
            <div className="session-list">
              {group.threads.map((thread) => (
                <button
                  type="button"
                  className={`session-row ${thread.id === activeThreadId ? 'is-current' : ''}`}
                  key={thread.id}
                  onClick={() => onOpen(thread.id)}
                  aria-current={thread.id === activeThreadId ? 'page' : undefined}
                >
                  <span className="session-copy">
                    <span className="session-title">{thread.title}</span>
                    <span className="session-preview-line">
                      <span className="session-preview">{thread.preview || (thread.canContinue ? 'Ready to continue' : 'Aside session')}</span>
                      {thread.turnCount ? <span className="turn-count">{thread.turnCount} {thread.turnCount === 1 ? 'turn' : 'turns'}</span> : null}
                    </span>
                  </span>
                  <span className="session-meta">
                    {thread.status === 'running' ? <Spinner label="Session is running" /> : null}
                    <time dateTime={thread.updatedAt} title={new Date(thread.updatedAt).toLocaleString()}>{formatRelative(thread.updatedAt)}</time>
                    <Icon name="chevronRight" size={15} />
                  </span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
});
