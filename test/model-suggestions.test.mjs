import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelSuggestions } from '../lib/model-suggestions.mjs';

test('model suggestions follow the installed Aside CLI examples', () => {
  const help = [
    '  -m, --model <model>  Use a model id.',
    '  aside -m openai/gpt-5.4 "Plan this workflow"',
    '  aside --account u1 -m openai-codex/gpt-5.5 "Plan this workflow"',
    '  aside --model claude-opus-4-6 --provider anthropic "Research deeply"',
  ].join('\n');

  assert.deepEqual(parseModelSuggestions(help), [
    'openai/gpt-5.4',
    'openai-codex/gpt-5.5',
    'anthropic/claude-opus-4-6',
  ]);
});

test('model suggestions keep a configured default first and remove duplicates', () => {
  const help = 'aside -m custom/model\naside --model custom/model';
  assert.deepEqual(parseModelSuggestions(help, 'custom/model'), ['custom/model']);
  assert.deepEqual(parseModelSuggestions('aside --model <model>'), []);
});
