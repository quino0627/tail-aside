import net from 'node:net';

export const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), display-capture=(), geolocation=(), microphone=(), payment=(), usb=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
});

const EFFORTS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultrabrowse']);
const SPEEDS = new Set(['default', 'fast']);
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,159}$/;
const THREAD_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

function singleHeader(value) {
  return Array.isArray(value) ? value[0] : value;
}

export function isLoopbackAddress(address = '') {
  const normalized = String(address).replace(/^::ffff:/, '');
  return normalized === '::1' || normalized === '127.0.0.1' || normalized.startsWith('127.');
}

export function isLoopbackHost(hostHeader = '') {
  const raw = String(hostHeader).trim();
  if (!raw) return false;
  try {
    const hostname = new URL(`http://${raw}`).hostname;
    return hostname === 'localhost' || hostname === '[::1]' || net.isIP(hostname) > 0 && isLoopbackAddress(hostname);
  } catch {
    return false;
  }
}

export function authorizeRequest(req, config) {
  const remoteAddress = req.socket?.remoteAddress || '';
  if (isLoopbackAddress(remoteAddress) && isLoopbackHost(req.headers.host)) {
    return { ok: true, kind: 'local', login: 'local' };
  }

  const login = String(singleHeader(req.headers['tailscale-user-login']) || '').trim().toLowerCase();
  const displayName = String(singleHeader(req.headers['tailscale-user-name']) || '').trim();
  if (!login) {
    return {
      ok: false,
      status: 401,
      error: 'This API is available only through Tailscale Serve or localhost.',
    };
  }
  if (!config.allowAnyTailnetUser && !config.allowedLogins.includes(login)) {
    return {
      ok: false,
      status: 403,
      error: 'This Tailscale user is not allowed to use tail-aside.',
    };
  }
  return { ok: true, kind: 'tailnet', login, displayName };
}

export function validateStateChangeRequest(req) {
  const contentType = String(singleHeader(req.headers['content-type']) || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    return { ok: false, status: 415, error: 'State-changing requests must use application/json.' };
  }
  if (singleHeader(req.headers['x-tail-aside']) !== '1') {
    return { ok: false, status: 403, error: 'Missing tail-aside request marker.' };
  }
  const fetchSite = String(singleHeader(req.headers['sec-fetch-site']) || '').toLowerCase();
  if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) {
    return { ok: false, status: 403, error: 'Cross-site requests are not allowed.' };
  }
  const origin = String(singleHeader(req.headers.origin) || '').trim();
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) {
        return { ok: false, status: 403, error: 'Request origin does not match this tail-aside instance.' };
      }
    } catch {
      return { ok: false, status: 403, error: 'Request origin is invalid.' };
    }
  }
  return { ok: true };
}

export function validateRunBody(body, maxPromptLength = 8000, defaults = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Request body must be a JSON object.' };
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const mode = body.mode === 'send' ? 'send' : 'readonly';
  const threadId = typeof body.threadId === 'string' && body.threadId.trim() ? body.threadId.trim() : null;
  const effort = EFFORTS.has(body.effort) ? body.effort : defaults.effort || 'minimal';
  const speed = SPEEDS.has(body.speed) ? body.speed : defaults.speed || 'fast';
  const model = typeof body.model === 'string' ? body.model.trim() : defaults.model || '';

  if (threadId && !THREAD_PATTERN.test(threadId)) return { error: 'Conversation identifier is invalid.' };
  if (!prompt) return { error: 'Enter a message for Aside.' };
  if (prompt.length > maxPromptLength) return { error: `Messages must be ${maxPromptLength} characters or fewer.` };
  if (!EFFORTS.has(effort)) return { error: 'Reasoning effort is invalid.' };
  if (!SPEEDS.has(speed)) return { error: 'Speed is invalid.' };
  if (model && !MODEL_PATTERN.test(model)) return { error: 'Model name contains unsupported characters.' };

  const common = { prompt, mode, title: body.title, threadId, effort, speed, model };
  if (mode !== 'send') return { value: common };

  const target = typeof body.target === 'string' ? body.target.trim() : '';
  const message = typeof body.message === 'string' ? body.message : '';
  if (!target || !message.trim()) return { error: 'Enter both the exact target and exact message.' };
  if (target.length > 300 || message.length > 10_000) return { error: 'The target or message is too long.' };
  if (body.confirmation !== 'SEND') return { error: 'Type SEND to approve this external action.' };
  if (body.externalAction !== true) return { error: 'Confirm the external action before continuing.' };
  return { value: { ...common, target, message } };
}

export function buildAsideArgs({ account, body, continuationSessionId = null, prompt }) {
  const args = [
    'exec',
    '--account', account,
    '--speed', body.speed,
    '--effort', body.effort,
  ];
  if (body.model) args.push('--model', body.model);
  if (continuationSessionId) args.push('--session', continuationSessionId);
  args.push('--', prompt);
  return args;
}
