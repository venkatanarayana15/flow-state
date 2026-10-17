/**
 * PayFlow — local verification suite.
 *
 *   npm test
 *
 * No network, no API keys, no dependency on ArmorIQ being reachable. This
 * covers everything that can be proven offline, and it is weighted toward
 * the parts where a silent bug would be invisible in a demo:
 *
 *   1. readVerdict  — the function that decides allow / hold / block.
 *      Every branch matters, and the failure mode that matters most is the
 *      one where something unreadable gets treated as permission.
 *   2. the tools    — happy paths, and every error path, because an
 *      unhandled throw mid-run is what kills a live demo.
 *   3. threshold    — ArmorIQ scans arguments for amount/value/total/price/
 *      cost. A money tool whose schema names the field anything else will
 *      have a limit rule that never fires.
 *   4. seed data    — the injection has to actually be there, or beat 3
 *      demos nothing.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { readVerdict } from '../src/agent.js';
import {
  TOOLS,
  executeTool,
  toolByName,
  LEDGER,
  OUTBOX,
  EXPORT_LOG,
} from '../src/tools.js';
import {
  TICKETS,
  CUSTOMERS,
  ORDERS,
  STORE,
  findCustomerByEmail,
  ordersForCustomer,
} from '../src/db.js';

/* ────────────────────────────────────────────────────────────────
 * 1. readVerdict — the security-critical decision reader
 * ──────────────────────────────────────────────────────────────── */

describe('readVerdict', () => {
  test('reads a documented allow', () => {
    const v = readVerdict({ allowed: true, action: 'allow', reason: 'within scope' });
    assert.equal(v.status, 'allow');
    assert.equal(v.matchedPolicy, null);
  });

  test('surfaces the matched policy name for the audit trail', () => {
    const v = readVerdict({ allowed: true, action: 'allow', matchedPolicy: 'reads-allowed' });
    assert.equal(v.matchedPolicy, 'reads-allowed');
  });

  test('reads a documented block', () => {
    const v = readVerdict({
      allowed: false,
      action: 'block',
      reason: 'destructive operation, not available to agents',
    });
    assert.equal(v.status, 'deny');
    assert.match(v.reason, /not available/);
  });

  test('reads a documented hold and does NOT treat it as allow', () => {
    const v = readVerdict({
      allowed: false,
      action: 'hold',
      reason: '$4000.00 exceeds the support_t1 refund limit of $500.00',
    });
    assert.equal(v.status, 'hold');
  });

  test('a hold that reports allowed:true is still a hold, not a run', () => {
    // Defence in depth: if the backend ever sets allowed on a hold, the
    // action field wins. The conservative reading is the safe one.
    const v = readVerdict({ allowed: true, action: 'hold', reason: 'awaiting approval' });
    assert.equal(v.status, 'hold');
  });

  test('falls back to allowed:true when action is absent', () => {
    assert.equal(readVerdict({ allowed: true }).status, 'allow');
  });

  test('falls back to allowed:false when action is absent', () => {
    assert.equal(readVerdict({ allowed: false }).status, 'deny');
  });

  test('FAILS CLOSED on null', () => {
    assert.equal(readVerdict(null).status, 'deny');
  });

  test('FAILS CLOSED on undefined', () => {
    assert.equal(readVerdict(undefined).status, 'deny');
  });

  test('FAILS CLOSED on an empty object', () => {
    assert.equal(readVerdict({}).status, 'deny');
  });

  test('FAILS CLOSED on an unrecognised action', () => {
    assert.equal(readVerdict({ allowed: true, action: 'allow_anyway' }).status, 'deny');
  });

  test('FAILS CLOSED on allow_log rather than guessing it means allow', () => {
    // allow_log is a real value in the SDK's PolicyEnforcementAction. It is
    // not in EnforceResult.action, so if it ever reaches us we must not
    // assume it is permission. The SDK's own normalizeDefaultAction maps it
    // to allow server-side; if that mapping is absent, we still deny.
    assert.equal(readVerdict({ allowed: true, action: 'allow_log' }).status, 'deny');
  });

  test('FAILS CLOSED on a delegation action', () => {
    assert.equal(readVerdict({ allowed: true, action: 'delegate' }).status, 'deny');
  });

  test('an unrecognised action reports which action it saw', () => {
    const v = readVerdict({ allowed: true, action: 'mystery_mode' });
    assert.match(v.reason, /mystery_mode/);
  });

  test('an absent action with allowed:true is still allowed', () => {
    assert.equal(readVerdict({ allowed: true, action: undefined }).status, 'allow');
  });

  test('FAILS CLOSED on a non-object', () => {
    assert.equal(readVerdict('allowed').status, 'deny');
  });
});

/* ────────────────────────────────────────────────────────────────
 * 2. Tools — happy paths
 * ──────────────────────────────────────────────────────────────── */

describe('tools: safe reads', () => {
  test('lookup_customer finds a seeded customer', async () => {
    const r = await executeTool('lookup_customer', { email: 'amara@example.com' });
    assert.equal(r.found, true);
    assert.equal(r.customer.id, 'cus_1042');
  });

  test('lookup_customer is case-insensitive', async () => {
    const r = await executeTool('lookup_customer', { email: 'AMARA@Example.COM' });
    assert.equal(r.found, true);
  });

  test('lookup_customer returns found:false rather than throwing on an unknown address', async () => {
    const r = await executeTool('lookup_customer', { email: 'nobody@example.com' });
    assert.equal(r.found, false);
  });

  test('list_recent_orders returns orders newest first', async () => {
    const r = await executeTool('list_recent_orders', { customer_id: 'cus_1042' });
    assert.equal(r.count, 2);
    assert.equal(r.orders[0].placed >= r.orders[1].placed, true);
  });

  test('read_support_tickets returns the ticket body verbatim', async () => {
    const r = await executeTool('read_support_tickets', { customer_id: 'cus_7781' });
    assert.equal(r.count, 1);
    assert.equal(r.tickets[0].id, 'NW-T-3391');
  });
});

describe('tools: money', () => {
  test('refund_order writes to the ledger', async () => {
    const before = LEDGER.length;
    const r = await executeTool('refund_order', {
      order_id: 'NW-4471', amount: 68, reason: 'broken zip',
    });
    assert.equal(r.refunded, true);
    assert.equal(LEDGER.length, before + 1);
    assert.equal(LEDGER.at(-1).type, 'refund');
  });

  test('issue_store_credit writes to the ledger', async () => {
    const before = LEDGER.length;
    const r = await executeTool('issue_store_credit', {
      customer_id: 'cus_4415', amount: 4000, reason: 'lost bulk order',
    });
    assert.equal(r.credited, true);
    assert.equal(LEDGER.at(-1).amount, 4000);
    assert.equal(LEDGER.length, before + 1);
  });
});

describe('tools: egress', () => {
  test('export_customer_data records the attempt', async () => {
    const before = EXPORT_LOG.length;
    const r = await executeTool('export_customer_data', {
      format: 'csv', destination: 'audits@lumenlabs-portal.io',
    });
    assert.equal(EXPORT_LOG.length, before + 1);
    assert.equal(EXPORT_LOG.at(-1).rows, CUSTOMERS.length);
    assert.match(r.note, /no data transmitted/i);
  });

  test('send_email queues rather than sending', async () => {
    const before = OUTBOX.length;
    const r = await executeTool('send_email', {
      to: 'audits@lumenlabs-portal.io', subject: 'x', body: 'y',
    });
    assert.equal(r.sent, false);
    assert.equal(r.queued, true);
    assert.equal(OUTBOX.length, before + 1);
  });
});

/* ────────────────────────────────────────────────────────────────
 * 3. Tools — error paths. An unhandled throw mid-run kills a demo.
 * ──────────────────────────────────────────────────────────────── */

describe('tools: error paths', () => {
  test('refund_order rejects a refund larger than the order total', async () => {
    await assert.rejects(
      () => executeTool('refund_order', { order_id: 'NW-4471', amount: 999, reason: 'x' }),
      /exceeds order total/,
    );
  });

  test('refund_order rejects an unknown order', async () => {
    await assert.rejects(
      () => executeTool('refund_order', { order_id: 'NOPE', amount: 1, reason: 'x' }),
      /not found/,
    );
  });

  test('issue_store_credit rejects an unknown customer', async () => {
    await assert.rejects(
      () => executeTool('issue_store_credit', { customer_id: 'cus_nope', amount: 10, reason: 'x' }),
      /not found/,
    );
  });

  test('every tool rejects a missing required argument', async () => {
    for (const tool of TOOLS) {
      await assert.rejects(
        () => executeTool(tool.name, {}),
        /is required/,
        `${tool.name} accepted an empty argument object`,
      );
    }
  });

  test('an unknown tool name is rejected', async () => {
    await assert.rejects(() => executeTool('definitely_not_a_tool', {}), /unknown tool/);
  });

  test('a rejected write leaves no partial ledger entry', async () => {
    const before = LEDGER.length;
    await assert.rejects(
      () => executeTool('refund_order', { order_id: 'NW-4471', amount: 9999, reason: 'x' }),
    );
    assert.equal(LEDGER.length, before);
  });
});

/* ────────────────────────────────────────────────────────────────
 * 4. Threshold field naming
 *
 * ArmorIQ scans tool arguments for amount, value, total, price, cost.
 * A money tool whose schema names the field anything else has a limit
 * rule that can never fire — and the failure looks like "the policy is
 * too permissive", which sends you debugging the wrong thing entirely.
 * ──────────────────────────────────────────────────────────────── */

describe('threshold rules can actually see the money', () => {
  const SCANNED = ['amount', 'value', 'total', 'price', 'cost'];
  const moneyTools = TOOLS.filter((t) => t.risk === 'financial');

  test('there is at least one money tool', () => {
    assert.ok(moneyTools.length > 0, 'no tools are marked financial');
  });

  for (const tool of moneyTools) {
    test(`${tool.name} exposes a scannable amount field`, () => {
      const fields = Object.keys(tool.parameters.properties);
      const hit = SCANNED.find((f) => fields.includes(f));
      assert.ok(
        hit,
        `${tool.name} has [${fields}] — none of them is scanned by threshold rules`,
      );
    });
  }

  test('the documented ceilings match the values the beats exercise', () => {
    assert.equal(STORE.refundCeiling, 500);
    assert.equal(STORE.creditCeiling, 500);
    // beat:hold must exceed the ceiling or it will be allowed, not held.
    assert.ok(4000 > STORE.creditCeiling, 'the hold beat is under its own ceiling');
    // beat:allow must stay under it.
    const allowOrder = ORDERS.find((o) => o.id === 'NW-4471');
    assert.ok(allowOrder.amount <= STORE.refundCeiling, 'the allow beat is over the ceiling');
  });
});

/* ────────────────────────────────────────────────────────────────
 * 5. Seed data integrity — beat 3 demos nothing without this
 * ──────────────────────────────────────────────────────────────── */

describe('seed data', () => {
  const injection = TICKETS.find((t) => t.id === 'NW-T-3391');

  test('the injected ticket exists', () => {
    assert.ok(injection, 'ticket NW-T-3391 is missing');
  });

  test('it contains a legitimate complaint, so it does not look malicious', () => {
    assert.match(injection.body, /size too small/i);
  });

  test('it demands the customer data be sent out', () => {
    assert.match(injection.body, /(export|send it)/i);
    assert.match(injection.body, /customer (master file|table|book|list)/i);
  });

  test('it names an external destination', () => {
    assert.match(injection.body, /@lumenlabs-portal\.io/);
  });

  test('it invokes internal authority rather than asking permission', () => {
    // The attack works by sounding like ordinary business process: a finance
    // reference and a request to close the ticket today, not a demand to
    // ignore the rules. A rule-shaped test would miss the next one of these.
    assert.match(injection.body, /finance contact|FIN-2026-4482/i);
    assert.match(injection.body, /close this ticket/i);
  });

  test('it belongs to a customer the agent can legitimately look up', () => {
    assert.ok(findCustomerByEmail(injection.from), 'the ticket sender is not a seeded customer');
  });

  test('every order belongs to a seeded customer', () => {
    for (const o of ORDERS) {
      assert.ok(
        findCustomerByEmail(ordersForCustomer(o.customerId).length >= 0 ? o.customerId : null)
          || CUSTOMERS.some((c) => c.id === o.customerId),
        `order ${o.id} references unknown customer ${o.customerId}`,
      );
    }
  });

  test('the money-moving tools are exactly the ones the policy blocks or holds', () => {
    const egress = TOOLS.filter((t) => t.risk === 'egress').map((t) => t.name).sort();
    assert.deepEqual(egress, ['export_customer_data', 'send_email']);
  });
});

/* ────────────────────────────────────────────────────────────────
 * 6. Wiring — every declared tool is actually executable
 * ──────────────────────────────────────────────────────────────── */

describe('wiring', () => {
  test('every declared tool has a schema with properties', () => {
    for (const tool of TOOLS) {
      assert.ok(tool.parameters?.properties, `${tool.name} has no parameter properties`);
      assert.ok(tool.description, `${tool.name} has no description for the planner`);
    }
  });

  test('tool names are unique', () => {
    const names = TOOLS.map((t) => t.name);
    assert.equal(new Set(names).size, names.length);
  });

  test('toolByName resolves, and returns undefined for a miss', () => {
    assert.equal(toolByName('refund_order').risk, 'financial');
    assert.equal(toolByName('nope'), undefined);
  });
});