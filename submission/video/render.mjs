#!/usr/bin/env node
/**
 * PayFlow — render the demo video.
 *
 *   node submission/video/render.mjs [--out submission/PayFlow-demo.mp4]
 *
 * Three stages, no manual editing:
 *
 *   1. narration  — edge-tts reads the script to mp3, one file per scene.
 *                   The audio length is what sets the scene length, so the
 *                   picture always keeps up with the voice.
 *   2. frames     — Chrome paints the stage at 1920x1080, once per revealed
 *                   step, and reports any element that overflowed. A frame
 *                   that overflows fails the build instead of shipping.
 *   3. mux        — ffmpeg concatenates the frames, lays the narration under
 *                   them and encodes H.264 + AAC.
 *
 * Requires: python with edge-tts, ffmpeg, and playwright's Chromium (or
 * Chrome). See README.md in this directory.
 */

import 'dotenv/config';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildScenes } from './scenes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const BUILD = path.join(HERE, 'build');
const FRAMES = path.join(BUILD, 'frames');
const AUDIO = path.join(HERE, 'audio');

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};

const OUT = path.resolve(ROOT, arg('--out', 'submission/PayFlow-demo.mp4'));
const VOICE = arg('--voice', 'en-US-AndrewNeural');
const FPS = Number(arg('--fps', 30));
const W = 1920;
const H = 1080;

/* ── tool discovery ─────────────────────────────────────────────── */

function findFfmpeg() {
  /* Playwright ships its own ffmpeg, but it is a stripped build: no mp3
     decoder, no libx264, no AAC. It looks like ffmpeg and fails at the first
     real encode, so it is deliberately not a candidate here. */
  const candidates = [
    process.env.FFMPEG,
    path.join(os.homedir(), '.payflow-tools', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
    path.join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
  ].filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return 'ffmpeg';
}

async function findPlaywright() {
  try {
    return await import('playwright');
  } catch {
    /* fall through to the npx cache */
  }
  const cache = path.join(os.homedir(), 'AppData', 'Local', 'npm-cache', '_npx');
  const candidates = [];
  if (fs.existsSync(cache)) {
    for (const d of fs.readdirSync(cache)) {
      const p = path.join(cache, d, 'node_modules', 'playwright', 'index.js');
      if (fs.existsSync(p)) candidates.push(p);
    }
  }
  for (const p of candidates) {
    try {
      const mod = await import(pathToFileURL(p).href);
      const pw = mod.default?.chromium ? mod.default : mod;
      if (pw.chromium) return pw;
    } catch {
      /* try the next one */
    }
  }
  throw new Error('playwright not found — npm i -D playwright (see submission/video/README.md)');
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
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${path.basename(cmd)} exited ${code}\n${err.slice(-2000)}`));
    });
  });
}

/* ── audio ──────────────────────────────────────────────────────── */

function wavDuration(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`${file} is not a RIFF file`);
  let offset = 12;
  let byteRate = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') byteRate = buf.readUInt32LE(offset + 16);
    if (id === 'data') {
      if (!byteRate) throw new Error(`${file}: data chunk before fmt chunk`);
      return size / byteRate;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error(`${file}: no data chunk`);
}

async function narrate(scene) {
  await fsp.mkdir(AUDIO, { recursive: true });
  const mp3 = path.join(AUDIO, `${String(scene.index).padStart(2, '0')}-${scene.id}.mp3`);
  const wav = path.join(BUILD, `${String(scene.index).padStart(2, '0')}-${scene.id}.wav`);

  if (!fs.existsSync(mp3) || !fs.existsSync(wav)) {
    await run('python', [
      '-m', 'edge_tts',
      '--voice', VOICE,
      '--rate=-4%',
      '--text', scene.narration,
      '--write-media', mp3,
    ]);
    await run(FFMPEG, [
      '-y', '-i', mp3,
      '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000',
      '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le',
      wav,
    ]);
  }
  return { mp3, wav, duration: wavDuration(wav) };
}

/* ── frames ─────────────────────────────────────────────────────── */

function pngSize(file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(24);
  fs.readSync(fd, buf, 0, 24, 0);
  fs.closeSync(fd);
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

async function main() {
  const captures = JSON.parse(
    await fsp.readFile(path.join(HERE, 'captures.json'), 'utf8'),
  );
  const scenes = buildScenes(captures);

  await fsp.rm(BUILD, { recursive: true, force: true });
  await fsp.mkdir(FRAMES, { recursive: true });

  console.log(`\nPayFlow video — ${scenes.length} scenes, voice ${VOICE}\n`);

  /* 1. narration → scene length */
  const timed = [];
  for (const scene of scenes) {
    const audio = await narrate(scene);
    const duration = Math.max(audio.duration + scene.tail, 2.4);
    timed.push({ scene, audio, duration });
    console.log(
      `  ${String(scene.index).padStart(2, '0')} ${scene.id.padEnd(11)} ` +
      `voice ${audio.duration.toFixed(1)}s → scene ${duration.toFixed(1)}s`,
    );
  }
  const total = timed.reduce((s, t) => s + t.duration, 0);

  /* 2. frame plan: each revealed step gets an even slice of the spoken time */
  const plan = []; // { scene, step, file, duration, start }
  let clock = 0;
  for (const item of timed) {
    const { scene, duration } = item;
    const n = scene.steps.length;
    const revealSpan = n > 1 ? Math.max(duration - 1.2, (duration - 1.2) * 0.92) : 0;
    for (let i = 0; i < n; i++) {
      const start = i === 0 ? 0 : (revealSpan * i) / (n - 1);
      const next = i === n - 1 ? duration : (revealSpan * (i + 1)) / (n - 1);
      const file = path.join(
        FRAMES,
        `s${String(scene.index).padStart(2, '0')}_${String(i).padStart(2, '0')}.png`,
      );
      plan.push({
        scene,
        step: i,
        file,
        start: clock + start,
        duration: Math.max(next - start, 0.04),
        progress: (clock + start) / total,
      });
    }
    clock += duration;
  }

  /* 3. paint */
  const pw = await findPlaywright();
  const { chromium } = pw;
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome' });
  } catch {
    browser = await chromium.launch();
  }
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(path.join(HERE, 'stage.html')).href);

  const payloadFor = (frame, lock) => ({
    kicker: frame.scene.kicker,
    chip: frame.scene.chip,
    html: frame.scene.steps[frame.step].html,
    caption: frame.scene.steps[frame.step].caption ?? frame.scene.narration,
    footnote: frame.scene.footnote ?? '',
    progress: Math.min(frame.progress, 1),
    lock,
  });

  /* Measure each scene's fullest frame first and lock every frame in that
     scene to it, so the terminal does not reflow line by line. */
  const locks = {};
  for (const scene of scenes) {
    const lastFrame = plan.filter((f) => f.scene === scene).at(-1);
    if (!lastFrame) continue;
    const report = await page.evaluate((p) => window.paint(p), payloadFor(lastFrame, null));
    const lock = {};
    for (const [key, r] of Object.entries(report)) {
      if (key === 'frame' || r.overflow) continue;
      lock[key] = r.end;
    }
    locks[scene.id] = lock;
  }

  let worst = 1;
  const complaints = [];
  for (const frame of plan) {
    const payload = payloadFor(frame, locks[frame.scene.id]);
    const report = await page.evaluate((p) => window.paint(p), payload);
    if (report.frame.w !== W || report.frame.h !== H) {
      complaints.push(`${path.basename(frame.file)}: page is ${report.frame.w}x${report.frame.h}`);
    }
    for (const [key, r] of Object.entries(report)) {
      if (key === 'frame') continue;
      if (r.overflow) complaints.push(`${path.basename(frame.file)}: ${key} still overflows at ${r.end}px`);
      // Text nobody can read is the same as text that is missing. Anything
      // below 15px on a 1080p frame would be ~10px at 720p — refuse to ship it.
      if (r.end < 15) complaints.push(`${path.basename(frame.file)}: ${key} shrank to ${r.end}px, too small to read`);
      if (r.end < r.start) {
        console.log(`  · ${frame.scene.id}#${frame.step} ${key}: ${r.start}px → ${r.end}px`);
      }
      worst = Math.min(worst, r.end / r.start);
    }
    await page.screenshot({ path: frame.file, animations: 'disabled' });
    const size = pngSize(frame.file);
    if (size.w !== W || size.h !== H) {
      complaints.push(`${path.basename(frame.file)}: png is ${size.w}x${size.h}`);
    }
  }
  await browser.close();

  if (complaints.length) {
    console.error('\nLayout check failed — refusing to encode:');
    for (const c of complaints) console.error(`  ${c}`);
    process.exit(1);
  }
  console.log(`\n  ${plan.length} frames painted, all ${W}x${H}, nothing overflowing (worst fit ${(worst * 100).toFixed(0)}% of start size)`);

  /* 4. frames list */
  const listFile = path.join(BUILD, 'frames.ffconcat');
  const lines = ['ffconcat version 1.0'];
  for (const frame of plan) {
    lines.push(`file '${frame.file.replace(/\\/g, '/')}'`);
    lines.push(`duration ${frame.duration.toFixed(3)}`);
  }
  const last = plan[plan.length - 1];
  lines.push(`file '${last.file.replace(/\\/g, '/')}'`);
  lines.push(`duration ${(last.duration + 0.4).toFixed(3)}`);
  await fsp.writeFile(listFile, `${lines.join('\n')}\n`);

  /* 5. audio: pad each scene to its slot, then concatenate */
  const audioList = path.join(BUILD, 'audio.ffconcat');
  const alines = ['ffconcat version 1.0'];
  for (const item of timed) {
    const padded = path.join(BUILD, `${String(item.scene.index).padStart(2, '0')}-padded.wav`);
    const d = item.duration.toFixed(3);
    await run(FFMPEG, [
      '-y', '-i', item.audio.wav,
      '-af', `apad=whole_dur=${d},atrim=0:${d}`,
      '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le',
      padded,
    ]);
    alines.push(`file '${padded.replace(/\\/g, '/')}'`);
  }
  await fsp.writeFile(audioList, `${alines.join('\n')}\n`);
  const fullAudio = path.join(BUILD, 'narration.wav');
  await run(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', audioList, '-c', 'copy', fullAudio]);

  /* 6. encode */
  await fsp.mkdir(path.dirname(OUT), { recursive: true });
  const fadeOut = Math.max(total - 0.8, 0);
  await run(FFMPEG, [
    '-y',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-i', fullAudio,
    '-vf', `fps=${FPS},format=yuv420p,fade=t=in:st=0:d=0.5,fade=t=out:st=${fadeOut.toFixed(2)}:d=0.8`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-profile:v', 'high',
    '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000',
    '-movflags', '+faststart',
    '-t', total.toFixed(3),
    OUT,
  ]);

  const size = fs.statSync(OUT).size;
  console.log(`\n  ${path.relative(ROOT, OUT)}`);
  console.log(`  ${(size / 1e6).toFixed(1)} MB · ${Math.floor(total / 60)}:${String(Math.round(total % 60)).padStart(2, '0')} · ${FPS}fps · ${W}x${H}\n`);
}

main().catch((err) => {
  console.error(`\nrender failed: ${err.message}\n`);
  process.exit(1);
});
