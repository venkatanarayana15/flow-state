#!/usr/bin/env node
/**
 * PayFlow — setup checker.
 *
 *   node check-setup.js
 *
 * ArmorIQ fails closed and fails quietly. A missing policy and a correctly
 * configured strict policy produce the same output. A policy scoped to the
 * wrong MCP, or written against an agent name that isn't registered, also
 * produces the same output — nothing is checked, nothing warns you, and you
 * discover it live, on stage, in front of judges.
 *
 * This script turns those silent failures into loud ones. It reads only. It
 * creates no plans, no intent tokens and no approval requests, so it is safe
 * to run against the real account as often as you like.
 */

import 'dotenv/config';
import { ArmorIQClient } from '@armoriq/sdk';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

let failures = 0;
const ok = (m) => console.log(`  ${C.green}OK${C.reset}    ${m}`);
const bad = (m) => { failures++; console.log(`  ${C.red}FAIL${C.reset}  ${m}`); };
const warn = (m) => console.log(`  ${C.yellow}WARN${C.reset}  ${m}`);
const info = (m) => console.log(`  ${C.dim}·${C.reset}    ${m}`);

const namesOf = (entries) =>
  (Array.isArray(entries) ? entries : [])
    .map((e) => (typeof e === 'string' ? e : e?.name))
    .filter(Boolean);

async function main() {
  const apiKey = process.env.ARMORIQ_API_KEY;
  const agentName = process.env.ARMORIQ_AGENT_NAME ?? 'payflow';
  const mcpName = process.env.ARMORIQ_MCP_NAME ?? 'payflow';
  const userEmail = process.env.ARMORIQ_USER_EMAIL;

  console.log('');
  console.log(`${C.bold}PayFlow setup check${C.reset}`);
  console.log(`${C.dim}${'─'.repeat(52)}`);

  /* ── 1. Local environment ─────────────────────────────────────── */
  console.log(`${C.bold}Environment${C.reset}`);
  if (!apiKey) {
    bad('ARMORIQ_API_KEY missing — copy .env.example to .env');
    return finish();
  }
  ok(`ARMORIQ_API_KEY present (${apiKey.slice(0, 7)}…, ${apiKey.length} chars)`);

  if (!/^ak_(live|test)_/.test(apiKey)) {
    warn('key does not start with ak_live_ or ak_test_ — the SDK validates this prefix');
  } else {
    ok(`key prefix ${apiKey.startsWith('ak_live_') ? 'ak_live_' : 'ak_test_'}`);
  }

  /* The prefix does NOT say which backend issued the key: a staging key can
     carry ak_live_. ARMORIQ_ENV picks the endpoints, so print which one is in
     play — a mismatch here is a 401 that looks exactly like a dead key. */
  const sdkEnv = (process.env.ARMORIQ_ENV || '').trim().toLowerCase();
  if (sdkEnv === 'staging' || sdkEnv === 'local') {
    info(`ARMORIQ_ENV=${sdkEnv} — endpoints resolved from this override`);
  } else {
    info('ARMORIQ_ENV not set — using production endpoints (api.armoriq.ai)');
  }

  if (!process.env.GEMINI_API_KEY) {
    bad('GEMINI_API_KEY missing — the planner cannot plan without it');
  } else {
    ok('GEMINI_API_KEY present');
  }

  if (!userEmail || userEmail === 'you@example.com') {
    warn('ARMORIQ_USER_EMAIL is still the placeholder — set it to your real address');
  } else {
    ok(`ARMORIQ_USER_EMAIL = ${userEmail}`);
  }

  /* Beat 4 is "same call, two people". If both env vars hold the same
     address, ArmorIQ resolves the same policy twice and the beat prints two
     identical verdicts without complaining — a silent failure on stage. */
  const userLow = process.env.ARMORIQ_USER_EMAIL_LOW;
  if (!userLow) {
    warn('ARMORIQ_USER_EMAIL_LOW is not set — beat 4 has nothing to compare');
  } else if (userEmail && userLow.toLowerCase() === userEmail.toLowerCase()) {
    bad(
      'ARMORIQ_USER_EMAIL_LOW is the SAME address as ARMORIQ_USER_EMAIL — ' +
      'beat 4 will show two identical verdicts',
    );
  } else {
    ok(`ARMORIQ_USER_EMAIL_LOW = ${userLow}`);
  }
  info(`model = ${process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'}`);

  /* ── 2. The ArmorIQ account ───────────────────────────────────── */
  console.log('');
  console.log(`${C.bold}ArmorIQ account${C.reset}`);

  const client = new ArmorIQClient({
    apiKey,
    userId: userEmail ?? 'agent',
    agentId: agentName,
    useProduction: apiKey.startsWith('ak_live_'),
  });

  let account;
  try {
    account = await client.bootstrap();
    ok(`authenticated — org "${account?.org?.name ?? account?.name ?? 'unnamed'}"`);
  } catch (err) {
    bad(`bootstrap failed — ${err.message}`);
    console.log(
      `  ${C.dim}An expired key fails here — but so does a valid key pointed at the${C.reset}\n` +
      `  ${C.dim}wrong backend. Check the key at platform.armoriq.ai → Settings → API Keys,${C.reset}\n` +
      `  ${C.dim}then set ARMORIQ_ENV=staging if the key came from dev.armoriq.ai.${C.reset}`,
    );
    return finish();
  }

  /* ── 3. Names must match exactly ─────────────────────────────── */
  console.log('');
  console.log(`${C.bold}Name matching${C.reset}`);
  console.log(`${C.dim}A mismatch here is the single most common reason nothing gets checked.${C.reset}`);

  const agentNames = namesOf(account?.agents);
  const mcpNames = namesOf(account?.mcps);

  if (agentNames.length === 0) {
    warn('no agents registered on this account');
    info(`you need an agent named "${agentName}"`);
    info('Console → Agents → Register Agent');
  } else if (agentNames.includes(agentName)) {
    ok(`agent "${agentName}" is registered`);
  } else {
    bad(`agent "${agentName}" is NOT registered`);
    info(`registered: ${agentNames.join(', ')}`);
    info('either register it, or change ARMORIQ_AGENT_NAME');
  }

  if (mcpNames.length === 0) {
    warn('no MCP servers registered on this account');
    info(`you need an MCP server named "${mcpName}"`);
    info('Console → MCP Servers → Register MCP Server');
  } else if (mcpNames.includes(mcpName)) {
    ok(`MCP "${mcpName}" is registered`);
  } else {
    bad(`MCP "${mcpName}" is NOT registered`);
    info(`registered: ${mcpNames.join(', ')}`);
    info('either register it, or change ARMORIQ_MCP_NAME');
  }

  /* ── 4. The policy set ────────────────────────────────────────── */
  console.log('');
  console.log(`${C.bold}Policy${C.reset}`);
  const policies = Array.isArray(account?.policies) ? account.policies : [];
  if (policies.length === 0) {
    bad('no policies visible on this account');
    console.log('');
    console.log(`  ${C.bold}Until a policy matches, every call is refused with no_matching_policy.${C.reset}`);
    console.log(`  ${C.dim}Create these four in Console → Policies → New Policy,${C.reset}`);
    console.log(`  ${C.dim}all scoped to the "${mcpName}" MCP:${C.reset}`);
    console.log('');
    console.log(`    reads-allowed            allow    lookup_customer, list_recent_orders,`);
    console.log(`                                     read_support_tickets`);
    console.log(`    money-under-limit        allow    refund_order, issue_store_credit`);
    console.log(`                                     (amount <= 500)`);
    console.log(`    money-over-limit         hold    refund_order, issue_store_credit`);
    console.log(`                                     (amount > 500)`);
    console.log(`    destructive-denied       block   export_customer_data, send_email`);
    console.log('');
  } else {
    ok(`${policies.length} polic${policies.length === 1 ? 'y' : 'ies'} on the account`);
    for (const p of policies) {
      const label = typeof p === 'string' ? p : (p?.name ?? JSON.stringify(p).slice(0, 80));
      info(`- ${label}`);
    }
  }

  console.log('');
  console.log(`${C.dim}Tool names ArmorIQ matches: refund_order, issue_store_credit,`);
  console.log(`export_customer_data, send_email, lookup_customer, list_recent_orders,`);
  console.log(`read_support_tickets. Threshold rules scan args for: amount, value,`);
  console.log(`total, price, cost. A field called total_cents is never seen.${C.reset}`);

  finish();
}

function finish() {
  console.log('');
  console.log(`${C.dim}${'─'.repeat(52)}`);
  if (failures === 0) {
    console.log(`${C.green}${C.bold}Ready.${C.reset} Run a beat:  npm run beat:deny`);
  } else {
    console.log(`${C.red}${C.bold}${failures} problem${failures === 1 ? '' : 's'} to fix first.${C.reset}`);
    console.log(`${C.dim}Fix them above, then run this again.${C.reset}`);
  }
  console.log('');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`${C.red}check-setup crashed:${C.reset} ${err.message}`);
  process.exit(1);
});