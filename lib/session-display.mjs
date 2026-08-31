const LEADING_URL = /^https?:\/\/[^\s]+/i;

function compact(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

function trimTo(value, limit) {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

export function sessionTitle(value, limit = 56) {
  let title = compact(value);
  if (!title) return '';

  const urlMatch = title.match(LEADING_URL);
  if (urlMatch) {
    const rawUrl = urlMatch[0];
    try {
      const parsed = new URL(rawUrl);
      const host = parsed.hostname.replace(/^www\./i, '');
      const remainder = compact(title.slice(rawUrl.length)).replace(/^[—–:;,.!?\-\s]+/, '');
      title = remainder ? `${host} — ${remainder}` : host;
    } catch {
      // Keep the original text when the URL parser rejects a partial URL.
    }
  }

  return trimTo(title, limit);
}
