#!/usr/bin/env node
/**
 * PayFlow — capture the real runs the demo video shows.
 *
 *   node submission/video/capture.mjs
 *
 * Everything the video displays comes from this file: the exact stdout of the
 * CLI beats and of the test suite, captured with its ANSI colour codes intact.
 * The video never invents a verdict — if a run says BLOCKED, the video says
 * BLOCKED, and if a run fails, the capture records the failure and the render
 * step refuses to build.
 *
 * Runs are slow (each beat plans with Gemini), so results are cached in
 * captures.json. `--force` re-runs everything.
 */

import 'dotenv/config';
import { spawn } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OUT = path.join(HERE, 'captures.json');

const force = process.argv.includes('--force');

/* ── ANSI → structured lines ────────────────────────────────────── */

const SGR = {
  0: 'reset',
  1: 'bold',
  2: 'dim',
  22: 'reset-dim',
  31: 'red',
  32: 'green',
  33: 'yellow',
  35: 'magenta',
  36: 'cyan',
  90: 'grey',
  39: 'reset-fg',
};

/**
 * Split a raw stdout buffer into lines of styled segments.
 * The renderer turns `style` into a CSS class; anything unmapped is dropped
 * rather than guessed at.
 */
const FG = ['red', 'green', 'yellow', 'magenta', 'cyan', 'grey'];

export function parseAnsi(raw) {
  const text = raw.replace(/\r\n/g, '\n');
  const lines = [];
  let segs = [];
  let style = [];
  let buf = '';

  const flushSeg = () => {
    if (buf) {
      segs.push({ t: buf, s: style.join(' ') });
      buf = '';
    }
  };

  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\x1b' && text[i + 1] === '[') {
      const end = text.indexOf('m', i);
      if (end === -1) break;
      flushSeg();
      for (const code of text.slice(i + 2, end).split(';')) {
        const name = SGR[Number(code)];
        if (!name) continue;
        if (name === 'reset') style = [];
        else if (name === 'reset-fg') style = style.filter((s) => !FG.includes(s));
        else if (name === 'reset-dim') style = style.filter((s) => s !== 'dim');
        else if (!style.includes(name)) style = [...style, name];
      }
      i = end;
      continue;
    }
    if (text[i] === '\n') {
      flushSeg();
      lines.push(segs);
      segs = [];
      continue;
    }
    buf += text[i];
  }
  flushSeg();
  lines.push(segs);

  return lines.filter((l) => l.length > 0 && l.some((s) => s.t.trim() !== ''));
}

/* ── Run a command, keep stdout raw ─────────────────────────────── */

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      env: { ...process.env, FORCE_COLOR: '1' },
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/* ── Which runs the video needs ─────────────────────────────────── */

const RUNS = [
  {
    key: 'ungoverned',
    label: 'BEAT 5 — the same agent, no boundary',
    cmd: 'node',
    args: ['agent-cli.js', 'ungoverned'],
    // The control run. It must succeed *and* it must actually export data —
    // if this run ever stops exporting, the contrast the video makes is gone.
    expect: (text) => /"exported":true/.test(text) && /outcome: completed/.test(text),
    mustSay: 'export succeeded',
  },
  {
    key: 'deny',
    label: 'BEAT 3 — the agent reaches past its boundary',
    cmd: 'node',
    args: ['agent-cli.js', 'deny'],
    expect: (text) => /check\s+BLOCKED/.test(text) && /not executed/.test(text),
    mustSay: 'the call was refused before execution',
  },
  {
    key: 'tests',
    label: 'npm test',
    cmd: 'node',
    args: ['--test', 'tests/verify.test.js'],
    // Node's default reporter writes "ℹ fail 0"; older/spec reporters use
    // "# fail 0". Accept either, but require zero failures and a real count.
    expect: (text) => /(?:#|ℹ)\s*fail 0\b/.test(text) && /(?:#|ℹ)\s*pass [1-9]\d*\b/.test(text),
    mustSay: 'the suite passed',
  },
];

function envSummary() {
  return {
    agent: process.env.ARMORIQ_AGENT_NAME ?? 'payflow',
    mcp: process.env.ARMORIQ_MCP_NAME ?? 'payflow',
    user: process.env.ARMORIQ_USER_EMAIL ?? null,
    model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
    armoriqEnv: process.env.ARMORIQ_ENV ?? 'production',
  };
}

async function main() {
  let cached = null;
  if (!force) {
    try {
      cached = JSON.parse(await readFile(OUT, 'utf8'));
    } catch {
      cached = null;
    }
  }

  const runs = {};
  for (const spec of RUNS) {
    if (cached?.runs?.[spec.key] && !force) {
      runs[spec.key] = cached.runs[spec.key];
      console.log(`cached  ${spec.key} (${runs[spec.key].lines.length} lines)`);
      continue;
    }

    console.log(`run     ${spec.cmd} ${spec.args.join(' ')}`);
    const started = Date.now();
    const res = await run(spec.cmd, spec.args);
    const text = res.stdout.replace(/\x1b\[[0-9;]*m/g, '');
    const lines = parseAnsi(res.stdout + res.stderr);

    if (res.code !== 0) {
      console.error(`\n${spec.key} exited ${res.code}. Refusing to build a video around a failing run.`);
      console.error(text.slice(-1500));
      process.exit(1);
    }
    if (!spec.expect(text)) {
      console.error(`\n${spec.key} did not produce the output the video claims (${spec.mustSay}).`);
      console.error(text.slice(-1500));
      process.exit(1);
    }

    runs[spec.key] = {
      label: spec.label,
      cmd: [spec.cmd, ...spec.args].join(' '),
      exit: res.code,
      seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
      raw: text,
      lines,
    };
    console.log(`ok      ${spec.key} (${lines.length} lines, ${runs[spec.key].seconds}s)`);

    // Write as we go: a slow beat that fails should not throw away the runs
    // that already succeeded.
    await writeFile(OUT, `${JSON.stringify({ generatedAt: new Date().toISOString(), env: envSummary(), runs }, null, 2)}\n`);
  }

  const out = {
    generatedAt: new Date().toISOString(),
    env: envSummary(),
    runs,
  };
  await writeFile(OUT, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`\nwrote ${path.relative(ROOT, OUT)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
