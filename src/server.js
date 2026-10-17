/**
 * PayFlow — demo server.
 *
 * Exposes the agent over HTTP so the submission has a live URL a judge
 * can open and drive themselves.
 *
 *   GET  /             the demo UI
 *   POST /api/run      { goal } -> full trace
 *   GET  /api/beats    the three canned beats
 *   GET  /api/state    ledger / outbox / export log — proof of what moved
 *   GET  /api/health   key + session sanity check
 *
 * The client renders a trace that arrives in one response, revealed a step
 * at a time. That keeps the demo feeling live without depending on a
 * streaming connection staying up in front of an audience.
 */

import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAgent, runGoal } from './agent.js';
import { BEATS } from './beats.js';
import { DEMO_NOTICE, STORE } from './db.js';
import { LEDGER, OUTBOX, EXPORT_LOG } from './tools.js';

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
    store: STORE.name,
    notice: DEMO_NOTICE,
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
  });
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

    res.json({
      ...run,
      enforce,
      as: userEmail,
      notice: DEMO_NOTICE,
      state: {
        movedMoney: LEDGER.reduce((s, e) => s + Number(e.amount ?? 0), 0),
        emailsSent: OUTBOX.length,
        dataExported: EXPORT_LOG.length,
      },
    });
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
