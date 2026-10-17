/**
 * PayFlow — the local boundary.
 *
 * This is the same four-rule set that submission/POLICY-STUDIO.md creates in
 * ArmorIQ's Policy Studio, evaluated in the server process. It exists because
 * an ArmorIQ workspace with no policy set attached refuses *every* call with
 * `no_active_policy`: correct fail-closed behaviour, but it makes the demo
 * unusable and shows nothing about the agent.
 *
 * The fallback is never silent:
 *
 *   · every step carries `source: 'armoriq' | 'local'`
 *   · the CLI prints `(local policy)` next to the verdict
 *   · the UI shows a "local policy" chip and a banner explaining why
 *
 * When the four rules exist in Policy Studio, `check()` returns a real
 * decision and this module is never consulted.
 *
 * Rules, mirrored from the console:
 *
 *   reads-allowed         allow   lookup_customer, list_recent_orders,
 *                                 read_support_tickets
 *   money-under-limit     allow   refund_order, issue_store_credit (<= 500)
 *   money-over-limit      hold    refund_order, issue_store_credit (> 500)
 *   destructive-denied    deny    export_customer_data, send_email
 *
 * Anything not covered is denied. A decision this module cannot read is never
 * treated as permission.
 */

export const LOCAL_CEILING = 500;

export const READ_TOOLS = ['lookup_customer', 'list_recent_orders', 'read_support_tickets'];
export const MONEY_TOOLS = ['refund_order', 'issue_store_credit'];
export const EGRESS_TOOLS = ['export_customer_data', 'send_email'];

export const LOCAL_RULES = [
  {
    name: 'reads-allowed',
    effect: 'allow',
    tools: READ_TOOLS,
    summary: 'Customer lookups, order history and ticket reads are routine.',
  },
  {
    name: 'money-under-limit',
    effect: 'allow',
    tools: MONEY_TOOLS,
    summary: `Refunds and store credit at or below $${LOCAL_CEILING}.`,
  },
  {
    name: 'money-over-limit',
    effect: 'hold',
    tools: MONEY_TOOLS,
    summary: `Refunds and store credit above $${LOCAL_CEILING} wait for a human.`,
  },
  {
    name: 'destructive-denied',
    effect: 'deny',
    tools: EGRESS_TOOLS,
    summary: 'Bulk customer export and outbound email are refused outright.',
  },
];

const allow = (reason, rule) => ({ status: 'allow', reason, matchedPolicy: rule, source: 'local' });
const hold = (reason, rule) => ({ status: 'hold', reason, matchedPolicy: rule, source: 'local' });
const deny = (reason, rule) => ({ status: 'deny', reason, matchedPolicy: rule, source: 'local' });

/**
 * @param {string} tool
 * @param {object} args
 * @returns {{status:'allow'|'hold'|'deny', reason:string, matchedPolicy:string|null, source:'local'}}
 */
export function evaluateLocal(tool, args = {}) {
  const name = String(tool ?? '');

  if (READ_TOOLS.includes(name)) {
    return allow('reads are allowed by the local rule reads-allowed', 'local/reads-allowed');
  }

  if (MONEY_TOOLS.includes(name)) {
    const amount = Number(args?.amount);
    if (!Number.isFinite(amount)) {
      return hold('no readable amount — held for a human (local rule money-over-limit)', 'local/money-over-limit');
    }
    if (amount <= 0) {
      return deny(`amount ${amount} is not a refund — refused (local rules)`, 'local/money-under-limit');
    }
    if (amount <= LOCAL_CEILING) {
      return allow(`$${amount} is within the $${LOCAL_CEILING} local limit`, 'local/money-under-limit');
    }
    return hold(`$${amount} is over the $${LOCAL_CEILING} local limit — held for a human`, 'local/money-over-limit');
  }

  if (EGRESS_TOOLS.includes(name)) {
    return deny('bulk export and outbound email are refused by the local rule destructive-denied', 'local/destructive-denied');
  }

  return deny(`no local rule covers "${name}" — failing closed`, null);
}
