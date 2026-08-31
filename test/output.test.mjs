import test from 'node:test';
import assert from 'node:assert/strict';
import { splitRunOutput } from '../src/lib/output.js';

test('run output keeps Markdown structure while separating known activity', () => {
  const value = splitRunOutput([
    'thinking: checking the page',
    '',
    '## Result',
    '',
    '> Keep this quoted answer.',
    '',
    '```sh',
    '$ npm run check',
    'tool: this is code, not activity',
    '```',
  ].join('\n'));

  assert.deepEqual(value.activity, ['thinking: checking the page']);
  assert.match(value.prose, /## Result\n\n> Keep this quoted answer/);
  assert.match(value.prose, /\$ npm run check\ntool: this is code, not activity/);
});

test('run output removes only the CLI session announcement', () => {
  const value = splitRunOutput([
    'created new session: secret-id',
    'Actual answer mentions created new session behavior.',
    '```txt',
    'created new session: preserve-this-example',
    '```',
  ].join('\n'));
  assert.match(value.prose, /^Actual answer mentions created new session behavior\./);
  assert.match(value.prose, /created new session: preserve-this-example/);
});
