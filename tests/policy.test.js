import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateLocal, LOCAL_CEILING, READ_TOOLS, MONEY_TOOLS, EGRESS_TOOLS } from '../src/policy.js';
import { isNoPolicyRefusal } from '../src/agent.js';

test('the local boundary', async (t) => {
  await t.test('allows every read tool', () => {
    for (const tool of READ_TOOLS) {
      const d = evaluateLocal(tool, { customer_id: 'cus_1' });
      assert.equal(d.status, 'allow', tool);
      assert.equal(d.source, 'local');
      assert.match(d.matchedPolicy, /reads-allowed/);
    }
  });

  await t.test('allows money at or under the ceiling', () => {
    for (const tool of MONEY_TOOLS) {
      const d = evaluateLocal(tool, { amount: LOCAL_CEILING });
      assert.equal(d.status, 'allow', tool);
      assert.match(d.matchedPolicy, /money-under-limit/);
    }
  });

  await t.test('holds money over the ceiling instead of running it', () => {
    for (const tool of MONEY_TOOLS) {
      const d = evaluateLocal(tool, { amount: LOCAL_CEILING + 1 });
      assert.equal(d.status, 'hold', tool);
      assert.match(d.matchedPolicy, /money-over-limit/);
      assert.match(d.reason, /over/);
    }
  });

  await t.test('a $4,000 credit is held, not allowed', () => {
    const d = evaluateLocal('issue_store_credit', { customer_id: 'cus_4415', amount: 4000 });
    assert.equal(d.status, 'hold');
  });

  await t.test('a missing amount fails closed', () => {
    for (const tool of MONEY_TOOLS) {
      const d = evaluateLocal(tool, {});
      assert.equal(d.status, 'hold');
      assert.match(d.reason, /held/);
    }
  });

  await t.test('a non-positive amount is refused', () => {
    for (const amount of [0, -50]) {
      const d = evaluateLocal('refund_order', { amount });
      assert.equal(d.status, 'deny', String(amount));
    }
  });

  await t.test('blocks both egress tools', () => {
    assert.equal(evaluateLocal('export_customer_data', { format: 'csv' }).status, 'deny');
    assert.equal(evaluateLocal('send_email', { to: 'x@y.z' }).status, 'deny');
    for (const tool of EGRESS_TOOLS) {
      assert.match(evaluateLocal(tool, {}).matchedPolicy, /destructive-denied/);
    }
  });

  await t.test('refuses a tool no rule covers', () => {
    const d = evaluateLocal('wire_transfer', { amount: 10 });
    assert.equal(d.status, 'deny');
    assert.equal(d.matchedPolicy, null);
    assert.match(d.reason, /failing closed/);
  });

  await t.test('never returns a verdict without a reason', () => {
    for (const tool of [...READ_TOOLS, ...MONEY_TOOLS, ...EGRESS_TOOLS, 'nope']) {
      const d = evaluateLocal(tool, { amount: 10 });
      assert.ok(typeof d.reason === 'string' && d.reason.length > 0, tool);
      assert.ok(['allow', 'hold', 'deny'].includes(d.status), tool);
    }
  });
});

test('recognising an armoriq account with no rules', async (t) => {
  await t.test('treats both "no policy" refusals as fallback-able', () => {
    assert.equal(isNoPolicyRefusal('agent_unresolved'), true);
    assert.equal(isNoPolicyRefusal('no_active_policy'), true);
    assert.equal(isNoPolicyRefusal('No matching policy for this call'), true);
    assert.equal(isNoPolicyRefusal('agent not registered'), true);
  });

  await t.test('never second-guesses a real denial', () => {
    assert.equal(isNoPolicyRefusal('blocked by policy destructive-denied'), false);
    assert.equal(isNoPolicyRefusal('tool-not-in-plan: export_customer_data'), false);
    assert.equal(isNoPolicyRefusal('exceeds the delegated scope'), false);
    assert.equal(isNoPolicyRefusal(undefined), false);
    assert.equal(isNoPolicyRefusal(''), false);
  });
});
