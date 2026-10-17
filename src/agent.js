/**
 * PayFlow — the governed execution loop.
 *
 * Every tool call passes through ArmorIQ's four-move loop before it is
 * allowed to touch anything:
 *
 *   1. startPlan(calls, goal)   declare intent  -> a cryptographically signed plan
 *   2. check(name, args, user)  ask the boundary -> allow | hold | block
 *   3. execute                  only reachable if the boundary allowed it
 *   4. report(name, args, ...)  record what actually happened
 *
 * The ordering is the whole product. `check` sits between the decision to act
 * and the action itself, so a blocked call never executes. There is no window
 * in which the agent has already done the thing.
 *
 * Every SDK signature below was verified against the installed type
 * definitions (node_modules/@armoriq/sdk/dist), not taken on faith:
 *
 *   new ArmorIQClient({ apiKey, userId, agentId, useProduction })
 *   session.check(name, args, userEmail?) -> EnforceResult
 *   session.report(name, args, result, { status, errorMessage, durationMs })
 *
 *   interface EnforceResult {
 *     allowed: boolean;
 *     action: 'allow' | 'block' | 'hold';
 *     reason?: string;
 *     matchedPolicy?: string;
 *     delegationId?: string;
 *     obligations?: Record<string, unknown>[];
 *   }
 */

import { ArmorIQClient } from '@armoriq/sdk';
import { plan } from './planner.js';
import { executeTool } from './tools.js';

/* ── Verdict reading ────────────────────────────────────────────── */

/**
 * Translate an EnforceResult into one of three outcomes.
 *
 * ArmorIQ collapses its decision into `allowed` + `action`. `action` is the
 * authoritative field; `allowed` is the convenience boolean. Anything we
 * cannot positively read as an allow fails closed.
 */
export function readVerdict(decision) {
  if (!decision || typeof decision !== 'object') {
    return { status: 'deny', reason: 'no decision object returned', matchedPolicy: null };
  }

  const { allowed, action, reason, matchedPolicy = null } = decision;
  const why = reason ?? '';

  if (action === 'hold') {
    return { status: 'hold', reason: why || 'held for a human to approve', matchedPolicy };
  }
  if (action === 'allow') {
    return { status: 'allow', reason: why || 'within signed scope', matchedPolicy };
  }
  if (action === 'block') {
    return { status: 'deny', reason: why || 'blocked by policy', matchedPolicy };
  }

  /* `action` is the authoritative field. If it is present but is not a value
     we recognise — a new backend action, a typo, a future enum member — we
     must NOT fall through to the boolean. Doing that is fail-open: an unknown
     action that happens to carry `allowed: true` would run the tool. An
     action we cannot interpret is treated as a refusal. */
  if (action !== undefined && action !== null) {
    return {
      status: 'deny',
      reason: why || `unrecognised enforcement action "${String(action)}" — failing closed`,
      matchedPolicy,
    };
  }

  /* `action` is absent entirely, so the boolean is all there is. */
  if (allowed === true) {
    return { status: 'allow', reason: why || 'within signed scope', matchedPolicy };
  }
  if (allowed === false) {
    return { status: 'deny', reason: why || 'not permitted by policy', matchedPolicy };
  }
  return { status: 'deny', reason: why || 'unrecognised decision shape — failing closed', matchedPolicy };
}

/* ── Agent construction ─────────────────────────────────────────── */

/**
 * Build the agent. `enforce: false` produces the comparison run that shows
 * what the same agent does with nothing checking it.
 */
export async function createAgent({
  apiKey,
  userEmail,
  mcpName = 'payflow',
  agentName = 'payflow',
  enforce = true,
}) {
  /* The ungoverned run deliberately touches no ArmorIQ surface at all — no
     client, no bootstrap, no API key. That is what makes it a clean control
     for the comparison, and it means the demo still works when a key is
     missing or expired. */
  if (!enforce) {
    return { client: null, account: null, userEmail, mcpName, agentName, enforce: false };
  }

  if (!apiKey) throw new Error('ARMORIQ_API_KEY is not set. Add it to .env (see .env.example).');
  if (!userEmail) throw new Error('ARMORIQ_USER_EMAIL is not set — ArmorIQ resolves policy per user.');

  const client = new ArmorIQClient({
    apiKey,
    userId: userEmail,
    agentId: agentName,
    // The prefix is a format check, not a routing decision: a staging key can
    // also start with ak_live_. ARMORIQ_ENV is what actually picks the backend
    // (production / staging / local), and the SDK ignores this flag whenever
    // that variable is set. Only the legacy local mode falls back to it.
    useProduction: String(apiKey).startsWith('ak_live_'),
  });

  let account;
  try {
    account = await client.bootstrap();
  } catch (err) {
    // The SDK prints "API key validated successfully" after only checking the
    // key's prefix, so an expired key sails past that and dies right here.
    // Say what actually happened instead of leaking a raw SDK error.
    if (/401|unauthor|invalid or expired/i.test(err.message ?? '')) {
      throw new Error(
        'ArmorIQ rejected the API key (401).\n' +
        '  → If the key is fresh, it may belong to the other backend. A staging\n' +
        '    key can still start with ak_live_. Try ARMORIQ_ENV=staging (or\n' +
        '    production) before generating a replacement.\n' +
        '  → Otherwise generate a new one: platform.armoriq.ai → Settings → API Keys\n' +
        '  → Put it in .env as ARMORIQ_API_KEY\n' +
        '  → Then run: node check-setup.js\n' +
        'The ungoverned beat needs no key at all: npm run beat:ungoverned',
      );
    }
    throw err;
  }

  return { client, account, userEmail, mcpName, agentName, enforce: true };
}

/* ── The loop ───────────────────────────────────────────────────── */

/**
 * Run one goal to completion, or until the boundary stops it.
 *
 * @param {object}   agent      from createAgent()
 * @param {string}   goal       natural-language objective
 * @param {object}   opts
 * @param {string}   opts.userEmail   run as someone else (the two-user beat)
 * @param {function} opts.onEvent     ({type, ...}) as the run progresses
 * @param {number}   opts.maxSteps
 * @param {string}   opts.geminiKey
 * @param {string}   opts.geminiModel
 */
export async function runGoal(agent, goal, opts = {}) {
  const {
    onEvent = () => {},
    maxSteps = 6,
    geminiKey,
    geminiModel = 'gemini-2.5-flash',
    userEmail = agent.userEmail,
  } = opts;

  const who = userEmail;

  // With enforcement off there is no session at all — that is the point of
  // the comparison run. Nothing is planned, nothing is checked, nothing
  // is recorded.
  let session = null;
  if (agent.enforce) {
    session = agent.client.forUser(who).startSession({
      mode: 'sdk',
      defaultMcpName: agent.mcpName,
      validitySeconds: 2400,
      llm: geminiModel,
    });
    onEvent({ type: 'session', mcpName: agent.mcpName, agentName: agent.agentName, userEmail: who });
  } else {
    onEvent({ type: 'session', ungoverned: true, userEmail: who });
  }

  const trace = [];
  const history = [];
  let outcome = 'completed';

  onEvent({ type: 'goal', goal });

  try {
    for (let step = 1; step <= maxSteps; step++) {
      const call = await plan(goal, { history, apiKey: geminiKey, model: geminiModel });

      if (call.tool === 'finish' || call.tool === 'done') {
        outcome = 'completed';
        onEvent({ type: 'finish', rationale: call.rationale });
        break;
      }

      onEvent({ type: 'plan', step, tool: call.tool, args: call.args, rationale: call.rationale });
      const started = Date.now();

      /* ── MOVE 2 — ask the boundary ─────────────────────────────── */
      let verdict = {
        status: 'allow',
        reason: 'enforcement disabled — nothing was checked',
        matchedPolicy: null,
      };

      if (session) {
        // MOVE 1 — declare intent. The plan is signed; every later call is
        // checked against this exact list.
        //
        // The SDK's ToolCallInput is `{ name, args }`, not the planner's
        // `{ tool, args, rationale }`. Passing the planner object straight
        // through leaves `name` undefined, and hashToolCalls() then throws
        // "unsupported type in canonical JSON: undefined" before any network
        // call is made. Map the fields explicitly.
        await session.startPlan([{ name: call.tool, args: call.args }], goal);

        const decision = await session.check(call.tool, call.args, who);
        // Surface the raw decision so the console shape can be verified.
        onEvent({ type: 'decision', step, raw: decision });

        verdict = readVerdict(decision);
        onEvent({
          type: 'verdict',
          step,
          tool: call.tool,
          verdict: verdict.status,
          reason: verdict.reason,
          matchedPolicy: verdict.matchedPolicy,
        });
      } else {
        onEvent({ type: 'verdict', step, tool: call.tool, verdict: 'allow', reason: verdict.reason });
      }

      if (verdict.status !== 'allow') {
        /* The boundary held. The tool is never invoked — no money moved,
           no email sent, no export written. */
        const durationMs = Date.now() - started;

        if (session) {
          // MOVE 4 — report the attempt, recording that it never ran.
          await session.report(call.tool, call.args, null, {
            status: 'failed',
            errorMessage: verdict.reason,
            durationMs,
          });
        }

        trace.push({
          step,
          at: new Date().toISOString(),
          tool: call.tool,
          args: call.args,
          rationale: call.rationale,
          verdict: verdict.status,
          reason: verdict.reason,
          matchedPolicy: verdict.matchedPolicy,
          result: null,
          error: null,
          durationMs,
        });

        outcome = verdict.status === 'hold' ? 'held' : 'blocked';
        onEvent({ type: 'stopped', step, verdict: verdict.status, reason: verdict.reason, durationMs });
        break;
      }

      /* ── MOVE 3 — execute. Only reachable past an explicit allow. ── */
      let result = null;
      let error = null;
      try {
        result = await executeTool(call.tool, call.args);
      } catch (err) {
        error = err.message;
      }

      const durationMs = Date.now() - started;

      if (session) {
        // MOVE 4 — record what actually happened.
        await session.report(call.tool, call.args, error ? null : result, {
          status: error ? 'error' : 'success',
          errorMessage: error ?? undefined,
          durationMs,
        });
      }

      trace.push({
        step,
        at: new Date().toISOString(),
        tool: call.tool,
        args: call.args,
        rationale: call.rationale,
        verdict: 'allow',
        reason: verdict.reason,
        matchedPolicy: verdict.matchedPolicy,
        result,
        error,
        durationMs,
      });

      onEvent({ type: 'executed', step, tool: call.tool, result, error, durationMs });
      history.push({ call, result: error ? { error } : result });
    }
  } finally {
    try {
      await session?.flushObservability?.();
    } catch {
      /* best effort */
    }
    try {
      await session?.close?.();
    } catch {
      /* best effort */
    }
  }

  onEvent({ type: 'end', outcome });
  return { goal, outcome, trace };
}