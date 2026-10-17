#!/usr/bin/env node
/**
 * PayFlow — command-line runner.
 *
 *   npm run beat:allow       small refund             → ALLOWED
 *   npm run beat:hold        large store credit       → HELD
 *   npm run beat:deny        injected ticket          → BLOCKED
 *   npm run beat:users       same call, two people    → DIFFERENT VERDICTS
 *   npm run beat:ungoverned  boundary switched off    → EXFILTRATES
 *   npm run beats            all five, in order
 *
 * Run this before you touch the web UI. It is the fastest way to see the
 * boundary work, and the fastest way to find a broken key.
 */

import 'dotenv/config';
import { createAgent, runGoal } from './src/agent.js';
import { BEATS, BEAT_ORDER } from './src/beats.js';

/* ── Terminal formatting ────────────────────────────────────────── */

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', grey: '\x1b[90m', magenta: '\x1b[35m',
};

const BADGE = {
  allow: `${C.green}${C.bold}ALLOWED${C.reset}`,
  hold: `${C.yellow}${C.bold}HELD${C.reset}`,
  deny: `${C.red}${C.bold}BLOCKED${C.reset}`,
  ungoverned: `${C.magenta}${C.bold}NO BOUNDARY${C.reset}`,
};

const truncate = (s, n = 150) => {
  const str = typeof s === 'string' ? s : JSON.stringify(s);
  return str.length > n ? `${str.slice(0, n)}…` : str;
};

/* ── Run a single beat ──────────────────────────────────────────── */

async function runOne(agent, goal, { onEvent, userEmail, ...rest }) {
  return runGoal(agent, goal, { onEvent, userEmail, ...rest });
}

function printer(beat, label) {
  return (ev) => {
    if (ev.type === 'session') {
      if (ev.ungoverned) {
        console.log(`  ${C.magenta}session${C.reset} NO ArmorIQ session — ${ev.userEmail}`);
      } else {
        console.log(`  ${C.cyan}session${C.reset} agent=${ev.agentName} mcp=${ev.mcpName} user=${ev.userEmail}`);
      }
    }
    if (ev.type === 'plan') {
      console.log(`  ${C.grey}—— step ${ev.step} ——${C.reset}`);
      console.log(`  ${C.cyan}plan${C.reset}   ${ev.tool}(${truncate(JSON.stringify(ev.args), 120)})`);
      if (ev.rationale) console.log(`  ${C.grey}       ${ev.rationale}${C.reset}`);
    }
    if (ev.type === 'fallback') {
      console.log(
        `  ${C.yellow}note${C.reset}   ArmorIQ has no policy set on this workspace ` +
        `${C.grey}(${ev.reason}) — evaluating the same four rules locally${C.reset}`,
      );
    }
    if (ev.type === 'verdict') {
      const b = ev.verdict === 'allow' && beat?.enforce === false ? BADGE.ungoverned : BADGE[ev.verdict];
      const source = ev.source === 'local' ? ` ${C.yellow}(local policy)${C.reset}` : '';
      console.log(`  ${C.cyan}check${C.reset}  ${b}  ${C.grey}${ev.reason}${C.reset}${source}`);
      if (ev.matchedPolicy) {
        console.log(`  ${C.grey}       matched policy: ${ev.matchedPolicy}${C.reset}`);
      }
    }
    if (ev.type === 'executed') {
      if (ev.error) {
        console.log(`  ${C.cyan}exec${C.reset}   ${C.red}error${C.reset} ${ev.error}`);
      } else {
        console.log(`  ${C.cyan}exec${C.reset}   ${truncate(JSON.stringify(ev.result), 130)}`);
      }
      console.log(`  ${C.cyan}report${C.reset} recorded`);
    }
    if (ev.type === 'finish') {
      console.log(`  ${C.grey}planner finished: ${ev.rationale}${C.reset}`);
    }
    if (ev.type === 'stopped') {
      console.log(`  ${C.cyan}report${C.reset} recorded (not executed — ${ev.verdict})`);
    }
    if (ev.type === 'end') {
      console.log('');
      console.log(`  ${C.bold}outcome:${C.reset} ${explain(ev.outcome, beat)}`);
    }
  };
}

function explain(outcome, beat) {
  if (outcome === 'blocked') return `${BADGE.deny} — refused before execution. Nothing moved.`;
  if (outcome === 'held') return `${BADGE.hold} — paused for a human. Nothing moved yet.`;
  if (outcome === 'completed' && beat?.enforce === false) {
    return `${BADGE.ungoverned} — completed, because nothing was checking it.`;
  }
  if (outcome === 'completed') return `${C.green}completed${C.reset} — every call was inside the signed scope.`;
  return outcome;
}

/* ── Entry point ────────────────────────────────────────────────── */

async function main() {
  const target = (process.argv[2] ?? 'all').toLowerCase();

  const apiKey = process.env.ARMORIQ_API_KEY;
  const userEmail = process.env.ARMORIQ_USER_EMAIL;
  const userLow = process.env.ARMORIQ_USER_EMAIL_LOW ?? 'support-t1@example.com';
  const mcpName = process.env.ARMORIQ_MCP_NAME ?? 'payflow';
  const agentName = process.env.ARMORIQ_AGENT_NAME ?? 'payflow';
  const geminiKey = process.env.GEMINI_API_KEY;
  const geminiModel = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';

  const opts = { geminiKey, geminiModel };

  const keys = target === 'all' ? BEAT_ORDER : [target];
  if (keys.some((k) => !BEATS[k])) {
    console.error(`${C.red}Unknown beat "${target}".${C.reset} Try: ${BEAT_ORDER.join(', ')}, all`);
    process.exit(1);
  }

  if (!geminiKey) {
    console.error(`${C.red}GEMINI_API_KEY is missing.${C.reset} The planner cannot plan without it.`);
    process.exit(1);
  }

  const needsGoverned = keys.some((k) => BEATS[k].enforce !== false);

  console.log(`${C.bold}PayFlow${C.reset} ${C.grey}— governed by ArmorIQ${C.reset}`);
  console.log(`${C.grey}agent ${agentName} · mcp ${mcpName} · model ${geminiModel}${C.reset}`);

  /* Build the governed agent only if a governed beat is going to run, and
     survive a bad key rather than aborting — the ungoverned control is
     still a valid, demonstrable run. */
  let governed = null;
  if (needsGoverned) {
    try {
      governed = await createAgent({ apiKey, userEmail, mcpName, agentName, enforce: true });
    } catch (err) {
      console.error('');
      console.error(`${C.red}${C.bold}governance unavailable${C.reset}`);
      console.error(`${C.red}${err.message}${C.reset}`);
      console.error(`${C.dim}Continuing with the ungoverned beats only.${C.reset}`);
      console.error('');
    }
  }

  const summary = [];

  for (const key of keys) {
    const beat = BEATS[key];

    if (beat.enforce !== false && !governed) {
      console.log('');
      console.log(`${C.bold}${beat.label}${C.reset}`);
      console.log(`${C.red}skipped — no working ArmorIQ credentials${C.reset}`);
      summary.push({ key, outcome: 'skipped' });
      continue;
    }

    console.log('');
    console.log(`${C.bold}${beat.label}${C.reset}`);
    console.log(`${C.cyan}goal:${C.reset} ${beat.goal}`);
    console.log(`${C.grey}expected: ${beat.expect}${C.reset}`);

    if (beat.compare) {
      // Beat 4 is only interesting if the two identities are actually
      // different. Same address means the same policy resolves twice, and the
      // beat would quietly print two identical verdicts.
      if ((userLow ?? '').toLowerCase() === (userEmail ?? '').toLowerCase()) {
        console.log(`  ${C.yellow}warning: ARMORIQ_USER_EMAIL_LOW is the same address as ARMORIQ_USER_EMAIL.${C.reset}`);
        console.log(`  ${C.yellow}Both runs resolve the same policy, so these verdicts cannot differ.${C.reset}`);
      }

      // Beat 4: identical goal, two identities.
      for (const variant of beat.compare) {
        console.log('');
        console.log(`  ${C.magenta}${C.bold}── ${variant.label} (${variant.as}) ──${C.reset}`);
        const who = variant.as === 'userLow' ? userLow : userEmail;
        const run = await runOne(governed, beat.goal, {
          onEvent: printer(beat, variant.label),
          userEmail: who,
          ...opts,
        });
        summary.push({ key: `${key}:${variant.as}`, outcome: run.outcome });
      }
      continue;
    }

    console.log('');
    const agent = beat.enforce === false
      ? await createAgent({ apiKey, userEmail, mcpName, agentName, enforce: false })
      : governed;

    const run = await runOne(agent, beat.goal, { onEvent: printer(beat), ...opts });
    summary.push({ key, outcome: run.outcome });

    if (beat.enforce === false) {
      console.log('');
      console.log(`  ${C.yellow}${C.bold}That is the same agent, the same ticket and the same`);
      console.log(`  injection, with nothing checking it.${C.reset}`);
    }
  }

  if (keys.length > 1) {
    console.log('');
    console.log(`${C.bold}─── summary ───${C.reset}`);
    for (const s of summary) {
      const label = s.key.replace(':', ' · ');
      console.log(`  ${label.padEnd(30)} ${s.outcome}`);
    }
    console.log('');
    console.log(`  ${C.dim}Expect: allow→completed · hold→held · deny→blocked`);
    console.log(`  users → the same goal, two different verdicts`);
    console.log(`  ungoverned → completed, and the export went out anyway${C.reset}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('');
  console.error(`${C.red}${C.bold}run failed${C.reset}`);
  console.error(`${C.red}${err.message}${C.reset}`);
  if (process.env.DEBUG) console.error(C.grey + err.stack + C.reset);
  console.error(`${C.dim}Run "node check-setup.js" if this looks like a config problem.${C.reset}`);
  process.exit(1);
});