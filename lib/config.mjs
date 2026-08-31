import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_PORT = 4180;

function execFileResult(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, {
      timeout: 12_000,
      maxBuffer: 240_000,
      ...options,
    }, (error, stdout, stderr) => resolve({
      error,
      stdout: stdout || '',
      stderr: stderr || '',
    }));
  });
}

async function isExecutable(filePath) {
  if (!filePath) return false;
  try {
    await fs.access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findExecutable(name, preferred = []) {
  for (const candidate of preferred) {
    if (await isExecutable(candidate)) return candidate;
  }

  const pathEntries = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean);
  for (const directory of pathEntries) {
    const candidate = path.join(directory, name);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

export function parseAsideAccountList(output = '') {
  const rows = String(output).split(/\r?\n/);
  const signedIn = [];
  for (const row of rows) {
    const match = row.match(/^\s*(\*)?\s*(u\d+)\b.*\bsigned\s+in\b/i);
    if (match) signedIn.push({ account: match[2], active: Boolean(match[1]) });
  }
  return signedIn.find((entry) => entry.active)?.account || signedIn[0]?.account || null;
}

export async function detectAsideAccount(asideBin) {
  if (!asideBin) return null;
  const result = await execFileResult(asideBin, ['account', 'list']);
  if (result.error && !result.stdout && !result.stderr) return null;
  return parseAsideAccountList(`${result.stdout}\n${result.stderr}`);
}

export async function detectTailscaleIdentity(tailscaleBin) {
  if (!tailscaleBin) return null;
  const result = await execFileResult(tailscaleBin, ['status', '--json']);
  if (result.error || !result.stdout) return null;
  try {
    const status = JSON.parse(result.stdout);
    const userId = String(status?.Self?.UserID ?? '');
    const user = status?.User?.[userId] || status?.User?.[Number(userId)] || null;
    const login = typeof user?.LoginName === 'string' ? user.LoginName.trim().toLowerCase() : '';
    const dnsName = typeof status?.Self?.DNSName === 'string'
      ? status.Self.DNSName.replace(/\.$/, '')
      : '';
    return login ? { login, dnsName } : null;
  } catch {
    return null;
  }
}

function parsePort(value, fallback = DEFAULT_PORT) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : fallback;
}

function normalizeLoginList(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(values
    .map((entry) => String(entry).trim().toLowerCase())
    .filter(Boolean))];
}

async function readConfig(configPath) {
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Unable to read tail-aside config at ${configPath}: ${error.message}`);
  }
}

export async function loadConfig(options = {}) {
  const homeDirectory = options.homeDirectory || os.homedir();
  const configPath = options.configPath
    || process.env.TAIL_ASIDE_CONFIG
    || path.join(homeDirectory, '.config', 'tail-aside', 'config.json');
  const fileConfig = await readConfig(configPath);

  const configuredAsideBin = process.env.TAIL_ASIDE_BIN
    || process.env.ASIDE_BIN
    || fileConfig.asideBin;
  const asideBin = await findExecutable('aside', [
    configuredAsideBin,
    path.join(homeDirectory, '.local', 'bin', 'aside'),
  ].filter(Boolean));

  const configuredAccount = process.env.TAIL_ASIDE_ACCOUNT
    || process.env.ASIDE_ACCOUNT
    || fileConfig.account;
  const account = /^u\d+$/.test(String(configuredAccount || ''))
    ? String(configuredAccount)
    : await detectAsideAccount(asideBin) || 'u0';

  const stateDirectory = path.resolve(process.env.TAIL_ASIDE_STATE_DIR
    || fileConfig.stateDirectory
    || path.join(homeDirectory, '.local', 'state', 'tail-aside'));
  const sessionDirectory = path.resolve(process.env.TAIL_ASIDE_SESSION_DIR
    || process.env.ASIDE_SESSION_DIRECTORY
    || fileConfig.sessionDirectory
    || path.join(homeDirectory, '.aside', 'u', account.slice(1), 'sessions'));
  const tailscaleBin = await findExecutable('tailscale', [
    process.env.TAILSCALE_BIN,
    fileConfig.tailscaleBin,
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  ].filter(Boolean));

  const explicitAllowedLogins = process.env.TAIL_ASIDE_ALLOWED_LOGINS
    || fileConfig.allowedLogins;
  let allowedLogins = normalizeLoginList(explicitAllowedLogins);
  let detectedTailnetIdentity = null;
  if (!allowedLogins.length && options.detectIdentity !== false) {
    detectedTailnetIdentity = await detectTailscaleIdentity(tailscaleBin);
    if (detectedTailnetIdentity?.login) allowedLogins = [detectedTailnetIdentity.login];
  }

  return Object.freeze({
    product: 'tail-aside',
    configPath,
    host: process.env.TAIL_ASIDE_HOST
      || process.env.ASIDE_CONSOLE_HOST
      || fileConfig.host
      || '127.0.0.1',
    port: parsePort(
      process.env.TAIL_ASIDE_PORT
        || process.env.ASIDE_CONSOLE_PORT
        || fileConfig.port,
    ),
    asideBin,
    account,
    sessionDirectory,
    stateDirectory,
    tailscaleBin,
    allowedLogins,
    allowAnyTailnetUser: process.env.TAIL_ASIDE_ALLOW_ANY_TAILNET_USER === '1'
      || fileConfig.allowAnyTailnetUser === true,
    defaults: Object.freeze({
      model: typeof fileConfig.defaults?.model === 'string' ? fileConfig.defaults.model : '',
      speed: ['default', 'fast'].includes(fileConfig.defaults?.speed) ? fileConfig.defaults.speed : 'fast',
      effort: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultrabrowse'].includes(fileConfig.defaults?.effort)
        ? fileConfig.defaults.effort
        : 'minimal',
    }),
    detectedTailnetIdentity,
  });
}

export function serializableConfig(config) {
  return {
    host: config.host,
    port: config.port,
    asideBin: config.asideBin,
    account: config.account,
    sessionDirectory: config.sessionDirectory,
    stateDirectory: config.stateDirectory,
    tailscaleBin: config.tailscaleBin,
    allowedLogins: [...config.allowedLogins],
    allowAnyTailnetUser: config.allowAnyTailnetUser,
    defaults: { ...config.defaults },
  };
}
