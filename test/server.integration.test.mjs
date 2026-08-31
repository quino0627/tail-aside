import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function openPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return response.json();
    } catch {
      // Server startup can take a moment on CI.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('test server did not become healthy');
}

test('server exposes a local health API and protects POST routes', async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'tail-aside-test-'));
  const port = await openPort();
  const asideBin = path.join(temporary, 'aside');
  const sessions = path.join(temporary, 'sessions');
  const state = path.join(temporary, 'state');
  const configPath = path.join(temporary, 'config.json');
  await fs.mkdir(sessions);
  await fs.writeFile(asideBin, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "Aside 1.2.3"; exit 0; fi
if [ "$1" = "account" ] && [ "$2" = "status" ]; then echo "signed in"; exit 0; fi
if [ "$1" = "account" ] && [ "$2" = "list" ]; then echo "* u0 signed in"; exit 0; fi
if [ "$1" = "repl" ]; then echo 'ASIDE_TABS_JSON:[]'; exit 0; fi
echo "created new session: test_session"
echo "Test response"
`, { mode: 0o700 });
  await fs.writeFile(configPath, JSON.stringify({
    host: '127.0.0.1',
    port,
    asideBin,
    account: 'u0',
    sessionDirectory: sessions,
    stateDirectory: state,
    allowedLogins: ['owner@example.com'],
  }));

  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, TAIL_ASIDE_CONFIG: configPath },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  context.after(async () => {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await fs.rm(temporary, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const health = await waitForHealth(baseUrl);
  assert.equal(health.service, 'tail-aside');
  assert.equal(health.ok, true, stderr);

  const blocked = await fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'test' }),
  });
  assert.equal(blocked.status, 403);

  const accepted = await fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Tail-Aside': '1' },
    body: JSON.stringify({ prompt: 'test', effort: 'minimal', speed: 'fast' }),
  });
  assert.equal(accepted.status, 202, await accepted.text());
});
