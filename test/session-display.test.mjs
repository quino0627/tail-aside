import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionTitle } from '../lib/session-display.mjs';

test('session titles turn leading URLs into readable host labels', () => {
  assert.equal(
    sessionTitle('https://partners.example.com/member/signin?next=%2F 이거 회원가입 좀'),
    'partners.example.com — 이거 회원가입 좀',
  );
  assert.equal(sessionTitle('https://www.example.com/really/long/path?with=query'), 'example.com');
});

test('session titles stay compact without changing normal prompts', () => {
  assert.equal(sessionTitle('  Fix   the login redirect  '), 'Fix the login redirect');
  assert.equal(sessionTitle('x'.repeat(80), 20), `${'x'.repeat(19)}…`);
});
