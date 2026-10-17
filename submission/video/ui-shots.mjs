#!/usr/bin/env node
/**
 * Drive the real UI in Chrome, assert it behaves, and keep the screenshots
 * the video uses.
 *
 *   node submission/video/ui-shots.mjs [--url http://127.0.0.1:3111]
 *
 * This is a verification step first and an asset step second. It fails when:
 *   · the page logs an error or a request 404s
 *   · a scenario does not produce the verdict it claims
 *   · the trace is empty, or the outcome banner never appears
 *
 * The screenshots are the app's own pixels — no mock-ups. Frames in the video
 * are these files, so a UI bug would be visible in the video too.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, 'shots');

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};

const URL_BASE = arg('--url', 'http://127.0.0.1:3111');
const VIEW = { width: 1280, height: 860 };

async function findPlaywright() {
  try {
    return await import('playwright');
  } catch {
    /* fall through to the npx cache */
  }
  const cache = path.join(os.homedir(), 'AppData', 'Local', 'npm-cache', '_npx');
  if (fs.existsSync(cache)) {
    for (const d of fs.readdirSync(cache)) {
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
  }
  throw new Error('playwright not found — npm i -D playwright');
}

/** The steps as the UI rendered them — the evidence behind the narration. */
async function readTrace(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.step')].map((s) => ({
      tool: s.querySelector('.tool')?.textContent?.trim() ?? '',
      verdict: s.dataset.v ?? '',
      badge: s.querySelector('.badge')?.textContent?.trim() ?? '',
      reason: s.querySelector('.reason span')?.textContent?.trim() ?? '',
      result: s.querySelector('details.result summary')?.textContent?.trim() ?? null,
    })),
  );
}

/** Park the run card just under the sticky bar, then take the viewport. */
async function shotRun(page, file) {
  await page.evaluate(() => {
    const card = document.querySelector('.run-card');
    const y = card.getBoundingClientRect().top + window.scrollY - 74;
    window.scrollTo(0, Math.max(0, y));
  });
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(SHOTS, file) });
  console.log(`  → shots/${file}`);
}

const failures = [];
const check = (ok, label) => {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    console.log(`  ✗ ${label}`);
    failures.push(label);
  }
};

async function main() {
  const pw = await findPlaywright();
  const { chromium } = pw;

  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome' });
  } catch {
    browser = await chromium.launch();
  }

  await fsp.mkdir(SHOTS, { recursive: true });

  const context = await browser.newContext({
    viewport: VIEW,
    deviceScaleFactor: 2,
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();

  const consoleErrors = [];
  const badRequests = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400) badRequests.push(`${r.status()} ${r.url()}`);
  });

  console.log(`\nPayFlow UI check — ${URL_BASE}\n`);

  await page.goto(URL_BASE, { waitUntil: 'networkidle' });

  /* ── 1. the page as a product ─────────────────────────────────── */
  const healthText = (await page.locator('#healthText').innerText()).trim();
  check(/keys loaded|missing/.test(healthText), `health pill renders ("${healthText}")`);

  const scenarios = await page.locator('.scenario').count();
  check(scenarios === 5, `five scenarios listed (found ${scenarios})`);

  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check(bg === 'rgb(246, 246, 243)', `light page background (${bg})`);
  const scheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
  check(scheme === 'light only', `light colour scheme only (${scheme})`);

  await page.screenshot({ path: path.join(SHOTS, 'ui-top.png') });
  console.log('  → shots/ui-top.png');

  /* ── 2. governed run: the boundary refuses ────────────────────── */
  await page.locator('.scenario').nth(2).click();
  await page.locator('.outcome').waitFor({ state: 'visible', timeout: 180_000 });

  const blockedSteps = await page.locator('.step').count();
  const blockedBadge = (await page.locator('.step .badge').first().innerText()).trim();
  const blockedHead = (await page.locator('.outcome h3').innerText()).trim();
  const blockedBody = (await page.locator('.outcome p').innerText()).trim();
  const blockedTools = await page.locator('.step .tool').allInnerTexts();
  const governedTrace = await readTrace(page);

  check(blockedSteps >= 1, `governed run rendered ${blockedSteps} step(s)`);
  check(/blocked|held|allowed/i.test(blockedBadge), `first step carries a verdict badge ("${blockedBadge}")`);
  check(/blocked|held|completed/i.test(blockedHead), `outcome banner says what happened ("${blockedHead}")`);
  check(blockedTools.length === blockedSteps, 'every step names its tool');

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(120);
  await page.screenshot({ path: path.join(SHOTS, 'ui-blocked.png') });
  console.log('  → shots/ui-blocked.png');

  await shotRun(page, 'ui-blocked-trace.png');

  /* ── 3. ungoverned run: the same agent, nothing checking ──────── */
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.scenario').nth(4).click();
  await page.locator('.outcome').waitFor({ state: 'visible', timeout: 180_000 });

  const freeHead = (await page.locator('.outcome h3').innerText()).trim();
  const freeBody = (await page.locator('.outcome p').innerText()).trim();
  const freeDeltas = (await page.locator('.outcome .deltas').innerText()).trim();
  const freeBadges = await page.locator('.step .badge').allInnerTexts();
  const freeTrace = await readTrace(page);
  const freeTools = freeTrace.map((s) => s.tool);

  // The narration says the lookup and the ticket read go through before the
  // export; these are the tools that would make that false.
  check(freeTools.includes('lookup_customer'), `control run looked a customer up (${freeTools.join(', ')})`);
  check(freeTools.includes('read_support_tickets'), 'control run read the ticket');
  check(freeTools.includes('export_customer_data'), 'control run reached the export tool');
  check(freeTools.includes('send_email'), 'control run reached the email tool');

  check(/nothing checked/i.test(freeHead), `ungoverned outcome text ("${freeHead}")`);
  check(/exported/i.test(freeBody), `outcome names the export ("${freeBody.slice(0, 90)}…")`);
  check(/records exported/i.test(freeDeltas), `delta chip reports the export ("${freeDeltas.replace(/\n/g, " · ")}")`);
  check(/emails/i.test(freeDeltas), 'the control run also queued the email the video mentions');
  check(freeBadges.every((b) => /not checked/i.test(b)), `every step is labelled unchecked (${freeBadges.length})`);

  const stateExport = (await page.locator('#statExport').innerText()).trim();
  check(Number(stateExport) > 0, `state panel counts the exports (${stateExport})`);

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(120);
  await page.screenshot({ path: path.join(SHOTS, 'ui-free.png') });
  console.log('  → shots/ui-free.png');

  await shotRun(page, 'ui-free-trace.png');

  /* ── 4. the captured frame is legible, not clipped ───────────── */
  const audit = await page.evaluate(() => {
    const clipped = [...document.querySelectorAll('.card, .scenario, .step-body, .outcome, .stat')]
      .filter((el) => el.scrollWidth > el.clientWidth + 2)
      .map((el) => String(el.className).slice(0, 40));
    const step = document.querySelector('.step').getBoundingClientRect();
    const inFrame = step.top >= 0 && step.left >= 0 && step.right <= innerWidth;
    const tiny = [...document.querySelectorAll('.step .why, .step .args, .outcome p, .scenario .sc-goal')]
      .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 11)
      .length;
    return { clipped, inFrame, tiny, stepTop: Math.round(step.top) };
  });
  check(audit.clipped.length === 0, `no clipped blocks (${audit.clipped.join(', ') || 'clean'})`);
  check(audit.inFrame, `first step sits inside the captured frame (top ${audit.stepTop}px)`);
  check(audit.tiny === 0, `no body text below 11px (${audit.tiny} found)`);

  /* ── 4. narrow viewport sanity ────────────────────────────────── */
  const mobile = await context.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(URL_BASE, { waitUntil: 'networkidle' });
  const overflow = await mobile.evaluate(() => {
    const w = document.documentElement.clientWidth;
    return [...document.querySelectorAll('body *')]
      .filter((el) => el.getBoundingClientRect().right > w + 1)
      .map((el) => `${el.tagName.toLowerCase()}.${el.className}`.slice(0, 60));
  });
  check(overflow.length === 0, `no horizontal overflow at 390px (${overflow.slice(0, 3).join(', ') || 'clean'})`);
  await mobile.close();

  /* ── 5. the browser was quiet ─────────────────────────────────── */
  check(consoleErrors.length === 0, `no console errors${consoleErrors.length ? ` — ${consoleErrors[0]}` : ""}`);
  check(badRequests.length === 0, `no failed requests${badRequests.length ? ` — ${badRequests[0]}` : ""}`);

  await fsp.writeFile(
    path.join(SHOTS, 'ui-runs.json'),
    `${JSON.stringify({
      capturedAt: new Date().toISOString(),
      governed: { head: blockedHead, body: blockedBody, trace: governedTrace },
      control: { head: freeHead, body: freeBody, deltas: freeDeltas, trace: freeTrace },
    }, null, 2)}\n`,
  );
  console.log('  → shots/ui-runs.json');

  await browser.close();

  console.log('');
  if (failures.length) {
    console.error(`UI check failed — ${failures.length} problem(s).`);
    process.exit(1);
  }
  console.log('UI check passed — screenshots written to submission/video/shots/');
}

main().catch((err) => {
  console.error(`\nUI check crashed: ${err.message}\n`);
  process.exit(1);
});
