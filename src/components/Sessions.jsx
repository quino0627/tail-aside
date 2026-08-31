import { memo, useMemo, useState } from 'react';
import { formatRelative, Icon, Spinner } from './Ui';

export const SessionList = memo(function SessionList({ threads, loading, onOpen, onNew }) {
  const [query, setQuery] = useState('');
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return threads;
    return threads.filter((thread) => `${thread.title} ${thread.preview}`.toLowerCase().includes(needle));
  }, [query, threads]);

  return (
    <section className="session-section" aria-labelledby="recent-heading">
      <div className="section-heading">
        <h2 id="recent-heading">Recent sessions</h2>
        <button type="button" className="text-button" onClick={onNew}>
          <Icon name="plus" size={15} /> New session
        </button>
      </div>
      <label className="search-field">
        <Icon name="search" size={17} />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search sessions"
          aria-label="Search sessions"
        />
      </label>

      {loading && !threads.length ? <p className="session-empty">Loading your Aside sessions…</p> : null}
      {!loading && !visible.length ? (
        <p className="session-empty">{query ? 'No sessions match that search.' : 'Your Aside sessions will appear here.'}</p>
      ) : null}

      <div className="session-list">
        {visible.map((thread) => (
          <button type="button" className="session-row" key={thread.id} onClick={() => onOpen(thread.id)}>
            <span className="session-copy">
              <span className="session-title">{thread.title}</span>
              <span className="session-preview">{thread.preview || (thread.canContinue ? 'Ready to continue' : 'Aside session')}</span>
            </span>
            <span className="session-meta">
              {thread.status === 'running' ? <Spinner label="Session is running" /> : null}
              <time dateTime={thread.updatedAt}>{formatRelative(thread.updatedAt)}</time>
              <Icon name="chevronRight" size={15} />
            </span>
          </button>
        ))}
      </div>
    </section>
  );
});
