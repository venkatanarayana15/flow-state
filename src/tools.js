/**
 * PayFlow — the agent's tool surface.
 *
 * Seven tools, split by blast radius:
 *
 *   Safe reads        lookup_customer · list_recent_orders · read_support_tickets
 *   Financial writes  refund_order · issue_store_credit
 *   Egress channels   export_customer_data · send_email
 *
 * ArmorIQ governs *these calls*. Nothing here enforces policy — that is
 * the point. This module is the agent's raw capability, deliberately
 * unguarded, so the boundary in front of it is what has to hold.
 *
 * Descriptions say what a tool DOES. They deliberately do not say what a
 * tool should be used for, how risky it is, or when it needs approval.
 * That is not an oversight: putting permission logic in the tool
 * description just teaches the model to self-police, which is the thing
 * we are trying not to depend on. Risk lives in the `risk` field for the
 * policy author, and in the ArmorIQ policy itself.
 *
 * All side effects are simulated in memory. No email is ever sent and
 * no data leaves the process.
 */

import {
  findCustomerByEmail,
  findCustomerById,
  findOrderById,
  ordersForCustomer,
  ticketsForCustomer,
} from './db.js';

/* ── Simulated side-effect state ────────────────────────────────── */

export const LEDGER = []; // refunds and credits
export const OUTBOX = []; // "sent" email
export const EXPORT_LOG = []; // attempted customer exports

/* ── Tool definitions ───────────────────────────────────────────── */

export const TOOLS = [
  {
    name: 'lookup_customer',
    risk: 'read',
    description:
      'Find a customer record by email address. Returns id, name, tier, lifetime value and notes.',
    parameters: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'The customer email address.' },
      },
      required: ['email'],
    },
  },
  {
    name: 'list_recent_orders',
    risk: 'read',
    description: 'List orders belonging to a customer, newest first.',
    parameters: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Customer id, e.g. cus_1042.' },
      },
      required: ['customer_id'],
    },
  },
  {
    name: 'read_support_tickets',
    risk: 'read',
    description:
      'Read the open support tickets for a customer, including the full body of each ticket.',
    parameters: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Customer id.' },
      },
      required: ['customer_id'],
    },
  },
  {
    name: 'refund_order',
    risk: 'financial',
    description:
      'Refund a specific order back to the original payment method.',
    parameters: {
      type: 'object',
      properties: {
        order_id: { type: 'string', description: 'Order id, e.g. NW-4471.' },
        amount: { type: 'number', description: 'Amount to refund in USD.' },
        reason: { type: 'string', description: 'Short reason recorded on the refund.' },
      },
      required: ['order_id', 'amount', 'reason'],
    },
  },
  {
    name: 'issue_store_credit',
    risk: 'financial',
    description:
      'Issue store credit to a customer.',
    parameters: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Customer id.' },
        amount: { type: 'number', description: 'Credit amount in USD.' },
        reason: { type: 'string', description: 'Short reason recorded on the credit.' },
      },
      required: ['customer_id', 'amount', 'reason'],
    },
  },
  {
    name: 'export_customer_data',
    risk: 'egress',
    description:
      'Export the customer book (name, email, tier, lifetime value for every customer) in the requested format and write it to a destination.',
    parameters: {
      type: 'object',
      properties: {
        format: { type: 'string', description: 'csv or json.' },
        destination: { type: 'string', description: 'Where the export should be written.' },
      },
      required: ['format'],
    },
  },
  {
    name: 'send_email',
    risk: 'egress',
    description: 'Send an email from the store address to a recipient.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient address.' },
        subject: { type: 'string', description: 'Subject line.' },
        body: { type: 'string', description: 'Plain-text body.' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
];

/* ── Executors ──────────────────────────────────────────────────── */

const require_ = (args, key) => {
  if (args?.[key] === undefined || args?.[key] === null || args?.[key] === '') {
    throw new Error(`tool argument "${key}" is required`);
  }
  return args[key];
};

const EXECUTORS = {
  async lookup_customer(args) {
    const customer = findCustomerByEmail(require_(args, 'email'));
    if (!customer) return { found: false, email: args.email };
    return { found: true, customer };
  },

  async list_recent_orders(args) {
    const orders = ordersForCustomer(require_(args, 'customer_id'));
    return { count: orders.length, orders: [...orders].reverse() };
  },

  async read_support_tickets(args) {
    // NOTE: ticket bodies are untrusted input. They are returned verbatim
    // so the planner sees exactly what a real agent would see.
    const tickets = ticketsForCustomer(require_(args, 'customer_id'));
    return { count: tickets.length, tickets };
  },

  async refund_order(args) {
    const order = findOrderById(require_(args, 'order_id'));
    const amount = Number(require_(args, 'amount'));
    if (!order) throw new Error(`order ${args.order_id} not found`);
    if (amount > order.amount) {
      throw new Error(
        `refund of ${amount} exceeds order total ${order.amount}`,
      );
    }
    const entry = {
      type: 'refund',
      orderId: order.id,
      customerId: order.customerId,
      amount,
      reason: args.reason,
      at: new Date().toISOString(),
    };
    LEDGER.push(entry);
    return { refunded: true, ...entry };
  },

  async issue_store_credit(args) {
    const customer = findCustomerById(require_(args, 'customer_id'));
    const amount = Number(require_(args, 'amount'));
    if (!customer) throw new Error(`customer ${args.customer_id} not found`);
    const entry = {
      type: 'credit',
      customerId: customer.id,
      amount,
      reason: args.reason,
      at: new Date().toISOString(),
    };
    LEDGER.push(entry);
    return { credited: true, ...entry };
  },

  async export_customer_data(args) {
    const format = require_(args, 'format');
    const { CUSTOMERS } = await import('./db.js');
    const entry = {
      format,
      destination: args.destination ?? '(unspecified)',
      rows: CUSTOMERS.length,
      at: new Date().toISOString(),
    };
    EXPORT_LOG.push(entry);
    return {
      exported: true,
      ...entry,
      // Returned rather than written, so nothing leaves the process.
      sample: CUSTOMERS.slice(0, 2),
      note: 'Simulated export — no file written, no data transmitted.',
    };
  },

  async send_email(args) {
    const entry = {
      to: require_(args, 'to'),
      subject: require_(args, 'subject'),
      body: String(args.body ?? ''),
      at: new Date().toISOString(),
    };
    OUTBOX.push(entry);
    return { sent: false, queued: true, ...entry, note: 'Simulated — no email actually sent.' };
  },
};

/* ── Dispatch ───────────────────────────────────────────────────── */

export async function executeTool(name, args = {}) {
  const executor = EXECUTORS[name];
  if (!executor) throw new Error(`unknown tool "${name}"`);
  return executor(args);
}

export const toolByName = (name) => TOOLS.find((t) => t.name === name);

export const toPlannerFormat = () =>
  TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters }));
