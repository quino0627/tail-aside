#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import { loadConfig, detectTailscaleIdentity } from '../lib/config.mjs';

function capture(file, args) {
  return new Promise((resolve) => {
    if (!file) return resolve({ error: new Error('not found'), stdout: '', stderr: '' });
    execFile(file, args, { timeout: 15_000, maxBuffer: 500_000 }, (error, stdout, stderr) => {
      resolve({ error, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function localHealth(port) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 2_000 }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch {
          resolve({ status: response.statusCode, value: null });
        }
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
  });
}

async function main() {
  const config = await loadConfig();
  const checks = [];
  function check(name, ok, detail) {
    checks.push({ name, ok, detail });
    process.stdout.write(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}\n`);
  }

  const [major, minor] = process.versions.node.split('.').map(Number);
  check('Node.js', major > 22 || major === 22 && minor >= 12, process.versions.node);

  const asideVersion = await capture(config.asideBin, ['--version']);
  check('Aside CLI', !asideVersion.error, asideVersion.error ? 'not available' : asideVersion.stdout.trim().split(/\r?\n/)[0]);
  const asideAccount = await capture(config.asideBin, ['account', 'status', config.account]);
  check('Aside account', /signed in/i.test(`${asideAccount.stdout}\n${asideAccount.stderr}`), config.account);

  let sessionDirectoryOk = false;
  try {
    sessionDirectoryOk = (await fs.stat(config.sessionDirectory)).isDirectory();
  } catch {
    sessionDirectoryOk = false;
  }
  check('Aside sessions', sessionDirectoryOk, sessionDirectoryOk ? 'readable' : 'directory not found');
  check('Tailnet policy', config.allowAnyTailnetUser || config.allowedLogins.length > 0, config.allowAnyTailnetUser ? 'any authenticated tailnet user' : `${config.allowedLogins.length} allowed user(s)`);

  const identity = await detectTailscaleIdentity(config.tailscaleBin);
  check('Tailscale', Boolean(identity), identity ? 'connected identity detected' : 'not connected');

  const health = await localHealth(config.port);
  check('Local server', health?.status === 200 && health.value?.service === 'tail-aside', health ? `HTTP ${health.status}` : `nothing on 127.0.0.1:${config.port}`);
  if (health?.value) check('Aside health', health.value.ok === true, health.value.ok ? 'ready' : 'CLI or sign-in needs attention');

  if (identity?.dnsName && config.tailscaleBin) {
    const serve = await capture(config.tailscaleBin, ['serve', 'status', '--json']);
    let proxy = null;
    try {
      proxy = JSON.parse(serve.stdout)?.Web?.[`${identity.dnsName}:${config.port}`]?.Handlers?.['/']?.Proxy || null;
    } catch {
      proxy = null;
    }
    check('Tailscale Serve', proxy === `http://127.0.0.1:${config.port}`, proxy || 'mapping not found');
  }

  if (checks.some((item) => !item.ok)) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`Doctor failed: ${error.message}\n`);
  process.exitCode = 1;
});
