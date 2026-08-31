import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAsideAccountList } from '../lib/config.mjs';

test('parseAsideAccountList prefers the active signed-in account', () => {
  const output = `
    u0  signed in
  * u2  signed in
    u3  signed out
  `;
  assert.equal(parseAsideAccountList(output), 'u2');
});

test('parseAsideAccountList falls back to the first signed-in account', () => {
  assert.equal(parseAsideAccountList('u4  signed in\nu5  signed in'), 'u4');
  assert.equal(parseAsideAccountList('u4  signed out'), null);
});
