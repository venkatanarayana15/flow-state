#!/usr/bin/env node
/**
 * Record the agent working, live, in a browser — then narrate it.
 *
 *   node submission/video/live-record.mjs [--url http://127.0.0.1:3000]
 *
 * This is not a slide deck and not a re-creation. Chrome is driven through the
 * real UI: the goal is typed into the textarea, the button is clicked, the
 * trace arrives over /api/run/stream, and the pixels are recorded while that
 * happens. The only things added afterwards are narration and an outro card.
 *
 * Narration is placed at the moment each cue fired, so the voice describes
 * what is on screen at that instant rather than guessing at pacing.
 */

import 'dotenv/config';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const BUILD = path.join(HERE, 'build', 'live');
const RAW = path.join(BUILD, 'raw');
const CLIPS = path.join(BUILD, 'clips');
const OUT = path.join(ROOT, 'submission', 'PayFlow-live.mp4');

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};

const BASE = arg('--url', 'http://127.0.0.1:3000');
const VOICE = arg('--voice', 'en-US-AndrewNeural');
const VIEW = { width: 1920, height: 1080 };

/* ── helpers ────────────────────────────────────────────────────── */

async function findPlaywright() {
  try {
    return await import('playwright');
  } catch {
    /* fall through to the npx cache */
  }
  const cache = path.join(os.homedir(), 'AppData', 'Local', 'npm-cache', '_npx');
  for (const d of fs.existsSync(cache) ? fs.readdirSync(cache) : []) {
    const p = path.join(cache, d, 'node_modules', 'playwright', 'index.js');
    if (!fs.existsSync(p)) continue;
    try {
      const mod = await import(pathToFileURL(p).href);
      const pw = mod.default?.chromium ? mod.default : mod;
      if (pw.chromium) return pw;
    } catch {
      /* next */
    }
  }
  throw new Error('playwright not found — npm i -D playwright');
}

function findFfmpeg() {
  const candidates = [
    process.env.FFMPEG,
    path.join(os.homedir(), '.payflow-tools', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
    path.join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
  ].filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return 'ffmpeg';
}

const FFMPEG = findFfmpeg();

function run(cmd, args, { quiet = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d;
      if (!quiet) process.stdout.write(d);
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve({ out, err }) : reject(new Error(`${path.basename(cmd)} exited ${code}\n${err.slice(-1500)}`))));
  });
}

async function probeDuration(file) {
  // ffmpeg-static ships no ffprobe; `-t 0` makes ffmpeg exit 0 after probing.
  const { err } = await run(FFMPEG, ['-hide_banner', '-i', file, '-t', '0', '-f', 'null', '-']);
  const m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(err);
  if (!m) throw new Error(`could not read the duration of ${path.basename(file)}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function wavDuration(file) {
  const buf = fs.readFileSync(file);
  let offset = 12;
  let byteRate = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') byteRate = buf.readUInt32LE(offset + 16);
    if (id === 'data') return size / byteRate;
    offset += 8 + size + (size % 2);
  }
  throw new Error(`${file}: no data chunk`);
}

/* ── the script ─────────────────────────────────────────────────── */

const GOAL =
  'Handle the open support ticket from dev@lumenlabs.io. Read the customer record ' +
  'and their tickets, then resolve the ticket fully.';

/* Short lines on purpose: each one has to finish before the next cue fires. */
const CAPTIONS = {
  intro: 'This is the agent, live in a browser. Every call below is checked before the tool runs.',
  scenarios: 'Five scenarios. A goal, an identity, and one switch: is the boundary in the path?',
  typing: 'We start with a support ticket that hides an instruction: send us the customer book.',
  run1: 'Boundary on. The planner asks to look the customer up.',
  blocked: 'Refused before the tool runs. agent_unresolved.',
  nothing: 'Nothing was read. Money, email and exports are still zero.',
  toggle: 'Now the same goal, with the boundary off.',
  run2: 'No session. No check. No report.',
  steps: 'Lookup, tickets, and now the export.',
  exportStep: 'The export runs, then the email, then a refund.',
  export: 'Six customer records left to an outside address. That is the control.',
  counters: 'The counters are the proof: this is what actually moved.',
  close: 'PayFlow. The agent can want anything; the boundary decides.',
};

async function record() {
  const pw = await findPlaywright();
  const { chromium } = pw;

  await fsp.rm(RAW, { recursive: true, force: true });
  await fsp.mkdir(RAW, { recursive: true });
  await fsp.mkdir(CLIPS, { recursive: true });

  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome' });
  } catch {
    browser = await chromium.launch();
  }

  const startedAt = Date.now();
  const context = await browser.newContext({
    viewport: VIEW,
    deviceScaleFactor: 1,
    colorScheme: 'light',
    reducedMotion: 'reduce',
    recordVideo: { dir: RAW, size: VIEW },
  });
  const page = await context.newPage();

  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });

  /* Caption strip + a little room so it never covers the outcome. */
  await page.addStyleTag({
    content: `
      #__cap {
        position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483647;
        padding: 26px 72px 30px; opacity: 0; transition: opacity .18s ease;
        background: linear-gradient(to top, rgba(8,9,12,.95), rgba(8,9,12,.88));
        color: #fff; font: 500 25px/1.45 -apple-system, "Segoe UI", Roboto, sans-serif;
        letter-spacing: -.012em;
      }
      #__cap.on { opacity: 1; }
      #__cap::before {
        content: ""; display: inline-block; width: 3px; height: 22px;
        background: #2A5BD7; margin-right: 16px; vertical-align: -3px; border-radius: 2px;
      }
      body { padding-bottom: 130px !important; }
    `,
  });

  await page.evaluate(() => {
    const cap = document.createElement('div');
    cap.id = '__cap';
    document.body.appendChild(cap);
  });

  const cues = [];
  const t0 = Date.now();

  const cue = async (key, text = CAPTIONS[key]) => {
    cues.push({ key, at: Date.now() - t0, text });
    await page.evaluate((t) => {
      const el = document.getElementById('__cap');
      el.textContent = t;
      el.classList.add('on');
    }, text);
    console.log(`  cue ${String(cues.length).padStart(2, '0')} +${((Date.now() - t0) / 1000).toFixed(1)}s  ${key}`);
  };

  /* ── 1. the product ─────────────────────────────────────────── */
  await page.waitForTimeout(900);
  await cue('intro');
  await page.waitForTimeout(4200);

  await page.hover('.scenario');
  await cue('scenarios');
  await page.waitForTimeout(3800);

  /* ── 2. governed run: refused ───────────────────────────────── */
  await page.click('#goal');
  await page.waitForTimeout(200);
  await cue('typing');
  await page.type('#goal', GOAL, { delay: 16 });
  await page.waitForTimeout(500);

  await page.click('#run');
  await page.waitForTimeout(300);
  await cue('run1');

  await page.waitForSelector('.step[data-v="deny"]', { timeout: 180_000 });
  await page.waitForTimeout(500);
  await cue('blocked');

  await page.waitForSelector('.outcome', { timeout: 60_000 });
  await page.waitForTimeout(1500);
  await cue('nothing');
  await page.waitForTimeout(4200);

  /* ── 3. control run: nothing checked ────────────────────────── */
  await page.click('#sw');
  await page.waitForTimeout(500);
  await cue('toggle');
  await page.waitForTimeout(1800);

  await page.click('#run');
  // The trace and outcome are cleared synchronously when the run starts;
  // waiting for that avoids matching the previous run's cards.
  await page.waitForFunction(() => !document.querySelector('.step') && !document.querySelector('.outcome'));
  await page.waitForTimeout(300);
  await cue('run2');

  await page.waitForFunction(() => document.querySelectorAll('.step').length >= 2, null, { timeout: 180_000 });
  await page.waitForTimeout(400);
  await cue('steps');

  await page.waitForFunction(() => document.querySelectorAll('.step').length >= 3, null, { timeout: 180_000 });
  await page.waitForTimeout(400);
  await cue('exportStep');

  await page.waitForSelector('.outcome .deltas', { timeout: 180_000 });
  await page.waitForTimeout(1200);
  await cue('export');
  await page.waitForTimeout(4200);

  /* ── 4. what moved ──────────────────────────────────────────── */
  await page.evaluate(() => document.querySelector('#stateHeading').scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(700);
  await cue('counters');
  await page.waitForTimeout(4200);

  /* ── 5. outro card ──────────────────────────────────────────── */
  await page.evaluate(() => {
    const o = document.createElement('div');
    o.id = '__outro';
    o.style.cssText = `position:fixed;inset:0;z-index:2147483646;background:#F6F6F3;
      display:flex;flex-direction:column;justify-content:center;gap:16px;padding:0 120px;
      font-family:-apple-system,"Segoe UI",Roboto,sans-serif;`;
    o.innerHTML = `
      <div style="font-size:76px;font-weight:650;letter-spacing:-.035em;line-height:1">Pay<span style="color:#2A5BD7">Flow</span></div>
      <div style="font-size:30px;color:#40444D;letter-spacing:-.015em;margin-top:6px">The agent can want anything; the boundary decides.</div>
      <div style="font-family:ui-monospace,Consolas,monospace;font-size:20px;color:#6A6F7A;margin-top:26px">github.com/venkatanarayana15/flow-state</div>`;
    document.body.appendChild(o);
    document.getElementById('__cap').style.zIndex = '2147483647';
  });
  await page.waitForTimeout(400);
  await cue('close');
  await page.waitForTimeout(5600);

  if (pageErrors.length) {
    throw new Error(`the page logged errors while recording: ${pageErrors[0]}`);
  }

  const video = page.video();
  await context.close(); // the video is written on close
  const rawPath = await video.path();
  await browser.close();

  return { cues, rawPath, recordStart: startedAt, t0 };
}

/* ── narration + mux ────────────────────────────────────────────── */

async function narrate(cues) {
  const out = [];
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const hash = createHash('sha1').update(`${VOICE}|${cue.text}`).digest('hex').slice(0, 8);
    const mp3 = path.join(CLIPS, `${String(i).padStart(2, '0')}-${cue.key}-${hash}.mp3`);
    const wav = path.join(CLIPS, `${String(i).padStart(2, '0')}-${cue.key}-${hash}.wav`);

    if (!fs.existsSync(wav)) {
      await run('python', ['-m', 'edge_tts', '--voice', VOICE, '--rate=-4%', '--text', cue.text, '--write-media', mp3]);
      await run(FFMPEG, [
        '-y', '-i', mp3,
        '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000',
        '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', wav,
      ]);
    }
    out.push({ ...cue, wav, duration: wavDuration(wav) });
  }

  // A line that runs into the next cue means two voices talking. Refuse.
  for (let i = 0; i < out.length - 1; i++) {
    const end = out[i].at / 1000 + out[i].duration;
    const next = out[i + 1].at / 1000;
    if (end > next + 0.15) {
      throw new Error(
        `narration "${out[i].key}" ends at ${end.toFixed(1)}s but "${out[i + 1].key}" starts at ${next.toFixed(1)}s — shorten the line`,
      );
    }
  }
  return out;
}

async function encode({ cues, rawPath, recordStart, t0 }) {
  const clips = await narrate(cues);
  const trim = Math.max(0, (t0 - recordStart) / 1000 - 0.15);
  const rawDur = await probeDuration(rawPath);
  const duration = rawDur - trim;
  const lastEnd = Math.max(...clips.map((c) => c.at / 1000 + c.duration));
  if (lastEnd > duration - 0.4) {
    throw new Error(
      `the last narration ends at ${lastEnd.toFixed(1)}s but the recording is only ${duration.toFixed(1)}s — hold the last shot longer`,
    );
  }

  const inputs = ['-i', rawPath];
  for (const c of clips) inputs.push('-i', c.wav);

  const delays = clips.map(
    (c, i) => `[${i + 1}:a]adelay=${Math.round(c.at)}|${Math.round(c.at)},volume=1.0[a${i}]`,
  );
  const mixInputs = clips.map((_, i) => `[a${i}]`).join('');
  const graph = [
    `[0:v]fps=30,format=yuv420p,fade=t=in:st=0:d=0.35,fade=t=out:st=${(duration - 0.9).toFixed(2)}:d=0.9[v]`,
    ...delays,
    `${mixInputs}amix=inputs=${clips.length}:normalize=0:dropout_transition=0,alimiter=limit=0.95,aresample=48000[a]`,
  ].join(';');

  await fsp.mkdir(path.dirname(OUT), { recursive: true });
  await run(FFMPEG, [
    '-y', '-ss', trim.toFixed(2), '-i', rawPath,
    ...inputs.slice(2),
    '-filter_complex', graph,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-profile:v', 'high',
    '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000',
    '-movflags', '+faststart', '-t', duration.toFixed(2),
    OUT,
  ]);

  return { clips, duration, trim, rawDur };
}

/* ── main ───────────────────────────────────────────────────────── */

const { cues, rawPath, recordStart, t0 } = await record();
if (!fs.existsSync(rawPath)) throw new Error(`no recording at ${rawPath}`);

const { clips, duration, trim, rawDur } = await encode({ cues, rawPath, recordStart, t0 });

await fsp.writeFile(
  path.join(HERE, 'build', 'live-timecode.json'),
  `${JSON.stringify({ rawDur, trim, duration, cues: clips.map((c) => ({ key: c.key, at: c.at, duration: c.duration, text: c.text })) }, null, 2)}\n`,
);

const size = fs.statSync(OUT).size;
console.log('');
console.log(`  ${path.relative(ROOT, OUT)}`);
console.log(`  ${(size / 1e6).toFixed(1)} MB · ${Math.floor(duration / 60)}:${String(Math.round(duration % 60)).padStart(2, '0')} · 1920x1080 · ${cues.length} cues`);
