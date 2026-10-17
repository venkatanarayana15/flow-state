/**
 * PayFlow — demo server.
 *
 * Exposes the agent over HTTP so the submission has a live URL a judge
 * can open and drive themselves.
 *
 *   GET  /                  the demo UI
 *   POST /api/run           { goal } -> full trace, one JSON body
 *   POST /api/run/stream    { goal } -> newline-delimited events as they happen
 *   GET  /api/beats         the five demo scenarios
 *   GET  /api/state         ledger / outbox / export log — proof of what moved
 *   GET  /api/health        key + session sanity check
 *
 * The UI uses the streaming route, so each plan and each verdict lands on
 * screen the moment it happens instead of after the run finishes. `/api/run`
 * stays for scripts, curl and the video capture — same loop, buffered.
 */

import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAgent, runGoal } from './agent.js';
import { BEATS } from './beats.js';
import { DEMO_NOTICE, STORE } from './db.js';
import { LEDGER, OUTBOX, EXPORT_LOG, TOOLS } from './tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 3000);
const API_KEY = process.env.ARMORIQ_API_KEY;
const USER_EMAIL = process.env.ARMORIQ_USER_EMAIL;
const USER_LOW = process.env.ARMORIQ_USER_EMAIL_LOW ?? 'support-t1@example.com';
const MCP_NAME = process.env.ARMORIQ_MCP_NAME ?? 'payflow';
const AGENT_NAME = process.env.ARMORIQ_AGENT_NAME ?? 'payflow';
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';

const app = express();
app.set('trust proxy', 1); // Render / Fly terminate TLS in front of us
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

/* ── Quota guard ────────────────────────────────────────────────── */
// The live demo is public and the API keys are ours, so one visitor must not
// be able to burn the Gemini and ArmorIQ quota the judges need. In-memory is
// enough here: this is a single-instance demo, and a restart only resets the
// window. Deliberately dependency-free.

const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MINUTES ?? 10) * 60_000;
const RATE_MAX_RUNS = Number(process.env.RATE_MAX_RUNS ?? 40);
const runHits = new Map();

function rateLimitRun(req, res, next) {
  const now = Date.now();
  const key = req.ip ?? 'unknown';
  const recent = (runHits.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);

  if (recent.length >= RATE_MAX_RUNS) {
    const retryAfter = Math.ceil((RATE_WINDOW_MS - (now - recent[0])) / 1000);
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({
      error: `Demo rate limit reached. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
    });
  }

  recent.push(now);
  runHits.set(key, recent);

  // Keep the map from growing without bound on a long-lived instance.
  if (runHits.size > 5000) {
    for (const [ip, times] of runHits) {
      if (!times.some((t) => now - t < RATE_WINDOW_MS)) runHits.delete(ip);
    }
  }
  next();
}

/* ── Lazy agents ────────────────────────────────────────────────── */
// Two singletons: one governed, one with the boundary switched off. Built
// independently on purpose — a broken ArmorIQ key must not take down the
// ungoverned comparison, which needs no key at all. That contrast is the
// demo; do not make it depend on the thing it is contrasting with.

let governedAgent = null;
let ungovernedAgent = null;

async function getAgent(enforce) {
  if (!enforce) {
    ungovernedAgent ??= await createAgent({
      apiKey: API_KEY, userEmail: USER_EMAIL,
      mcpName: MCP_NAME, agentName: AGENT_NAME, enforce: false,
    });
    return ungovernedAgent;
  }
  governedAgent ??= await createAgent({
    apiKey: API_KEY, userEmail: USER_EMAIL,
    mcpName: MCP_NAME, agentName: AGENT_NAME, enforce: true,
  });
  return governedAgent;
}

/* ── Routes ─────────────────────────────────────────────────────── */

app.get('/api/health', (_req, res) => {
  const missing = [];
  if (!API_KEY) missing.push('ARMORIQ_API_KEY');
  if (!USER_EMAIL) missing.push('ARMORIQ_USER_EMAIL');
  if (!GEMINI_KEY) missing.push('GEMINI_API_KEY');

  res.json({
    ok: missing.length === 0,
    missing,
    agentName: AGENT_NAME,
    mcpName: MCP_NAME,
    userEmail: USER_EMAIL ?? null,
    userEmailLow: USER_LOW,
    model: GEMINI_MODEL,
    backend: process.env.ARMORIQ_ENV ?? 'production',
    store: STORE.name,
    notice: DEMO_NOTICE,
    tools: TOOLS.length,
  });
});

app.get('/api/beats', (_req, res) => {
  res.json({
    beats: Object.entries(BEATS).map(([key, b]) => ({
      key,
      label: b.label,
      expect: b.expect,
      goal: b.goal,
      enforce: b.enforce !== false,
      compare: b.compare ?? null,
    })),
  });
});

app.get('/api/state', (_req, res) => {
  res.json({
    ledger: LEDGER,
    outbox: OUTBOX,
    exports: EXPORT_LOG,
    notice: DEMO_NOTICE,
    // The line the demo is really about:
    movedMoney: LEDGER.reduce((sum, e) => sum + Number(e.amount ?? 0), 0),
    emailsSent: OUTBOX.length,
    dataExported: EXPORT_LOG.length,
    exportedRows: EXPORT_LOG.reduce((sum, e) => sum + Number(e.rows ?? 0), 0),
  });
});

/** Shared validation for both run routes. Returns an error string, or null. */
function validateRun(body) {
  const goal = String(body?.goal ?? '').trim();
  const enforce = body?.enforce !== false;
  if (!goal) return 'provide a non-empty "goal"';
  if (!GEMINI_KEY || (enforce && !API_KEY)) {
    return 'server is missing credentials — check /api/health';
  }
  return null;
}

const snapshot = () => ({
  movedMoney: LEDGER.reduce((s, e) => s + Number(e.amount ?? 0), 0),
  emailsSent: OUTBOX.length,
  dataExported: EXPORT_LOG.length,
  exportedRows: EXPORT_LOG.reduce((s, e) => s + Number(e.rows ?? 0), 0),
});

app.post('/api/run/stream', rateLimitRun, async (req, res) => {
  const problem = validateRun(req.body);
  if (problem) return res.status(problem.startsWith('server') ? 500 : 400).json({ error: problem });

  const goal = String(req.body.goal).trim();
  const asUser = String(req.body?.as ?? 'user').toLowerCase();
  const enforce = req.body?.enforce !== false;
  const userEmail = asUser === 'userlow' ? USER_LOW : USER_EMAIL;

  res.status(200);
  res.set({
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no', // Render/nginx must not buffer the trace
  });
  res.flushHeaders?.();

  // Listen on the *response*: an incoming request emits 'close' as soon as
  // its body has been read, which would silence the whole trace.
  let open = true;
  res.on('close', () => { open = false; });
  const send = (event) => {
    if (!open || res.writableEnded) return;
    res.write(`${JSON.stringify(event)}\n`);
  };

  try {
    const agent = await getAgent(enforce);
    send({ type: 'start', enforce, as: userEmail, agentName: AGENT_NAME, mcpName: MCP_NAME });

    const run = await runGoal(agent, goal, {
      geminiKey: GEMINI_KEY,
      geminiModel: GEMINI_MODEL,
      userEmail,
      onEvent: send,
    });

    send({ type: 'done', outcome: run.outcome, trace: run.trace, state: snapshot(), as: userEmail, enforce });
  } catch (err) {
    console.error('[payflow] stream failed:', err);
    send({ type: 'error', error: err.message });
  } finally {
    open = false;
    res.end();
  }
});

app.post('/api/run', rateLimitRun, async (req, res) => {
  const goal = String(req.body?.goal ?? '').trim();
  const asUser = String(req.body?.as ?? 'user').toLowerCase();
  const enforce = req.body?.enforce !== false;

  if (!goal) {
    return res.status(400).json({ error: 'provide a non-empty "goal"' });
  }
  // The ungoverned run needs no ArmorIQ key — only the planner does.
  if (!GEMINI_KEY || (enforce && !API_KEY)) {
    return res.status(500).json({ error: 'server is missing credentials — check /api/health' });
  }

  try {
    const agent = await getAgent(enforce);
    const userEmail = asUser === 'userlow' ? USER_LOW : USER_EMAIL;

    const run = await runGoal(agent, goal, {
      geminiKey: GEMINI_KEY,
      geminiModel: GEMINI_MODEL,
      userEmail,
    });

    res.json({ ...run, enforce, as: userEmail, notice: DEMO_NOTICE, state: snapshot() });
  } catch (err) {
    console.error('[payflow] run failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ── Boot ───────────────────────────────────────────────────────── */

app.listen(PORT, () => {
  console.log('');
  console.log(`  PayFlow is running`);
  console.log(`  → http://localhost:${PORT}`);
  console.log('');
  console.log(`  agent     : ${AGENT_NAME}`);
  console.log(`  mcp name  : ${MCP_NAME}`);
  console.log(`  user      : ${USER_EMAIL ?? '(missing ARMORIQ_USER_EMAIL)'}`);
  console.log(`  second user: ${USER_LOW}`);
  console.log(`  model     : ${GEMINI_MODEL}`);
  console.log('');
  if (!API_KEY) console.log('  ⚠  ARMORIQ_API_KEY is not set');
  if (!GEMINI_KEY) console.log('  ⚠  GEMINI_API_KEY is not set');
  console.log('');
});
