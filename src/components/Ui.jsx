const ICON_PATHS = {
  arrowLeft: 'm15 18-6-6 6-6',
  arrowDown: 'M12 5v14m0 0 5.5-5.5M12 19l-5.5-5.5',
  arrowUp: 'M12 19V5m0 0L6.5 10.5M12 5l5.5 5.5',
  check: 'm5 12 4.2 4.2L19 6.5',
  chevronDown: 'm7 10 5 5 5-5',
  chevronRight: 'm9 18 6-6-6-6',
  close: 'M6 6l12 12M18 6 6 18',
  copy: 'M9 9h10v10H9zM5 15H4V4h11v1',
  external: 'M14 5h5v5M19 5l-8 8M18 13v6H5V6h6',
  lock: 'M7 11h10v9H7zM9 11V8a3 3 0 0 1 6 0v3',
  panel: 'M4 5h16v14H4zM8.5 5v14M12 9h4M12 13h4',
  plus: 'M12 5v14M5 12h14',
  refresh: 'M20 11a8 8 0 1 0 1 4M20 5v6h-6',
  reply: 'M9 7 5 11l4 4M5 11h7a7 7 0 0 1 7 7v1',
  search: 'm21 21-4.35-4.35M10.8 18a7.2 7.2 0 1 1 0-14.4 7.2 7.2 0 0 1 0 14.4Z',
  settings: 'M12 15.25A3.25 3.25 0 1 0 12 8.75a3.25 3.25 0 0 0 0 6.5ZM19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.04 2.04-.06-.06A1.7 1.7 0 0 0 15.82 18a1.7 1.7 0 0 0-1.02 1.55V19.7h-2.88v-.15A1.7 1.7 0 0 0 10.9 18a1.7 1.7 0 0 0-1.88.34l-.06.06-2.04-2.04.06-.06A1.7 1.7 0 0 0 7.32 14.42 1.7 1.7 0 0 0 5.8 13.4h-.15v-2.88h.15a1.7 1.7 0 0 0 1.52-1.02 1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.04-2.04.06.06a1.7 1.7 0 0 0 1.88.34 1.7 1.7 0 0 0 1.02-1.52v-.15h2.88v.15a1.7 1.7 0 0 0 1.02 1.52 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.04 2.04-.06.06a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.52 1.02h.15v2.88h-.15A1.7 1.7 0 0 0 19.4 15Z',
  stop: 'M7.5 7.5h9v9h-9z',
  terminal: 'M5 5h14v14H5zM8 9l2.2 2.2L8 13.4m4 0h4',
};

export function Icon({ name, size = 18, strokeWidth = 1.75, className = '' }) {
  return (
    <svg
      className={`icon ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICON_PATHS[name] || ICON_PATHS.panel} />
    </svg>
  );
}

export function TailMark({ size = 31, className = '' }) {
  return (
    <svg
      className={`tail-mark ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
    >
      <path d="M7 27.5c7.5 0 7.8-15 16.3-15 5.6 0 6.8 5.5 9.7 5.5" stroke="currentColor" strokeWidth="2.7" strokeLinecap="round" />
      <circle cx="7" cy="27.5" r="3.2" fill="currentColor" />
      <circle cx="33" cy="18" r="3.2" fill="currentColor" />
    </svg>
  );
}

export function Brand({ compact = false }) {
  return (
    <span className={`brand ${compact ? 'is-compact' : ''}`}>
      <TailMark size={compact ? 25 : 31} />
      <span className="brand-name">tail-aside</span>
    </span>
  );
}

export function Spinner({ label = 'Working' }) {
  return <span className="spinner" role="status" aria-label={label} />;
}

export function formatRelative(value) {
  if (!value) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 50) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(value));
}

export function workedFor(start, finish) {
  if (!start) return 'a moment';
  const end = finish ? new Date(finish).getTime() : Date.now();
  const seconds = Math.max(0, Math.floor((end - new Date(start).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
}
