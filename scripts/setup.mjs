#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detectAsideAccount,
  detectTailscaleIdentity,
  findExecutable,
} from '../lib/config.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOME_DIRECTORY = os.homedir();
const USER_ID = process.getuid?.();
const LABEL = 'com.tail-aside.app';

function parseArgs(argv) {
  const options = {
    port: 4180,
    launchd: process.platform === 'darwin',
    serve: true,
    allowAnyTailnetUser: false,
    forceServe: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--port') options.port = Number(argv[++index]);
    else if (value === '--no-launchd') options.launchd = false;
    else if (value === '--no-serve') options.serve = false;
    else if (value === '--allow-any-tailnet-user') options.allowAnyTailnetUser = true;
    else if (value === '--force-serve') options.forceServe = true;
    else if (value === '--help' || value === '-h') options.help = true;
    else throw new Error(`Unknown option: ${value}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new Error('--port must be between 1 and 65535.');
  }
  return options;
}

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(file)} exited with code ${code}.`)));
  });
}

function capture(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 15_000, maxBuffer: 500_000, ...options }, (error, stdout, stderr) => {
      resolve({ error, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function plistFor({ configPath, stateDirectory }) {
  const logPath = path.join(stateDirectory, 'tail-aside.log');
  const errorLogPath = path.join(stateDirectory, 'tail-aside-error.log');
  const safePath = [
    path.dirname(process.execPath),
    path.join(HOME_DIRECTORY, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].join(':');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(path.join(ROOT, 'server.mjs'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TAIL_ASIDE_CONFIG</key><string>${xmlEscape(configPath)}</string>
    <key>PATH</key><string>${xmlEscape(safePath)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(errorLogPath)}</string>
</dict>
</plist>
`;
}

function localHealth(port, timeout = 1_500) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout }, (response) => {
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

async function waitForHealth(port) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const health = await localHealth(port);
    if (health?.status === 200 && health.value?.service === 'tail-aside') return health.value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('tail-aside did not become healthy. Run npm run doctor for details.');
}

async function writePrivateJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(filePath), 0o700);
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, 0o600);
}

async function installLaunchAgent({ configPath, stateDirectory, port }) {
  if (!Number.isInteger(USER_ID)) throw new Error('Unable to determine the current macOS user ID.');
  const current = await localHealth(port);
  if (current && current.value?.service !== 'tail-aside') {
    throw new Error(`Port ${port} is already used by another service. Choose a different --port or stop it yourself.`);
  }

  const agentsDirectory = path.join(HOME_DIRECTORY, 'Library', 'LaunchAgents');
  const plistPath = path.join(agentsDirectory, `${LABEL}.plist`);
  await fs.mkdir(agentsDirectory, { recursive: true });
  await fs.writeFile(plistPath, plistFor({ configPath, stateDirectory }), { mode: 0o600 });

  await capture('/bin/launchctl', ['bootout', `gui/${USER_ID}/${LABEL}`]);
  const result = await capture('/bin/launchctl', ['bootstrap', `gui/${USER_ID}`, plistPath]);
  if (result.error) throw new Error(`launchctl could not start tail-aside: ${result.stderr.trim() || result.error.message}`);
  await waitForHealth(port);
  return plistPath;
}

async function configureServe({ tailscaleBin, dnsName, port, forceServe }) {
  const status = await capture(tailscaleBin, ['serve', 'status', '--json']);
  let current = {};
  try {
    current = JSON.parse(status.stdout || '{}');
  } catch {
    // An empty Serve configuration is valid.
  }
  const hostKey = `${dnsName}:${port}`;
  const existingProxy = current?.Web?.[hostKey]?.Handlers?.['/']?.Proxy;
  const expectedProxy = `http://127.0.0.1:${port}`;
  if (existingProxy && existingProxy !== expectedProxy && !forceServe) {
    throw new Error(`${hostKey} already proxies to ${existingProxy}. Re-run with --force-serve only if you intend to replace that exact mapping.`);
  }
  if (existingProxy !== expectedProxy) {
    await run(tailscaleBin, ['serve', '--bg', `--https=${port}`, expectedProxy]);
  }
  return `https://${hostKey}/`;
}

function printHelp() {
  process.stdout.write(`tail-aside setup

Usage: npm run setup -- [options]

  --port <number>               Local and Tailnet HTTPS port (default: 4180)
  --no-launchd                  Build and configure without a macOS LaunchAgent
  --no-serve                    Do not change Tailscale Serve
  --allow-any-tailnet-user      Allow every authenticated member of this tailnet
  --force-serve                 Replace an existing mapping on this exact HTTPS port
  -h, --help                    Show this help
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return printHelp();
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  if (nodeMajor < 22 || nodeMajor === 22 && nodeMinor < 12) throw new Error('tail-aside requires Node.js 22.12 or newer.');

  const asideBin = await findExecutable('aside', [path.join(HOME_DIRECTORY, '.local', 'bin', 'aside')]);
  if (!asideBin) throw new Error('Aside CLI was not found. Install and sign in to Aside first.');
  const account = await detectAsideAccount(asideBin);
  if (!account) throw new Error('No signed-in Aside account was found. Run aside account list first.');

  const tailscaleBin = await findExecutable('tailscale', ['/Applications/Tailscale.app/Contents/MacOS/Tailscale']);
  const identity = await detectTailscaleIdentity(tailscaleBin);
  if (options.serve && (!tailscaleBin || !identity?.dnsName)) {
    throw new Error('Tailscale is not connected. Connect it first, or use --no-serve for local-only setup.');
  }

  const configPath = path.join(HOME_DIRECTORY, '.config', 'tail-aside', 'config.json');
  const stateDirectory = path.join(HOME_DIRECTORY, '.local', 'state', 'tail-aside');
  const sessionDirectory = path.join(HOME_DIRECTORY, '.aside', 'u', account.slice(1), 'sessions');
  await writePrivateJson(configPath, {
    host: '127.0.0.1',
    port: options.port,
    asideBin,
    account,
    sessionDirectory,
    stateDirectory,
    tailscaleBin,
    allowedLogins: identity?.login ? [identity.login] : [],
    allowAnyTailnetUser: options.allowAnyTailnetUser,
    defaults: { model: '', speed: 'fast', effort: 'minimal' },
  });
  await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await fs.chmod(stateDirectory, 0o700);

  if (process.env.npm_execpath) await run(process.execPath, [process.env.npm_execpath, 'run', 'build'], { cwd: ROOT });
  else {
    const npmBin = await findExecutable('npm');
    if (!npmBin) throw new Error('npm was not found; run npm run build manually.');
    await run(npmBin, ['run', 'build'], { cwd: ROOT });
  }

  let plistPath = null;
  if (options.launchd) plistPath = await installLaunchAgent({ configPath, stateDirectory, port: options.port });
  let tailnetUrl = null;
  if (options.serve) tailnetUrl = await configureServe({ tailscaleBin, dnsName: identity.dnsName, port: options.port, forceServe: options.forceServe });

  process.stdout.write('\nSetup complete.\n');
  process.stdout.write(`Config: ${configPath}\n`);
  if (plistPath) process.stdout.write(`LaunchAgent: ${plistPath}\n`);
  if (tailnetUrl) process.stdout.write(`Open on your phone: ${tailnetUrl}\n`);
  if (!options.launchd) process.stdout.write('Start locally with: npm start\n');
  process.stdout.write('Verify with: npm run doctor\n');
}

main().catch((error) => {
  process.stderr.write(`Setup failed: ${error.message}\n`);
  process.exitCode = 1;
});
