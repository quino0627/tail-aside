import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { loadConfig } from './lib/config.mjs';
import { sessionTitle } from './lib/session-display.mjs';
import {
  SECURITY_HEADERS,
  authorizeRequest,
  buildAsideArgs,
  validateRunBody,
  validateStateChangeRequest,
} from './lib/security.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');
const CONFIG = await loadConfig();
const HOST = CONFIG.host;
const PORT = CONFIG.port;
const ASIDE_BIN = CONFIG.asideBin;
const ACCOUNT = CONFIG.account;
const STATE_DIRECTORY = CONFIG.stateDirectory;
const STATE_FILE = path.join(STATE_DIRECTORY, 'state.json');
const ASIDE_SESSION_DIRECTORY = CONFIG.sessionDirectory;
const MAX_PROMPT_LENGTH = 8000;
const MAX_OUTPUT_LENGTH = 240000;
const MAX_THREADS = 120;
const MAX_SESSION_SCAN_BYTES = 96 * 1024;
const CACHE_DATABASE_FILE = path.join(STATE_DIRECTORY, 'aside-sessions.sqlite');
const ASIDE_CACHE_SCHEMA_VERSION = 3;
const CATALOG_CACHE_TTL_MS = 45000;
const MAX_IMPORTED_TURNS = 40;
const MAX_TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_IMPORTED_OUTPUT_PER_TURN = 16000;
const RUNTIME_CWD = os.tmpdir();

if (!['127.0.0.1', '::1', 'localhost'].includes(HOST)) {
  throw new Error('tail-aside must listen on localhost. Use Tailscale Serve for Tailnet access.');
}

const threads = new Map();
const runs = new Map();
const transcriptCache = new Map();
const asideCacheFallback = new Map();
let healthCache = { fetchedAt: 0, value: null };
let browserCache = { fetchedAt: 0, value: null };
let stateTimer = null;
let stateWrite = Promise.resolve();
let cacheDb = null;
let asideCatalogFetchedAt = 0;
let asideCatalogPromise = null;

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const COMPRESSIBLE_TYPES = new Set(['.css', '.html', '.js', '.json', '.svg']);

function now() {
  return new Date().toISOString();
}

function stripAnsi(value = '') {
  return value.replace(/[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '');
}

function redactSessionToken(value = '') {
  return stripAnsi(value).replace(/(created\s+new\s+session\s*:\s*)[A-Za-z0-9_-]+/gi, '$1[redacted]');
}

function trimText(value = '', limit = 96) {
  const compact = String(value).replace(/\s+/g, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

function titleFrom(body) {
  const source = body.title || body.prompt || (body.mode === 'send' ? 'External send' : 'Agent chat');
  return sessionTitle(String(source).split(/\r?\n/)[0], 56) || 'New session';
}

function sortedThreads() {
  return [...threads.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function publicRun(run, includeOutput = false) {
  const result = {
    id: run.id,
    threadId: run.threadId,
    title: run.title,
    prompt: run.prompt,
    mode: run.mode,
    target: run.target,
    message: run.message,
    continuation: Boolean(run.continuation),
    imported: Boolean(run.imported),
    model: run.model || '',
    speed: run.speed || CONFIG.defaults.speed,
    effort: run.effort || CONFIG.defaults.effort,
    status: run.status,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    exitCode: run.exitCode,
    outputLength: run.output.length,
  };
  if (includeOutput) result.output = redactSensitive(run.output);
  return result;
}

function publicThread(thread) {
  const latestRun = thread.lastRunId ? runs.get(thread.lastRunId) : null;
  const turnCount = thread.source === 'aside'
    ? Math.max(thread.catalogTurnCount || 0, thread.runIds.length)
    : thread.runIds.length;
  return {
    id: thread.id,
    title: thread.title,
    preview: thread.preview,
    mode: thread.mode,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    turnCount,
    status: latestRun?.status || 'idle',
    sessionState: thread.sessionState,
    canContinue: Boolean(thread.asideSessionId && thread.sessionState === 'active'),
    source: thread.source || 'console',
  };
}

function createThread(body) {
  const createdAt = now();
  const thread = {
    id: randomUUID(),
    source: 'console',
    title: titleFrom(body),
    preview: trimText(body.prompt),
    mode: body.mode,
    createdAt,
    updatedAt: createdAt,
    asideSessionId: null,
    sessionState: 'starting',
    runIds: [],
    lastRunId: null,
  };
  threads.set(thread.id, thread);
  return thread;
}

function recordEvent(run, stream, text, at = now()) {
  const clean = stripAnsi(String(text)).trim();
  if (!clean) return;
  run.events.push({ at, stream, text: clean.slice(-12000) });
  if (run.events.length > 100) run.events.shift();
}

function persistSnapshot() {
  return {
    version: 2,
    threads: [...threads.values()].map((thread) => ({ ...thread, runIds: [...thread.runIds] })),
    runs: [...runs.values()].map(({ child, ...run }) => ({ ...run, events: [...run.events] })),
  };
}

async function writeState() {
  await fs.mkdir(STATE_DIRECTORY, { recursive: true, mode: 0o700 });
  await fs.chmod(STATE_DIRECTORY, 0o700);
  const temporary = `${STATE_FILE}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(persistSnapshot()), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, STATE_FILE);
}

function scheduleStateWrite() {
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    stateWrite = stateWrite.then(writeState).catch((error) => {
      console.error(`tail-aside state write failed: ${error.message}`);
    });
  }, 180);
}

async function flushState() {
  if (stateTimer) {
    clearTimeout(stateTimer);
    stateTimer = null;
  }
  stateWrite = stateWrite.then(writeState).catch((error) => {
    console.error(`tail-aside state write failed: ${error.message}`);
  });
  await stateWrite;
}

async function loadState() {
  await fs.mkdir(STATE_DIRECTORY, { recursive: true, mode: 0o700 });
  await fs.chmod(STATE_DIRECTORY, 0o700);
  try {
    await fs.chmod(STATE_FILE, 0o600);
    const parsed = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
    for (const value of parsed.threads || []) {
      if (!value?.id || !Array.isArray(value.runIds)) continue;
      threads.set(value.id, {
        id: value.id,
        source: value.source === 'aside' ? 'aside' : 'console',
        title: value.title || 'Previous session',
        preview: value.preview || '',
        mode: value.mode === 'send' ? 'send' : 'readonly',
        createdAt: value.createdAt || now(),
        updatedAt: value.updatedAt || value.createdAt || now(),
        asideSessionId: typeof value.asideSessionId === 'string' ? value.asideSessionId : null,
        sessionState: value.sessionState || 'unavailable',
        catalogTurnCount: Number.isInteger(value.catalogTurnCount) ? value.catalogTurnCount : 0,
        directoryName: typeof value.directoryName === 'string' ? value.directoryName : null,
        runIds: value.runIds.filter((id) => typeof id === 'string'),
        lastRunId: typeof value.lastRunId === 'string' ? value.lastRunId : null,
      });
    }
    for (const value of parsed.runs || []) {
      if (!value?.id || !value.threadId) continue;
      const wasRunning = value.status === 'running';
      const run = {
        id: value.id,
        threadId: value.threadId,
        title: value.title || 'Previous run',
        prompt: value.prompt || '',
        mode: value.mode === 'send' ? 'send' : 'readonly',
        target: value.target || '',
        message: value.message || '',
        continuation: Boolean(value.continuation),
        model: typeof value.model === 'string' ? value.model : '',
        speed: ['default', 'fast'].includes(value.speed) ? value.speed : CONFIG.defaults.speed,
        effort: typeof value.effort === 'string' ? value.effort : CONFIG.defaults.effort,
        status: wasRunning ? 'interrupted' : (value.status || 'completed'),
        createdAt: value.createdAt || now(),
        startedAt: value.startedAt || value.createdAt || now(),
        finishedAt: wasRunning ? now() : (value.finishedAt || null),
        exitCode: Number.isInteger(value.exitCode) ? value.exitCode : null,
        output: String(value.output || '').slice(-MAX_OUTPUT_LENGTH),
        events: Array.isArray(value.events) ? value.events.slice(-100) : [],
        child: null,
      };
      if (wasRunning) recordEvent(run, 'system', 'The server restarted, so this previous run was marked as interrupted.', run.finishedAt);
      runs.set(run.id, run);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`tail-aside state load failed: ${error.message}`);
  }
}

function trimHistory() {
  const removable = sortedThreads().filter((thread) => thread.source !== 'aside').slice(MAX_THREADS).filter((thread) => {
    const lastRun = thread.lastRunId ? runs.get(thread.lastRunId) : null;
    return lastRun?.status !== 'running';
  });
  for (const thread of removable) {
    threads.delete(thread.id);
    for (const runId of thread.runIds) runs.delete(runId);
  }
}

function updateThread(thread, patch = {}) {
  Object.assign(thread, patch, { updatedAt: now() });
}

function sessionExpired(text = '') {
  return /(?:session[^\n]*(?:expired|unknown|not found|invalid)|(?:expired|unknown|not found|invalid)[^\n]*session)/i.test(text);
}

function captureSessionId(run) {
  const thread = threads.get(run.threadId);
  if (!thread || thread.asideSessionId) return;
  const match = run.output.match(/created\s+new\s+session\s*:\s*([A-Za-z0-9_-]+)/i);
  if (!match) return;
  thread.asideSessionId = match[1];
  updateThread(thread, { sessionState: 'active' });
  recordEvent(run, 'system', 'Connected the Aside session. The next message will continue this conversation.');
}

function normalizeSessionText(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.map((part) => (part?.type === 'text' ? part.text : '')).join('\n');
  }
  return '';
}

function assistantText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function operatorPromptText(value = '') {
  const text = String(value).trim();
  const markers = ['Additional operator instruction:', 'Operator message:', 'Operator task:'];
  for (const marker of markers) {
    const markerIndex = text.lastIndexOf(marker);
    if (markerIndex >= 0) return text.slice(markerIndex + marker.length).trim();
  }
  return text;
}

function redactSensitive(value = '') {
  return redactSessionToken(value)
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{16,}\b/g, '[redacted]')
    .replace(/\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/g, '[redacted]')
    .replace(/\bBearer\s+[^\s]+/gi, 'Bearer [redacted]');
}

function transcriptContainsPrompt(buffer, prompt) {
  const needle = normalizeSessionText(prompt);
  if (!needle) return false;
  for (const line of buffer.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const message = JSON.parse(trimmed);
      if (normalizeSessionText(messageText(message)).includes(needle)) return true;
    } catch {
      // A final incomplete JSONL line is normal while Aside is still writing.
    }
  }
  return false;
}

async function readSessionPrefix(filePath) {
  const stat = await fs.stat(filePath);
  const bytes = Math.min(stat.size, MAX_SESSION_SCAN_BYTES);
  if (!bytes) return '';
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function readSessionTail(filePath) {
  const stat = await fs.stat(filePath);
  const bytes = Math.min(stat.size, MAX_TRANSCRIPT_TAIL_BYTES);
  if (!bytes) return '';
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, Math.max(0, stat.size - bytes));
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function initAsideCache() {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    await fs.mkdir(STATE_DIRECTORY, { recursive: true, mode: 0o700 });
    await fs.chmod(STATE_DIRECTORY, 0o700);
    cacheDb = new DatabaseSync(CACHE_DATABASE_FILE);
    cacheDb.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA busy_timeout = 1500;
      CREATE TABLE IF NOT EXISTS aside_session_cache (
        session_id TEXT PRIMARY KEY,
        directory_name TEXT NOT NULL,
        title TEXT NOT NULL,
        preview TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        turn_count INTEGER NOT NULL DEFAULT 0,
        transcript_mtime_ms REAL NOT NULL,
        transcript_size INTEGER NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_aside_session_cache_updated_at
        ON aside_session_cache(updated_at DESC);
    `);
    const cacheVersion = cacheDb.prepare('PRAGMA user_version').get().user_version;
    if (cacheVersion !== ASIDE_CACHE_SCHEMA_VERSION) {
      cacheDb.exec(`DELETE FROM aside_session_cache; PRAGMA user_version = ${ASIDE_CACHE_SCHEMA_VERSION};`);
    }
    await fs.chmod(CACHE_DATABASE_FILE, 0o600);
  } catch (error) {
    cacheDb = null;
    console.error(`Aside session SQLite cache unavailable: ${error.message}`);
  }
}

function getCachedSession(sessionId) {
  if (cacheDb) {
    return cacheDb.prepare('SELECT * FROM aside_session_cache WHERE session_id = ?').get(sessionId) || null;
  }
  return asideCacheFallback.get(sessionId) || null;
}

function saveCachedSession(record) {
  if (cacheDb) {
    cacheDb.prepare(`
      INSERT INTO aside_session_cache (
        session_id, directory_name, title, preview, created_at, updated_at,
        turn_count, transcript_mtime_ms, transcript_size, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        directory_name = excluded.directory_name,
        title = excluded.title,
        preview = excluded.preview,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        turn_count = excluded.turn_count,
        transcript_mtime_ms = excluded.transcript_mtime_ms,
        transcript_size = excluded.transcript_size,
        last_seen_at = excluded.last_seen_at
    `).run(
      record.sessionId,
      record.directoryName,
      record.title,
      record.preview,
      record.createdAt,
      record.updatedAt,
      record.turnCount,
      record.transcriptMtimeMs,
      record.transcriptSize,
      record.lastSeenAt,
    );
    return;
  }
  asideCacheFallback.set(record.sessionId, record);
}

function asideSessionFile(sessionId, directoryName = null) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return null;
  const safeDirectory = directoryName && /^[A-Za-z0-9_-]{1,256}$/.test(directoryName) ? directoryName : null;
  if (!safeDirectory) return null;
  return path.join(ASIDE_SESSION_DIRECTORY, safeDirectory, 'messages.jsonl');
}

function timestampToIso(value, fallback) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : fallback;
}

function scanAsideTranscript(buffer) {
  let title = '';
  let preview = '';
  let turnCount = 0;
  for (const line of buffer.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (message.role === 'user') {
      const text = redactSensitive(operatorPromptText(messageText(message)));
      if (!text) continue;
      turnCount += 1;
      if (!title) title = sessionTitle(text, 56);
    } else if (message.role === 'assistant') {
      const text = redactSensitive(assistantText(message));
      if (text) preview = trimText(text, 240);
    }
  }
  return {
    title: title || 'Aside session',
    preview,
    turnCount,
  };
}

function parseAsideTranscript(buffer, sessionId) {
  const threadId = `aside-${sessionId}`;
  const transcriptRuns = [];
  let current = null;
  for (const line of buffer.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (message.role === 'user') {
      const prompt = redactSensitive(operatorPromptText(messageText(message))).trim();
      if (!prompt) continue;
      const createdAt = timestampToIso(message.timestamp, now());
      current = {
        id: `${threadId}-turn-${transcriptRuns.length}`,
        threadId,
        title: 'Aside history',
        prompt: prompt.slice(0, MAX_PROMPT_LENGTH),
        mode: 'readonly',
        target: '',
        message: '',
        continuation: transcriptRuns.length > 0,
        imported: true,
        model: '',
        speed: CONFIG.defaults.speed,
        effort: CONFIG.defaults.effort,
        status: 'completed',
        createdAt,
        startedAt: createdAt,
        finishedAt: createdAt,
        exitCode: 0,
        output: '',
        events: [],
        child: null,
      };
      transcriptRuns.push(current);
    } else if (message.role === 'assistant' && current) {
      const text = redactSensitive(assistantText(message));
      if (text) current.output = `${current.output}${current.output ? '\n' : ''}${text}`.slice(-MAX_IMPORTED_OUTPUT_PER_TURN);
    }
  }
  return transcriptRuns.slice(-MAX_IMPORTED_TURNS);
}

async function inspectAsideSession(entry) {
  const idMatch = entry.name.match(/_([A-Za-z0-9_-]+)$/);
  if (!idMatch) return null;
  const sessionId = idMatch[1];
  const messageFile = path.join(ASIDE_SESSION_DIRECTORY, entry.name, 'messages.jsonl');
  try {
    const stat = await fs.stat(messageFile);
    const cached = getCachedSession(sessionId);
    const lastSeenAt = now();
    const cachedTitleNeedsRefresh = cached?.title?.startsWith('You are running inside Aside Console.');
    if (cached && !cachedTitleNeedsRefresh && Number(cached.transcript_mtime_ms) === stat.mtimeMs && Number(cached.transcript_size) === stat.size) {
      return {
        sessionId,
        directoryName: entry.name,
        title: cached.title,
        preview: cached.preview,
        createdAt: cached.created_at,
        updatedAt: cached.updated_at,
        turnCount: Number(cached.turn_count) || 0,
        transcriptMtimeMs: stat.mtimeMs,
        transcriptSize: stat.size,
        lastSeenAt,
      };
    }
    const prefixMetadata = scanAsideTranscript(await readSessionPrefix(messageFile));
    let metadata = prefixMetadata;
    if (stat.size > MAX_SESSION_SCAN_BYTES) {
      const tailMetadata = scanAsideTranscript(await readSessionTail(messageFile));
      metadata = {
        title: prefixMetadata.title,
        preview: tailMetadata.preview || prefixMetadata.preview,
        turnCount: Math.max(prefixMetadata.turnCount, tailMetadata.turnCount),
      };
    }
    return {
      sessionId,
      directoryName: entry.name,
      title: metadata.title,
      preview: metadata.preview,
      createdAt: new Date(stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs).toISOString(),
      updatedAt: new Date(stat.mtimeMs).toISOString(),
      turnCount: metadata.turnCount,
      transcriptMtimeMs: stat.mtimeMs,
      transcriptSize: stat.size,
      lastSeenAt,
    };
  } catch {
    return null;
  }
}

function importedThreadFromRecord(record) {
  const id = `aside-${record.sessionId}`;
  const existing = threads.get(id);
  if (existing) {
    existing.title = record.title;
    existing.preview = record.preview;
    existing.catalogTurnCount = record.turnCount;
    existing.directoryName = record.directoryName;
    if (!existing.lastRunId) existing.updatedAt = record.updatedAt;
    if (existing.sessionState !== 'expired') existing.sessionState = 'active';
    return existing;
  }
  const thread = {
    id,
    source: 'aside',
    title: record.title,
    preview: record.preview,
    mode: 'readonly',
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    asideSessionId: record.sessionId,
    sessionState: 'active',
    catalogTurnCount: record.turnCount,
    directoryName: record.directoryName,
    runIds: [],
    lastRunId: null,
  };
  threads.set(id, thread);
  return thread;
}

async function syncAsideSessionCatalog(force = false) {
  const timestamp = Date.now();
  if (!force && asideCatalogFetchedAt && timestamp - asideCatalogFetchedAt < CATALOG_CACHE_TTL_MS) return;
  if (asideCatalogPromise) return asideCatalogPromise;
  asideCatalogPromise = (async () => {
    let entries;
    try {
      entries = await fs.readdir(ASIDE_SESSION_DIRECTORY, { withFileTypes: true });
    } catch {
      asideCatalogFetchedAt = Date.now();
      return;
    }
    const seen = new Set();
    const consoleSessionIds = new Set([...threads.values()]
      .filter((thread) => thread.source !== 'aside' && thread.asideSessionId)
      .map((thread) => thread.asideSessionId));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const record = await inspectAsideSession(entry);
      if (!record) continue;
      seen.add(record.sessionId);
      saveCachedSession(record);
      if (!consoleSessionIds.has(record.sessionId)) importedThreadFromRecord(record);
    }
    for (const [id, thread] of threads) {
      if (thread.source === 'aside' && !seen.has(thread.asideSessionId) && thread.runIds.length === 0) threads.delete(id);
    }
    asideCatalogFetchedAt = Date.now();
    scheduleStateWrite();
  })().catch((error) => {
    console.error(`Aside session catalog sync failed: ${error.message}`);
  }).finally(() => {
    asideCatalogPromise = null;
  });
  return asideCatalogPromise;
}

async function importedThreadRuns(thread) {
  if (thread.source !== 'aside' || !thread.asideSessionId) return [];
  const messageFile = asideSessionFile(thread.asideSessionId, thread.directoryName);
  if (!messageFile) return [];
  try {
    const stat = await fs.stat(messageFile);
    const cached = transcriptCache.get(thread.asideSessionId);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.runs;
    const runsFromTranscript = parseAsideTranscript(await readSessionTail(messageFile), thread.asideSessionId);
    transcriptCache.set(thread.asideSessionId, { mtimeMs: stat.mtimeMs, size: stat.size, runs: runsFromTranscript });
    return runsFromTranscript;
  } catch {
    return [];
  }
}

function localRunAlreadyInTranscript(run, transcriptRuns) {
  const needle = normalizeSessionText(run.prompt);
  if (!needle) return false;
  return transcriptRuns.some((transcriptRun) => {
    const text = normalizeSessionText(transcriptRun.prompt);
    return text.includes(needle) || needle.includes(text);
  });
}

async function getThreadRuns(thread) {
  const localRuns = thread.runIds.map((id) => runs.get(id)).filter(Boolean);
  const transcriptRuns = await importedThreadRuns(thread);
  const combined = [...transcriptRuns, ...localRuns.filter((run) => run.status === 'running' || !localRunAlreadyInTranscript(run, transcriptRuns))];
  return combined.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

async function captureSessionFromStore(run) {
  if (run.continuation) return false;
  const thread = threads.get(run.threadId);
  if (!thread || thread.asideSessionId) return Boolean(thread?.asideSessionId);
  const startedAt = Date.parse(run.startedAt) - (2 * 60 * 1000);
  let entries = [];
  try {
    entries = await fs.readdir(ASIDE_SESSION_DIRECTORY, { withFileTypes: true });
  } catch {
    return false;
  }
  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const idMatch = entry.name.match(/_([A-Za-z0-9_-]+)$/);
    if (!idMatch) continue;
    const messageFile = path.join(ASIDE_SESSION_DIRECTORY, entry.name, 'messages.jsonl');
    try {
      const stat = await fs.stat(messageFile);
      if (stat.mtimeMs < startedAt) continue;
      const prefix = await readSessionPrefix(messageFile);
      if (transcriptContainsPrompt(prefix, run.prompt)) matches.push({ id: idMatch[1], mtimeMs: stat.mtimeMs });
    } catch {
      // Ignore files that Aside has not created yet or has already rotated.
    }
  }
  if (!matches.length) return false;
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  thread.asideSessionId = matches[0].id;
  updateThread(thread, { sessionState: 'active' });
  recordEvent(run, 'system', 'Connected the local Aside session history. The next message will continue it.');
  scheduleStateWrite();
  return true;
}

function appendOutput(run, chunk, stream) {
  const clean = stripAnsi(String(chunk));
  if (!clean) return;
  run.output = `${run.output}${clean}`.slice(-MAX_OUTPUT_LENGTH);
  recordEvent(run, stream, clean);
  captureSessionId(run);
  const thread = threads.get(run.threadId);
  if (thread) updateThread(thread, { preview: trimText(run.prompt), mode: run.mode });
  scheduleStateWrite();
}

function finishRun(run, status, { code = null, signal = null, message } = {}) {
  if (run.finishedAt) return;
  run.status = status;
  run.exitCode = code;
  run.finishedAt = now();
  run.child = null;
  const thread = threads.get(run.threadId);
  if (thread) {
    if (status === 'failed' && sessionExpired(run.output)) {
      updateThread(thread, { sessionState: 'expired' });
    } else if (!thread.asideSessionId && status !== 'running') {
      updateThread(thread, { sessionState: 'unavailable' });
    } else {
      updateThread(thread, { sessionState: thread.asideSessionId ? 'active' : thread.sessionState });
    }
  }
  recordEvent(
    run,
    'system',
    message || (status === 'completed'
      ? 'Run completed.'
      : `Run ended${signal ? ` (${signal})` : ''}.`),
    run.finishedAt,
  );
  trimHistory();
  scheduleStateWrite();
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve) => {
    if (!file) {
      resolve({ error: new Error('Aside CLI was not found.'), stdout: '', stderr: '' });
      return;
    }
    try {
      execFile(file, args, {
      cwd: RUNTIME_CWD,
        timeout: 30000,
        maxBuffer: 120000,
        ...options,
      }, (error, stdout, stderr) => resolve({ error, stdout: stdout || '', stderr: stderr || '' }));
    } catch (error) {
      resolve({ error, stdout: '', stderr: '' });
    }
  });
}

async function getHealth() {
  const fetchedAt = Date.now();
  if (healthCache.value && fetchedAt - healthCache.fetchedAt < 15000) return healthCache.value;

  const [versionResult, accountResult] = await Promise.all([
    execFileAsync(ASIDE_BIN, ['--version']),
    execFileAsync(ASIDE_BIN, ['account', 'status', ACCOUNT]),
  ]);
  const versionText = stripAnsi(`${versionResult.stdout}\n${versionResult.stderr}`);
  const accountText = stripAnsi(`${accountResult.stdout}\n${accountResult.stderr}`);
  const version = (versionText.match(/\d+\.\d+\.\d+/) || [null])[0];
  const signedIn = /signed in/i.test(accountText);
  const profileMatch = accountText.match(/profiles:\s*([^\n]+)/i);
  const value = {
    ok: Boolean(version) && signedIn,
    service: 'tail-aside',
    aside: {
      installed: Boolean(version),
      version: version || 'unknown',
      account: ACCOUNT,
      signedIn,
      profile: profileMatch ? profileMatch[1].trim() : 'unknown',
    },
    access: {
      transport: 'tailscale-serve',
      policy: CONFIG.allowAnyTailnetUser ? 'any-tailnet-user' : 'allowlist',
      authorizedUsers: CONFIG.allowAnyTailnetUser ? null : CONFIG.allowedLogins.length,
    },
    defaults: { ...CONFIG.defaults },
    checkedAt: now(),
  };
  healthCache = { fetchedAt, value };
  return value;
}

async function getBrowserTabs() {
  const fetchedAt = Date.now();
  if (browserCache.value && fetchedAt - browserCache.fetchedAt < 4000) return browserCache.value;

  const code = [
    'const tabs = await listBrowserTabs();',
    'console.log("ASIDE_TABS_JSON:" + JSON.stringify(tabs.map((tab) => ({ targetId: tab.targetId, active: tab.active, title: tab.title, url: tab.url }))));',
  ].join(' ');
  const result = await execFileAsync(ASIDE_BIN, ['repl', '--account', ACCOUNT, code], {
    timeout: 25000,
    maxBuffer: 300000,
  });
  const combined = stripAnsi(`${result.stdout}\n${result.stderr}`);
  const marker = 'ASIDE_TABS_JSON:';
  const markerIndex = combined.lastIndexOf(marker);
  let tabs = [];
  let error = null;
  if (markerIndex >= 0) {
    const payload = combined.slice(markerIndex + marker.length).split(/\r?\n/, 1)[0].trim();
    try {
      tabs = JSON.parse(payload);
    } catch {
      error = 'Could not parse the browser tab response.';
    }
  } else {
    error = 'Could not read the Aside browser tab list.';
  }
  if (result.error && tabs.length === 0) error = error || 'Aside repl failed.';
  const value = { ok: !error, tabs, error, checkedAt: now() };
  browserCache = { fetchedAt, value };
  return value;
}

function buildAsidePrompt(body) {
  const chatPolicy = [
    'You are running inside tail-aside.',
    'Execution mode: AGENT CHAT.',
    'This is a normal operator message to the Aside agent; no website or account needs to be specified unless the operator asks for one.',
    'You may inspect and work through the browser as needed, but do not send messages, submit forms, publish, purchase, delete, or otherwise create an external side effect unless this is an explicitly approved External Send request.',
    'For an external side effect that is not explicitly approved, stop before submission and report what would happen.',
  ].join('\n');
  if (body.mode !== 'send') return `${chatPolicy}\n\nOperator message:\n${body.prompt}`;

  return [
    'You are running inside tail-aside.',
    'Execution mode: EXTERNAL SEND.',
    'The operator explicitly approved this one exact send request in the console.',
    'Before submitting, verify the target and exact content. If either is ambiguous, stop without sending.',
    'Send only to the stated target and only the exact stated message. Do not send anywhere else or perform unrelated changes.',
    `Target: ${body.target}`,
    `Exact message:\n<<<\n${body.message}\n>>>`,
    `Additional operator instruction:\n${body.prompt}`,
  ].join('\n\n');
}

function startRun(body) {
  if (!ASIDE_BIN) {
    const error = new Error('Aside CLI was not found. Run npm run doctor and update your configuration.');
    error.statusCode = 503;
    throw error;
  }
  const existingThread = body.threadId ? threads.get(body.threadId) : null;
  if (body.threadId && !existingThread) {
    const error = new Error('Conversation not found. Refresh the list and try again.');
    error.statusCode = 404;
    throw error;
  }
  const thread = existingThread || createThread(body);
  const continuation = Boolean(thread.asideSessionId && thread.sessionState === 'active');
  if (existingThread && thread.runIds.length > 0 && !continuation) {
    const error = new Error(thread.sessionState === 'expired'
      ? 'This Aside session has expired. Start a new session.'
      : 'The previous Aside session could not be recovered. Start a new session.');
    error.statusCode = 409;
    throw error;
  }

  const createdAt = now();
  const run = {
    id: randomUUID(),
    threadId: thread.id,
    title: thread.title,
    prompt: body.prompt,
    mode: body.mode,
    target: body.target || '',
    message: body.message || '',
    continuation,
    model: body.model,
    speed: body.speed,
    effort: body.effort,
    status: 'running',
    createdAt,
    startedAt: createdAt,
    finishedAt: null,
    exitCode: null,
    output: '',
    events: [],
    child: null,
  };
  recordEvent(run, 'system', continuation
    ? 'Sent a follow-up message to the existing Aside session.'
    : 'Started a new Aside session.');
  runs.set(run.id, run);
  thread.runIds.push(run.id);
  updateThread(thread, { lastRunId: run.id, preview: trimText(body.prompt), mode: body.mode, sessionState: continuation ? 'active' : 'starting' });

  const args = buildAsideArgs({
    account: ACCOUNT,
    body,
    continuationSessionId: continuation ? thread.asideSessionId : null,
    prompt: buildAsidePrompt(body),
  });

  const child = spawn(ASIDE_BIN, args, {
    cwd: RUNTIME_CWD,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  run.child = child;
  child.stdout.on('data', (chunk) => appendOutput(run, chunk, 'stdout'));
  child.stderr.on('data', (chunk) => appendOutput(run, chunk, 'stderr'));
  child.on('error', (error) => {
    appendOutput(run, error.message, 'error');
    finishRun(run, 'failed', { message: 'Could not start Aside.' });
  });
  child.on('close', async (code, signal) => {
    if (run.status === 'cancelled') {
      run.child = null;
      scheduleStateWrite();
      return;
    }
    await captureSessionFromStore(run);
    finishRun(run, code === 0 ? 'completed' : 'failed', { code, signal });
  });
  trimHistory();
  scheduleStateWrite();
  return run;
}

function cancelRun(run) {
  if (!run || run.status !== 'running') return false;
  run.status = 'cancelled';
  run.finishedAt = now();
  recordEvent(run, 'system', 'Run stopped.', run.finishedAt);
  const thread = threads.get(run.threadId);
  if (thread) updateThread(thread, { sessionState: thread.asideSessionId ? 'active' : thread.sessionState });
  if (run.child) run.child.kill('SIGTERM');
  run.child = null;
  scheduleStateWrite();
  return true;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
  });
  res.end(body);
}

function sendText(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 200000) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function serveStatic(req, res, pathname) {
  if (!existsSync(DIST)) {
    sendText(res, 503, 'tail-aside frontend is not built. Run npm install && npm run build first.\n');
    return;
  }
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let filePath = path.resolve(DIST, relative);
  if (!filePath.startsWith(`${DIST}${path.sep}`) && filePath !== DIST) {
    sendText(res, 403, 'Forbidden\n');
    return;
  }
  if (!existsSync(filePath)) filePath = path.join(DIST, 'index.html');
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error('not a file');
    const extension = path.extname(filePath);
    const type = MIME_TYPES[extension] || 'application/octet-stream';
    const isHashedAsset = pathname.startsWith('/assets/');
    const useGzip = req.method !== 'HEAD'
      && stat.size > 1_024
      && COMPRESSIBLE_TYPES.has(extension)
      && /(?:^|,)\s*gzip(?:\s*;|\s*,|$)/i.test(req.headers['accept-encoding'] || '');
    const headers = {
      'Content-Type': type,
      'Cache-Control': isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...SECURITY_HEADERS,
    };
    if (stat.size > 1_024 && COMPRESSIBLE_TYPES.has(extension)) headers.Vary = 'Accept-Encoding';
    if (useGzip) {
      headers['Content-Encoding'] = 'gzip';
    } else {
      headers['Content-Length'] = stat.size;
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
    } else if (useGzip) {
      createReadStream(filePath).pipe(createGzip({ level: 6 })).pipe(res);
    } else {
      createReadStream(filePath).pipe(res);
    }
  } catch {
    sendText(res, 404, 'Not found\n');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;
  try {
    let identity = null;
    if (pathname.startsWith('/api/')) {
      identity = authorizeRequest(req, CONFIG);
      if (!identity.ok) {
        sendJson(res, identity.status, { error: identity.error });
        return;
      }
      if (req.method === 'POST') {
        const stateChange = validateStateChangeRequest(req);
        if (!stateChange.ok) {
          sendJson(res, stateChange.status, { error: stateChange.error });
          return;
        }
      }
    }
    if (req.method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, {
        ...await getHealth(),
        requester: {
          kind: identity.kind,
          displayName: identity.displayName || (identity.kind === 'local' ? 'Localhost' : 'Tailnet user'),
        },
      });
      return;
    }
    if (req.method === 'GET' && pathname === '/api/browser-tabs') {
      sendJson(res, 200, await getBrowserTabs());
      return;
    }
    if (req.method === 'GET' && pathname === '/api/threads') {
      await syncAsideSessionCatalog(url.searchParams.get('refresh') === '1');
      sendJson(res, 200, { threads: sortedThreads().map(publicThread) });
      return;
    }
    const threadMatch = pathname.match(/^\/api\/threads\/([^/]+)$/);
    if (req.method === 'GET' && threadMatch) {
      await syncAsideSessionCatalog();
      const thread = threads.get(threadMatch[1]);
      if (!thread) return sendJson(res, 404, { error: 'Conversation not found.' });
      const threadRuns = (await getThreadRuns(thread)).map((run) => publicRun(run, true));
      sendJson(res, 200, { thread: publicThread(thread), runs: threadRuns });
      return;
    }
    if (req.method === 'GET' && pathname === '/api/runs') {
      const values = [...runs.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map((run) => publicRun(run));
      sendJson(res, 200, { runs: values });
      return;
    }
    const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (req.method === 'GET' && runMatch) {
      const run = runs.get(runMatch[1]);
      if (!run) return sendJson(res, 404, { error: 'Run not found.' });
      const events = run.events.map((event) => ({ ...event, text: redactSessionToken(event.text) }));
      sendJson(res, 200, { run: publicRun(run, true), events });
      return;
    }
    if (req.method === 'POST' && pathname === '/api/run') {
      if ([...runs.values()].some((run) => run.status === 'running')) {
        sendJson(res, 409, { error: 'Another run is already active. Wait for it to finish or stop it first.' });
        return;
      }
      await syncAsideSessionCatalog();
      const body = await readJson(req);
      const validation = validateRunBody(body, MAX_PROMPT_LENGTH, CONFIG.defaults);
      if (validation.error) {
        sendJson(res, 400, { error: validation.error });
        return;
      }
      const run = startRun(validation.value);
      const thread = threads.get(run.threadId);
      sendJson(res, 202, { thread: publicThread(thread), run: publicRun(run, true) });
      return;
    }
    const cancelMatch = pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
    if (req.method === 'POST' && cancelMatch) {
      const run = runs.get(cancelMatch[1]);
      if (!run) return sendJson(res, 404, { error: 'Run not found.' });
      cancelRun(run);
      const thread = threads.get(run.threadId);
      sendJson(res, 200, { thread: publicThread(thread), run: publicRun(run, true) });
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(req, res, pathname);
      return;
    }
    sendJson(res, 405, { error: 'Method not allowed.' });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error(`tail-aside request failed: ${error.stack || error.message}`);
    const message = error instanceof SyntaxError
      ? 'The JSON request body is invalid.'
      : status >= 500
        ? 'tail-aside could not complete this request.'
        : error.message;
    sendJson(res, status, { error: message });
  }
});

await initAsideCache();
await loadState();
await syncAsideSessionCatalog(true);
const asideCatalogTimer = setInterval(() => syncAsideSessionCatalog(true), CATALOG_CACHE_TTL_MS);
asideCatalogTimer.unref();

async function shutdown() {
  clearInterval(asideCatalogTimer);
  for (const run of runs.values()) cancelRun(run);
  await flushState();
  if (cacheDb) cacheDb.close();
  server.close(() => process.exit(0));
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  console.log(`tail-aside listening at http://${HOST}:${PORT}`);
  console.log(`Aside binary: ${ASIDE_BIN || 'not found'} (account ${ACCOUNT})`);
  console.log(`Aside sessions: ${ASIDE_SESSION_DIRECTORY}`);
  console.log(`Conversation state: ${STATE_FILE}`);
  console.log(`Tailnet users: ${CONFIG.allowAnyTailnetUser ? 'any authenticated user' : CONFIG.allowedLogins.length}`);
  console.log('Tailnet exposure is intentionally handled by Tailscale Serve.');
});
