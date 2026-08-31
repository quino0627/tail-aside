import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authorizeRequest,
  buildAsideArgs,
  isLoopbackAddress,
  isLoopbackHost,
  validateRunBody,
  validateStateChangeRequest,
} from '../lib/security.mjs';

const config = {
  allowedLogins: ['owner@example.com'],
  allowAnyTailnetUser: false,
};

function request({ host = 'device.example.ts.net:4180', remoteAddress = '127.0.0.1', headers = {} } = {}) {
  return {
    headers: { host, ...headers },
    socket: { remoteAddress },
  };
}

test('loopback helpers accept only loopback addresses and hosts', () => {
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('100.64.0.2'), false);
  assert.equal(isLoopbackHost('localhost:4180'), true);
  assert.equal(isLoopbackHost('device.example.ts.net:4180'), false);
});

test('localhost API requests are accepted without forwarded identity headers', () => {
  const result = authorizeRequest(request({ host: '127.0.0.1:4180' }), config);
  assert.deepEqual(result, { ok: true, kind: 'local', login: 'local' });
});

test('Tailnet API requests require an allowed Tailscale login', () => {
  const allowed = authorizeRequest(request({ headers: {
    'tailscale-user-login': 'OWNER@example.com',
    'tailscale-user-name': 'Owner',
  } }), config);
  assert.equal(allowed.ok, true);
  assert.equal(allowed.kind, 'tailnet');

  const denied = authorizeRequest(request({ headers: { 'tailscale-user-login': 'other@example.com' } }), config);
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 403);

  const missing = authorizeRequest(request(), config);
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 401);
});

test('state-changing requests require JSON, marker, and same-origin metadata', () => {
  const valid = request({ headers: {
    'content-type': 'application/json; charset=utf-8',
    'x-tail-aside': '1',
    'sec-fetch-site': 'same-origin',
    origin: 'https://device.example.ts.net:4180',
  } });
  assert.deepEqual(validateStateChangeRequest(valid), { ok: true });

  assert.equal(validateStateChangeRequest(request({ headers: { 'content-type': 'application/json' } })).status, 403);
  assert.equal(validateStateChangeRequest(request({ headers: {
    'content-type': 'application/json',
    'x-tail-aside': '1',
    'sec-fetch-site': 'cross-site',
  } })).status, 403);
});

test('run validation preserves safe model settings and explicit send approval', () => {
  const normal = validateRunBody({
    prompt: 'Inspect this page',
    model: 'openai/gpt-5.4',
    effort: 'high',
    speed: 'fast',
  });
  assert.equal(normal.error, undefined);
  assert.equal(normal.value.model, 'openai/gpt-5.4');
  assert.equal(normal.value.effort, 'high');

  const unapproved = validateRunBody({ prompt: 'Send it', mode: 'send' });
  assert.match(unapproved.error, /exact target/i);

  const approved = validateRunBody({
    prompt: 'Send it',
    mode: 'send',
    target: 'the current support chat',
    message: 'Hello',
    confirmation: 'SEND',
    externalAction: true,
  });
  assert.equal(approved.error, undefined);
});

test('Aside arguments continue the same session and terminate option parsing', () => {
  const args = buildAsideArgs({
    account: 'u0',
    body: { speed: 'fast', effort: 'minimal', model: 'test/model' },
    continuationSessionId: 'session_123',
    prompt: '--prompt-that-looks-like-an-option',
  });
  assert.deepEqual(args, [
    'exec', '--account', 'u0', '--speed', 'fast', '--effort', 'minimal',
    '--model', 'test/model', '--session', 'session_123', '--', '--prompt-that-looks-like-an-option',
  ]);
});
