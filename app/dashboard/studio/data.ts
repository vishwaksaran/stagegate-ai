// AG Studio's data sources for the dashboard: a table for each row type in lib/dashboard-data.ts,
// the relationships between them, a shared calendar and a few calculated measures.

import type {
  AgDataSourcesDefinition,
  AgExpressionFieldDefinition,
  AgFieldDefinition,
  AgFormat,
  AgRelationDefinition,
} from 'ag-studio';
import type { DashboardData } from '@/lib/dashboard-data';

// --- Helpers ----------------------------------------------------------------------

const CALENDAR_ID = 'calendar';

// [id, name, format, hide?]
type FieldSpec = [id: string, name: string, format: AgFormat, hide?: boolean];

const fields = (specs: FieldSpec[]): AgFieldDefinition[] =>
  specs.map(([id, name, format, hide]) => ({ id, name, format, ...(hide && { hide }) }));

// Foreign key 'table.field' -> primary key 'table.field'.
const manyToOne = (id: string, source: string, target: string): AgRelationDefinition => {
  const [sourceTable, sourceField] = source.split('.');
  const [targetTable, targetField] = target.split('.');
  return {
    id,
    source: { tableId: sourceTable, fieldId: sourceField },
    target: { tableId: targetTable, fieldId: targetField },
    type: 'many-to-one',
  };
};

const onCalendar = (tableId: string, fieldId: string, truncate?: 'day'): AgRelationDefinition => ({
  id: `${tableId}-${fieldId}-calendar`,
  source: { tableId, fieldId },
  target: { calendarId: CALENDAR_ID },
  ...(truncate && { truncate }),
});

const sumOf = (id: string) => ({ id, aggregation: 'sum' as const });

const ratio = (id: string, name: string, description: string, numerator: string, denominator: string): AgExpressionFieldDefinition => ({
  id,
  name,
  description,
  format: 'percentageFormat',
  isMeasure: true,
  expression: { operator: 'divide', inputs: [sumOf(numerator), sumOf(denominator)] },
});

// --- Data sources -----------------------------------------------------------------


// Whether the PayPal account has anything to report on. Without it, Studio would only show empty widgets.
export const hasData = (data: DashboardData) =>
  [data.invoices, data.transactions, data.products, data.plans, data.balances, data.stagegatePhases].some((rows) => rows.length > 0);

export function buildStudioData(data: DashboardData): AgDataSourcesDefinition {
  const dates = [
    ...data.invoices.map((r) => r.invoiceDate),
    ...data.invoicePayments.map((r) => r.date),
    ...data.transactions.map((r) => r.date?.slice(0, 10)),
    ...data.stagegateAudit.map((r) => r.at.slice(0, 10)),
  ]
    .filter((d): d is string => !!d)
    .sort();
  const today = data.asOf.slice(0, 10);

  return {
    description:
      'PayPal sandbox data fetched over the REST API for a merchant that sells subscription products and sends invoices. ' +
      'Invoices are in USD, EUR or GBP and are not converted, so filter by currency before summing money. ' +
      'Invoice payments are recorded externally (bank transfer, card, check, cash). The ledger holds payouts to affiliates, creators and customers. ' +
      'The StageGate tables describe StageGate AI, a cashflow safety lock: a client project split into 2 phases, each funded by a PayPal invoice. ' +
      'An AI agent may buy a phase\'s equipment (sourced from Channel3) only after PayPal confirms that phase\'s invoice is paid, and never more than it brought in. ' +
      'Every approved, blocked or failed attempt is in the StageGate audit trail.',
    sources: [
      {
        id: 'customers',
        description: 'Invoice recipients, keyed by lower-cased email.',
        data: data.customers,
        fields: fields([
          ['id', 'Customer ID', 'textFormat', true],
          ['name', 'Customer', 'textFormat'],
          ['company', 'Company', 'textFormat'],
          ['email', 'Email', 'textFormat'],
        ]),
      },
      {
        id: 'invoices',
        description:
          'One row per invoice. Issued amount excludes drafts, scheduled and cancelled invoices. Outstanding and aging apply only to open or partially paid invoices.',
        data: data.invoices,
        fields: fields([
          ['id', 'Invoice ID', 'textFormat', true],
          ['number', 'Invoice', 'textFormat'],
          ['customerId', 'Customer ID', 'textFormat', true],
          ['status', 'Invoice Status', 'textFormat'],
          ['statusGroup', 'Status Group', 'textFormat'],
          ['currency', 'Currency', 'textFormat'],
          ['paymentTerm', 'Payment Term', 'textFormat'],
          ['invoiceDate', 'Invoice Date', 'dateFormat'],
          ['dueDate', 'Due Date', 'dateFormat'],
          ['total', 'Invoice Total', 'currencyFormat'],
          ['issuedAmount', 'Invoiced', 'currencyFormat'],
          ['paidAmount', 'Paid', 'currencyFormat'],
          ['refundedAmount', 'Refunded', 'currencyFormat'],
          ['netCollected', 'Net Collected', 'currencyFormat'],
          ['isReceivable', 'Is Receivable', 'booleanFormat'],
          ['outstanding', 'Outstanding', 'currencyFormat'],
          ['overdueAmount', 'Overdue', 'currencyFormat'],
          ['daysOverdue', 'Days Overdue', 'integerFormat'],
          ['agingBucket', 'Aging Bucket', 'textFormat'],
          ['daysToPay', 'Days to Pay', 'integerFormat'],
          ['taxTotal', 'Tax', 'currencyFormat'],
        ]),
      },
      {
        id: 'invoiceItems',
        name: 'Invoice Line Items',
        description: 'Invoice lines. Line total is after line discount and tax, before invoice-level discount and shipping.',
        data: data.invoiceItems,
        fields: fields([
          ['id', 'Line ID', 'textFormat', true],
          ['invoiceId', 'Invoice ID', 'textFormat', true],
          ['name', 'Item', 'textFormat'],
          ['unit', 'Unit', 'textFormat'],
          ['quantity', 'Quantity', 'decimalFormat'],
          ['unitPrice', 'Unit Price', 'currencyFormat'],
          ['gross', 'Gross', 'currencyFormat'],
          ['discount', 'Line Discount', 'currencyFormat'],
          ['tax', 'Line Tax', 'currencyFormat'],
          ['lineTotal', 'Line Total', 'currencyFormat'],
        ]),
      },
      {
        id: 'invoicePayments',
        name: 'Invoice Payments',
        description: 'Payments and refunds recorded against invoices. Signed amount is negative for refunds; sum it for net cash.',
        data: data.invoicePayments,
        fields: fields([
          ['id', 'Payment ID', 'textFormat', true],
          ['invoiceId', 'Invoice ID', 'textFormat', true],
          ['kind', 'Payment Kind', 'textFormat'],
          ['method', 'Payment Method', 'textFormat'],
          ['date', 'Payment Date', 'dateFormat'],
          ['amount', 'Payment Amount', 'currencyFormat'],
          ['signedAmount', 'Net Cash', 'currencyFormat'],
        ]),
      },
      {
        id: 'products',
        description: 'Catalog products sold as subscriptions.',
        data: data.products,
        fields: fields([
          ['id', 'Product ID', 'textFormat', true],
          ['name', 'Product', 'textFormat'],
          ['type', 'Product Type', 'textFormat'],
          ['category', 'Product Category', 'textFormat'],
          ['description', 'Product Description', 'textFormat'],
        ]),
      },
      {
        id: 'plans',
        name: 'Billing Plans',
        description: 'Subscription billing plans, in USD. Monthly price normalises weekly, quarterly and annual pricing to one month.',
        data: data.plans,
        fields: fields([
          ['id', 'Plan ID', 'textFormat', true],
          ['productId', 'Product ID', 'textFormat', true],
          ['name', 'Plan', 'textFormat'],
          ['status', 'Plan Status', 'textFormat'],
          ['billingInterval', 'Billed', 'textFormat'],
          ['price', 'Price', 'currencyFormat'],
          ['monthlyPrice', 'Monthly Price', 'currencyFormat'],
          ['trialDays', 'Trial Days', 'integerFormat'],
          ['setupFee', 'Setup Fee', 'currencyFormat'],
        ]),
      },
      {
        id: 'transactions',
        description: 'Account ledger from Transaction Search, last 31 days. Amounts are signed (debits negative); net is amount plus fee.',
        data: data.transactions,
        fields: fields([
          ['id', 'Transaction ID', 'textFormat'],
          ['date', 'Transaction Date', 'dateTimeFormat'],
          ['eventType', 'Event Type', 'textFormat'],
          ['status', 'Transaction Status', 'textFormat'],
          ['direction', 'Direction', 'textFormat'],
          ['currency', 'Transaction Currency', 'textFormat', true],
          ['amount', 'Transaction Amount', 'currencyFormat'],
          ['fee', 'Transaction Fee', 'currencyFormat'],
          ['net', 'Transaction Net', 'currencyFormat'],
          ['endingBalance', 'Ending Balance', 'currencyFormat'],
          ['counterparty', 'Counterparty', 'textFormat'],
          ['note', 'Transaction Note', 'textFormat'],
        ]),
      },
      {
        id: 'payouts',
        description: 'Individual payouts sent from the account, as positive USD amounts, grouped into campaigns.',
        data: data.payouts,
        fields: fields([
          ['id', 'Payout ID', 'textFormat', true],
          ['campaign', 'Campaign', 'textFormat'],
          ['recipient', 'Recipient', 'textFormat'],
          ['date', 'Payout Date', 'dateTimeFormat'],
          ['status', 'Payout Status', 'textFormat'],
          ['amount', 'Payout Amount', 'currencyFormat'],
          ['fee', 'Payout Fee', 'currencyFormat'],
          ['note', 'Payout Note', 'textFormat'],
        ]),
      },
      {
        id: 'balances',
        description: 'Current account balance per currency.',
        data: data.balances,
        fields: fields([
          ['currency', 'Balance Currency', 'textFormat'],
          ['total', 'Total Balance', 'currencyFormat'],
          ['available', 'Available Balance', 'currencyFormat'],
          ['withheld', 'Withheld Balance', 'currencyFormat'],
        ]),
      },
      {
        id: 'stagegatePhases',
        name: 'StageGate Phases',
        description:
          'StageGate Cashflow Safety Lock: one row per project phase, in USD. Locked means the phase\'s client invoice is not paid, so no supplier spend is allowed. ' +
          'Collected is the invoice amount once paid; Spent is what was ordered from suppliers; Held by Lock is the cart total the lock is holding back. ' +
          'Delay Days is how far a late client payment pushed the phase.',
        data: data.stagegatePhases,
        fields: fields([
          ['id', 'Phase ID', 'textFormat', true],
          ['project', 'StageGate Project', 'textFormat'],
          ['phaseNumber', 'Phase Number', 'integerFormat'],
          ['name', 'Phase', 'textFormat'],
          ['startDate', 'Phase Start', 'dateFormat'],
          ['endDate', 'Phase End', 'dateFormat'],
          ['originalEndDate', 'Originally Planned End', 'dateFormat'],
          ['delayDays', 'Delay Days', 'integerFormat'],
          ['lockState', 'Lock State', 'textFormat'],
          ['invoiceStatus', 'Phase Invoice Status', 'textFormat'],
          ['invoiceNumber', 'Phase Invoice', 'textFormat'],
          ['invoiceAmount', 'Phase Invoice Amount', 'currencyFormat'],
          ['invoiced', 'Phase Invoiced', 'currencyFormat'],
          ['collected', 'Phase Collected', 'currencyFormat'],
          ['equipmentBudget', 'Equipment Budget', 'currencyFormat'],
          ['cartTotal', 'Cart Total', 'currencyFormat'],
          ['spent', 'Spent on Suppliers', 'currencyFormat'],
          ['heldByLock', 'Held by Lock', 'currencyFormat'],
          ['supplierOrderId', 'Supplier PayPal Order', 'textFormat'],
          ['productSource', 'Product Source', 'textFormat'],
          ['blockedAttempts', 'Blocked Attempts', 'integerFormat'],
        ]),
      },
      {
        id: 'stagegateAudit',
        name: 'StageGate Audit Trail',
        description:
          'Every StageGate action, newest first: invoice creation and sending, payment verification, supplier purchase attempts, late payments and resets. ' +
          'Outcome is Approved, Blocked (the safety lock stopped it, no money moved), Info or Error. Sum Is Blocked / Is Approved to count them. ' +
          'Each row carries a SHA-256 hash chained to the previous row.',
        data: data.stagegateAudit,
        fields: fields([
          ['id', 'Audit ID', 'textFormat', true],
          ['seq', 'Audit #', 'integerFormat'],
          ['at', 'Audit Time', 'dateTimeFormat'],
          ['phaseId', 'Phase ID', 'textFormat', true],
          ['action', 'Audit Action', 'textFormat'],
          ['outcome', 'Audit Outcome', 'textFormat'],
          ['message', 'What Happened', 'textFormat'],
          ['amount', 'Audit Amount', 'currencyFormat'],
          ['paypalCall', 'PayPal Call', 'textFormat'],
          ['httpStatus', 'PayPal HTTP Status', 'integerFormat'],
          ['isBlocked', 'Is Blocked', 'integerFormat'],
          ['isApproved', 'Is Approved', 'integerFormat'],
          ['sha256', 'SHA-256', 'textFormat'],
        ]),
      },
      {
        id: 'stagegateProducts',
        name: 'StageGate Sourced Products',
        description: 'Equipment found on Channel3 for each StageGate phase, in USD. In Cart marks what the agent would buy once the phase is funded.',
        data: data.stagegateProducts,
        fields: fields([
          ['id', 'Sourced Product ID', 'textFormat', true],
          ['phaseId', 'Phase ID', 'textFormat', true],
          ['title', 'Sourced Product', 'textFormat'],
          ['brand', 'Brand', 'textFormat'],
          ['searchQuery', 'Search Query', 'textFormat'],
          ['price', 'Product Price', 'currencyFormat'],
          ['inCart', 'In Cart', 'booleanFormat'],
          ['url', 'Product Link', 'textFormat'],
        ]),
      },
    ],
    relationships: [
      manyToOne('invoice-customer', 'invoices.customerId', 'customers.id'),
      manyToOne('item-invoice', 'invoiceItems.invoiceId', 'invoices.id'),
      manyToOne('payment-invoice', 'invoicePayments.invoiceId', 'invoices.id'),
      manyToOne('plan-product', 'plans.productId', 'products.id'),
      onCalendar('invoices', 'invoiceDate'),
      onCalendar('invoicePayments', 'date'),
      onCalendar('transactions', 'date', 'day'),
      onCalendar('payouts', 'date', 'day'),
      manyToOne('stagegate-audit-phase', 'stagegateAudit.phaseId', 'stagegatePhases.id'),
      manyToOne('stagegate-product-phase', 'stagegateProducts.phaseId', 'stagegatePhases.id'),
      onCalendar('stagegateAudit', 'at', 'day'),
    ],
    calendars: [
      {
        id: CALENDAR_ID,
        label: 'Calendar',
        range: {
          from: { type: 'date', value: dates[0] ?? today },
          to: { type: 'date', value: dates.at(-1) ?? today },
        },
        fragments: ['year', 'quarter', 'month', 'week', 'day', 'dayOfWeek'],
      },
    ],
    expressions: [
      ratio('collectionRate', 'Collection Rate', 'Paid / invoiced. Filter to one currency first.', 'invoices.paidAmount', 'invoices.issuedAmount'),
      ratio('overdueShare', 'Overdue Share', 'Share of outstanding receivables that is past due.', 'invoices.overdueAmount', 'invoices.outstanding'),
      ratio('refundRate', 'Refund Rate', 'Refunded / paid.', 'invoices.refundedAmount', 'invoices.paidAmount'),
    ],
  };
}
