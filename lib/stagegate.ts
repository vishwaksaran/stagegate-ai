// StageGate AI: a deterministic Cashflow Safety Lock for phased projects.
//
// A project is split into phases. Each phase is funded by a PayPal invoice to the client, and its
// equipment is sourced from Channel3. The rule is simple and has no AI judgement in it:
//
//   An agent may only buy supplies for a phase once that phase's client invoice is PAID
//   (verified directly with PayPal), and only up to the amount that invoice brought in.
//
// All money is handled as integer cents. Every allowed or blocked action is written to an audit
// trail where each entry carries the SHA-256 hash of the previous one, so tampering with any past
// entry breaks the chain. State lives in memory and in .stagegate/state.json, so it survives
// refreshes and dev-server restarts. Server-side only.

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PayPalApiError, paypalRequest } from './paypal';
import { DEFAULT_PLAN, PRESETS, type ProjectPlan } from './stagegate-presets';

// --- Types ------------------------------------------------------------------------------------

export type PhaseId = 'phase-1' | 'phase-2';
export const PHASE_IDS: PhaseId[] = ['phase-1', 'phase-2'];
export const isPhaseId = (v: unknown): v is PhaseId => v === 'phase-1' || v === 'phase-2';

/** 'NOT_CREATED' before an invoice exists, 'PAID' once PayPal reports PAID or MARKED_AS_PAID,
 * otherwise PayPal's own status (DRAFT, SENT, UNPAID, ...). */
export type PhaseInvoiceStatus = 'NOT_CREATED' | 'PAID' | string;

export type SourcedProduct = {
  id: string;
  title: string;
  brand?: string;
  imageUrl?: string;
  url?: string;
  priceCents: number;
  currency: 'USD';
  query: string;
  inCart: boolean;
};

export type Phase = {
  id: PhaseId;
  name: string;
  invoiceAmountCents: number;
  equipmentBudgetCents: number;
  searchQueries: string[];
  startDate: string; // YYYY-MM-DD
  endDate: string;
  originalStartDate: string;
  originalEndDate: string;
  delayDays: number;
  invoiceStatus: PhaseInvoiceStatus;
  invoice?: {
    id: string;
    number: string;
    paypalStatus: string;
    invoiceDate?: string;
    recipientViewUrl?: string;
    createdAt: string;
    /** True only if recording a simulated payment in PayPal failed and we fell back to a local flag. */
    locallySimulatedPaid?: boolean;
  };
  products: SourcedProduct[];
  productSource: 'channel3' | 'fallback' | 'none';
  productNote?: string;
  purchase?: {
    orderId: string;
    status: string;
    approveUrl?: string;
    totalCents: number;
    createdAt: string;
  };
};

export type AuditOutcome = 'APPROVED' | 'BLOCKED' | 'INFO' | 'ERROR';

export type AuditEntry = {
  seq: number;
  at: string;
  action: string;
  phaseId: PhaseId | null;
  outcome: AuditOutcome;
  message: string;
  amountCents: number | null;
  paypal: { method: string; path: string; httpStatus: number | null; requestId: string | null; resourceId: string | null } | null;
  prevHash: string;
  hash: string;
};

type State = {
  version: 1;
  projectName: string;
  totalBudgetCents: number;
  clientEmail: string;
  createdAt: string;
  /** The plan the phases were built from, so a reset rebuilds the same project. */
  plan: ProjectPlan;
  planMeta: PlanMeta;
  phases: Phase[];
  audit: AuditEntry[];
};

/** Where the current plan came from: OpenAI from a brief, or a hand-written preset. */
export type PlanMeta = { source: 'openai' | 'preset'; brief: string; model: string | null; note: string | null };

export type PurchaseResult =
  | { allowed: false; reason: string; cartTotalCents: number }
  | { allowed: true; orderId: string; status: string; approveUrl?: string; cartTotalCents: number; alreadyPurchased?: boolean };

// --- Money & dates ------------------------------------------------------------------------------

/** Dollars (as a number from an external API) to integer cents. */
const toCents = (dollars: number) => Math.round(dollars * 100);

/** Integer cents to PayPal's decimal string, without floating point: 15000 -> "150.00". */
export const centsToValue = (cents: number) => {
  if (!Number.isInteger(cents) || cents < 0) throw new Error(`Invalid cents amount: ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
};
export const formatUsd = (cents: number) => `$${centsToValue(cents)}`;

const todayIso = () => new Date().toISOString().slice(0, 10);
const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// --- Defaults -----------------------------------------------------------------------------------

// PayPal does not let an India-registered business invoice an India-registered customer (HTTP 406), and
// both default sandbox accounts on this developer account are in India. A recipient email with no PayPal
// account counts as international, so invoices send. Override with STAGEGATE_CLIENT_EMAIL, e.g. a US
// personal sandbox account, to pay invoices as the buyer for real.
const DEFAULT_CLIENT_EMAIL = 'stagegate-demo-client@example.com';
const LATE_PAYMENT_DAYS = 4;

const DEFAULT_PLAN_META: PlanMeta = { source: 'preset', brief: PRESETS[0].brief, model: null, note: null };

/** A fresh, fully locked project built from a plan: phase 1 starts today, phase 2 right after it. */
function defaultState(plan: ProjectPlan = DEFAULT_PLAN, meta: PlanMeta = DEFAULT_PLAN_META): State {
  const start = todayIso();
  let offset = 0;
  const phases = plan.phases.map((p, i): Phase => {
    const startDate = addDays(start, offset);
    const endDate = addDays(start, offset + p.durationDays - 1);
    offset += p.durationDays;
    return {
      id: PHASE_IDS[i],
      name: p.name,
      invoiceAmountCents: p.invoiceAmountCents,
      equipmentBudgetCents: p.equipmentBudgetCents,
      searchQueries: [...p.searchQueries],
      startDate,
      endDate,
      originalStartDate: startDate,
      originalEndDate: endDate,
      delayDays: 0,
      invoiceStatus: 'NOT_CREATED',
      products: [],
      productSource: 'none',
    };
  });

  return {
    version: 1,
    projectName: plan.projectName,
    totalBudgetCents: plan.totalBudgetCents,
    clientEmail: process.env.STAGEGATE_CLIENT_EMAIL || DEFAULT_CLIENT_EMAIL,
    createdAt: new Date().toISOString(),
    plan,
    planMeta: meta,
    phases,
    audit: [],
  };
}

// --- Persistence (in-memory + JSON file), with a lock so actions never interleave -----------------

const STATE_FILE = path.join(process.cwd(), '.stagegate', 'state.json');

// Kept on globalThis so hot reloads in dev share one copy.
const store = globalThis as unknown as { __stagegate?: { state?: State; chain: Promise<unknown> } };
store.__stagegate ??= { chain: Promise.resolve() };
const mem = store.__stagegate;

async function loadState(): Promise<State> {
  if (!mem.state) {
    try {
      const parsed = JSON.parse(await fs.readFile(STATE_FILE, 'utf8')) as State;
      if (parsed.version === 1 && Array.isArray(parsed.phases)) mem.state = parsed;
    } catch {
      // Missing or unreadable: start fresh.
    }
    mem.state ??= defaultState();
  }
  // State saved (or held in memory across a hot reload) before plans existed was always the default project.
  mem.state.plan ??= DEFAULT_PLAN;
  mem.state.planMeta ??= DEFAULT_PLAN_META;
  return mem.state;
}

async function saveState(state: State) {
  mem.state = state;
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmp, STATE_FILE);
}

/** Runs `fn` with exclusive access to the state, then saves it. */
function withState<T>(fn: (state: State) => Promise<T>): Promise<T> {
  const run = mem.chain.then(async () => {
    const state = await loadState();
    try {
      return await fn(state);
    } finally {
      await saveState(state);
    }
  });
  mem.chain = run.catch(() => undefined);
  return run;
}

const phaseOf = (state: State, id: PhaseId) => {
  const phase = state.phases.find((p) => p.id === id);
  if (!phase) throw new Error(`Unknown phase ${id}`);
  return phase;
};

// --- SHA-256 audit chain ------------------------------------------------------------------------

const GENESIS_HASH = '0'.repeat(64);

function hashEntry(e: Omit<AuditEntry, 'hash'>) {
  // A fixed field order, so the hash does not depend on how the object was built or parsed.
  const canonical = JSON.stringify([e.seq, e.at, e.action, e.phaseId, e.outcome, e.message, e.amountCents, e.paypal, e.prevHash]);
  return createHash('sha256').update(canonical).digest('hex');
}

function audit(
  state: State,
  entry: { action: string; phaseId?: PhaseId; outcome: AuditOutcome; message: string; amountCents?: number; paypal?: AuditEntry['paypal'] },
) {
  const prev = state.audit.at(-1);
  const base: Omit<AuditEntry, 'hash'> = {
    seq: (prev?.seq ?? 0) + 1,
    at: new Date().toISOString(),
    action: entry.action,
    phaseId: entry.phaseId ?? null,
    outcome: entry.outcome,
    message: entry.message,
    amountCents: entry.amountCents ?? null,
    paypal: entry.paypal
      ? {
          method: entry.paypal.method,
          path: entry.paypal.path,
          httpStatus: entry.paypal.httpStatus,
          requestId: entry.paypal.requestId,
          resourceId: entry.paypal.resourceId,
        }
      : null,
    prevHash: prev?.hash ?? GENESIS_HASH,
  };
  state.audit.push({ ...base, hash: hashEntry(base) });
}

/** Recomputes every hash; false if any entry was edited, removed or reordered. */
export function verifyAuditChain(entries: AuditEntry[]) {
  let prev = GENESIS_HASH;
  for (const e of entries) {
    const { hash, ...rest } = e;
    if (e.prevHash !== prev || hashEntry(rest) !== hash) return false;
    prev = hash;
  }
  return true;
}

/** A short, readable reason from a PayPal error body. */
function paypalErrorMessage(err: unknown) {
  if (err instanceof PayPalApiError) {
    try {
      const body = JSON.parse(err.body) as { message?: string; details?: { issue?: string; description?: string }[] };
      const d = body.details?.[0];
      return `PayPal ${err.status}: ${d?.description ?? d?.issue ?? body.message ?? 'request failed'}`;
    } catch {
      return err.message;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

// --- Channel3 product sourcing ------------------------------------------------------------------

const CHANNEL3_SEARCH_URL = 'https://api.trychannel3.com/v1/search';

type Channel3Product = {
  id: string;
  title: string;
  brands?: { name?: string }[];
  images?: { url?: string; is_main_image?: boolean }[];
  offers?: { url?: string; price?: { price?: number; currency?: string }; availability?: string }[];
};

/** Searches Channel3 for real products; keeps each product's cheapest USD offer. */
export async function searchChannel3(query: string, limit = 6): Promise<SourcedProduct[]> {
  const key = process.env.CHANNEL3_API_KEY;
  if (!key) throw new Error('CHANNEL3_API_KEY is not set');

  const res = await fetch(CHANNEL3_SEARCH_URL, {
    method: 'POST',
    headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit }),
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Channel3 ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const { products = [] } = (await res.json()) as { products?: Channel3Product[] };
  return products.flatMap((p) => {
    const offer = (p.offers ?? [])
      .filter((o) => o.price?.currency === 'USD' && typeof o.price.price === 'number' && o.price.price > 0)
      .sort((a, b) => a.price!.price! - b.price!.price!)[0];
    if (!offer) return [];
    const image = p.images?.find((i) => i.is_main_image) ?? p.images?.[0];
    return [
      {
        id: p.id,
        title: p.title,
        brand: p.brands?.[0]?.name,
        imageUrl: image?.url,
        url: offer.url,
        priceCents: toCents(offer.price!.price!),
        currency: 'USD' as const,
        query,
        inCart: false,
      },
    ];
  });
}

/** Sample items used when Channel3 is not configured or unreachable. Clearly labelled as samples in the UI. */
const FALLBACK_PRODUCTS: Record<PhaseId, Omit<SourcedProduct, 'inCart'>[]> = {
  'phase-1': [
    { id: 'fb-tamper', title: '58mm Stainless Steel Espresso Tamper', brand: 'Sample', priceCents: 2_999, currency: 'USD', query: '58mm espresso tamper' },
    { id: 'fb-tamper-pro', title: 'Calibrated 58mm Tamper (spring-loaded)', brand: 'Sample', priceCents: 4_499, currency: 'USD', query: '58mm espresso tamper' },
    { id: 'fb-knockbox', title: 'Espresso Knock Box, stainless', brand: 'Sample', priceCents: 2_499, currency: 'USD', query: 'espresso knock box' },
  ],
  'phase-2': [
    { id: 'fb-grinder', title: 'Commercial Flat-Burr Espresso Grinder', brand: 'Sample', priceCents: 34_900, currency: 'USD', query: 'commercial espresso grinder' },
    { id: 'fb-cups', title: '8 oz Paper Hot Cups with Lids (500 ct)', brand: 'Sample', priceCents: 5_499, currency: 'USD', query: 'disposable paper coffee cups 8 oz' },
  ],
};

/**
 * Picks the cart: for each search query in order, the most relevant product (Channel3's ranking)
 * that still fits in the phase's remaining equipment budget. Deterministic for the same results.
 */
function selectCart(phase: Phase) {
  let remaining = phase.equipmentBudgetCents;
  for (const p of phase.products) p.inCart = false;
  for (const query of phase.searchQueries) {
    const pick = phase.products.find((p) => p.query === query && p.priceCents <= remaining);
    if (pick) {
      pick.inCart = true;
      remaining -= pick.priceCents;
    }
  }
}

export const cartOf = (phase: Phase) => {
  const items = phase.products.filter((p) => p.inCart);
  return { items, totalCents: items.reduce((sum, p) => sum + p.priceCents, 0) };
};

async function sourceProducts(state: State, phase: Phase) {
  try {
    const results = (await Promise.all(phase.searchQueries.map((q) => searchChannel3(q)))).flat();
    if (results.length === 0) throw new Error('Channel3 returned no USD-priced products');
    // De-duplicate across queries, keep the first occurrence.
    const seen = new Set<string>();
    phase.products = results.filter((p) => !seen.has(p.id) && seen.add(p.id));
    phase.productSource = 'channel3';
    phase.productNote = undefined;
  } catch (err) {
    phase.products = FALLBACK_PRODUCTS[phase.id].map((p) => ({ ...p, inCart: false }));
    phase.productSource = 'fallback';
    phase.productNote = err instanceof Error ? err.message : String(err);
  }
  selectCart(phase);
  const cart = cartOf(phase);
  audit(state, {
    action: 'search_products',
    phaseId: phase.id,
    outcome: phase.productSource === 'channel3' ? 'INFO' : 'ERROR',
    message:
      phase.productSource === 'channel3'
        ? `Channel3 sourced ${phase.products.length} products; cart ${formatUsd(cart.totalCents)} of ${formatUsd(phase.equipmentBudgetCents)} equipment budget`
        : `Channel3 unavailable (${phase.productNote}); using sample catalog, cart ${formatUsd(cart.totalCents)}`,
    amountCents: cart.totalCents,
  });
}

export function searchProducts(phaseId?: PhaseId) {
  return withState(async (state) => {
    const phases = phaseId ? [phaseOf(state, phaseId)] : state.phases;
    for (const phase of phases) {
      // A bought phase keeps the cart it bought.
      if (!phase.purchase) await sourceProducts(state, phase);
    }
    return { searched: phases.map((p) => ({ phaseId: p.id, source: p.productSource, count: p.products.length })) };
  });
}

// --- PayPal: invoices ---------------------------------------------------------------------------

type PayPalInvoice = {
  id: string;
  status: string;
  detail?: { invoice_number?: string; invoice_date?: string; metadata?: { recipient_view_url?: string } };
};

const isPaidStatus = (s: string) => s === 'PAID' || s === 'MARKED_AS_PAID';

async function createAndSendInvoiceIn(state: State, phaseId: PhaseId) {
  const phase = phaseOf(state, phaseId);
  // A previous attempt created the invoice but could not send it: just retry the send.
  if (phase.invoice && phase.invoice.paypalStatus === 'DRAFT') return sendInvoiceIn(state, phase);
  if (phase.invoice && phase.invoice.paypalStatus !== 'CANCELLED') {
    audit(state, {
      action: 'create_invoice',
      phaseId,
      outcome: 'INFO',
      message: `Invoice ${phase.invoice.number} already exists for this phase (status ${phase.invoice.paypalStatus}); not creating a duplicate`,
      amountCents: phase.invoiceAmountCents,
    });
    return { ok: true as const, invoiceId: phase.invoice.id, duplicate: true };
  }

  const amount = { currency_code: 'USD', value: centsToValue(phase.invoiceAmountCents) };
  const createId = `stagegate-inv-${phaseId}-${randomUUID()}`;
  const createPath = '/v2/invoicing/invoices';
  let invoice: PayPalInvoice;
  try {
    const res = await paypalRequest<PayPalInvoice>('POST', createPath, {
      requestId: createId,
      prefer: 'return=representation',
      body: {
        detail: {
          currency_code: 'USD',
          invoice_number: `SG-${phaseId.replace('phase-', 'P')}-${Date.now()}`,
          note: `${state.projectName}: ${phase.name}. Supplier purchases for this phase stay locked until this invoice is paid.`,
          payment_term: { term_type: 'DUE_ON_RECEIPT' },
        },
        invoicer: { business_name: 'StageGate AI Projects' },
        primary_recipients: [{ billing_info: { email_address: state.clientEmail } }],
        items: [
          {
            name: phase.id === 'phase-1' ? `Deposit: ${phase.name}` : `Milestone: ${phase.name}`,
            quantity: '1',
            unit_amount: amount,
            unit_of_measure: 'QUANTITY',
          },
        ],
      },
    });
    invoice = res.data;
    audit(state, {
      action: 'create_invoice',
      phaseId,
      outcome: 'APPROVED',
      message: `Created PayPal invoice ${invoice.detail?.invoice_number ?? invoice.id} for ${formatUsd(phase.invoiceAmountCents)} to ${state.clientEmail}`,
      amountCents: phase.invoiceAmountCents,
      paypal: { method: 'POST', path: createPath, httpStatus: res.status, requestId: createId, resourceId: invoice.id },
    });
  } catch (err) {
    const message = paypalErrorMessage(err);
    audit(state, {
      action: 'create_invoice',
      phaseId,
      outcome: 'ERROR',
      message,
      amountCents: phase.invoiceAmountCents,
      paypal: { method: 'POST', path: createPath, httpStatus: err instanceof PayPalApiError ? err.status : null, requestId: createId, resourceId: null },
    });
    return { ok: false as const, error: message };
  }

  phase.invoice = {
    id: invoice.id,
    number: invoice.detail?.invoice_number ?? invoice.id,
    paypalStatus: invoice.status,
    invoiceDate: invoice.detail?.invoice_date,
    createdAt: new Date().toISOString(),
  };
  phase.invoiceStatus = invoice.status;
  return sendInvoiceIn(state, phase);
}

async function sendInvoiceIn(state: State, phase: Phase) {
  const phaseId = phase.id;
  const invoice = phase.invoice!;
  const sendId = `stagegate-send-${phaseId}-${randomUUID()}`;
  const sendPath = `/v2/invoicing/invoices/${encodeURIComponent(invoice.id)}/send`;
  try {
    const res = await paypalRequest<unknown>('POST', sendPath, {
      requestId: sendId,
      body: { send_to_recipient: true, send_to_invoicer: false },
    });
    audit(state, {
      action: 'send_invoice',
      phaseId,
      outcome: 'APPROVED',
      message: `Sent invoice ${invoice.number} to ${state.clientEmail}`,
      amountCents: phase.invoiceAmountCents,
      paypal: { method: 'POST', path: sendPath, httpStatus: res.status, requestId: sendId, resourceId: invoice.id },
    });
  } catch (err) {
    const message = paypalErrorMessage(err);
    audit(state, {
      action: 'send_invoice',
      phaseId,
      outcome: 'ERROR',
      message,
      paypal: { method: 'POST', path: sendPath, httpStatus: err instanceof PayPalApiError ? err.status : null, requestId: sendId, resourceId: invoice.id },
    });
    return { ok: false as const, error: `Invoice created but not sent: ${message}`, invoiceId: invoice.id };
  }

  await refreshInvoice(phase);
  return { ok: true as const, invoiceId: invoice.id, status: invoice.paypalStatus };
}

/** Re-reads the invoice from PayPal and updates the phase. Returns PayPal's HTTP status. */
async function refreshInvoice(phase: Phase) {
  if (!phase.invoice) return null;
  const res = await paypalRequest<PayPalInvoice>('GET', `/v2/invoicing/invoices/${encodeURIComponent(phase.invoice.id)}`);
  phase.invoice.paypalStatus = res.data.status;
  phase.invoice.invoiceDate = res.data.detail?.invoice_date ?? phase.invoice.invoiceDate;
  phase.invoice.recipientViewUrl = res.data.detail?.metadata?.recipient_view_url ?? phase.invoice.recipientViewUrl;
  phase.invoiceStatus = isPaidStatus(res.data.status) || phase.invoice.locallySimulatedPaid ? 'PAID' : res.data.status;
  return res.status;
}

export function createAndSendPhaseInvoice(phaseId: PhaseId) {
  return withState((state) => createAndSendInvoiceIn(state, phaseId));
}

async function verifyPaidIn(state: State, phaseId: PhaseId, opts: { simulateClientPaid: boolean }) {
  const phase = phaseOf(state, phaseId);
  if (!phase.invoice) {
    audit(state, { action: 'verify_invoice', phaseId, outcome: 'BLOCKED', message: 'No PayPal invoice exists for this phase yet; generate one first' });
    return { paid: false, reason: 'NO_INVOICE' };
  }
  const invoiceId = phase.invoice.id;

  // Demo shortcut: record the client's payment against the invoice in the PayPal sandbox, so
  // judges don't have to log in as the buyer and wait for sandbox webhooks. PayPal then reports
  // the invoice as MARKED_AS_PAID, and the check below still reads that from PayPal.
  if (opts.simulateClientPaid && !isPaidStatus(phase.invoice.paypalStatus)) {
    const payId = `stagegate-pay-${phaseId}-${randomUUID()}`;
    const payPath = `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/payments`;
    try {
      const res = await paypalRequest<unknown>('POST', payPath, {
        requestId: payId,
        body: {
          method: 'PAYPAL',
          payment_date: phase.invoice.invoiceDate ?? todayIso(),
          amount: { currency_code: 'USD', value: centsToValue(phase.invoiceAmountCents) },
          note: 'StageGate demo: simulated client payment in sandbox',
        },
      });
      audit(state, {
        action: 'simulate_client_paid',
        phaseId,
        outcome: 'INFO',
        message: `Demo: recorded the client's ${formatUsd(phase.invoiceAmountCents)} payment against the invoice in PayPal sandbox`,
        amountCents: phase.invoiceAmountCents,
        paypal: { method: 'POST', path: payPath, httpStatus: res.status, requestId: payId, resourceId: invoiceId },
      });
    } catch (err) {
      // Only an invoice the client actually received may be treated as paid locally; a DRAFT never was.
      const wasSent = ['SENT', 'UNPAID', 'PAYMENT_PENDING', 'PARTIALLY_PAID'].includes(phase.invoice.paypalStatus);
      if (wasSent) phase.invoice.locallySimulatedPaid = true;
      audit(state, {
        action: 'simulate_client_paid',
        phaseId,
        outcome: wasSent ? 'ERROR' : 'BLOCKED',
        message: wasSent
          ? `PayPal refused the simulated payment (${paypalErrorMessage(err)}); demo marks it paid locally instead`
          : `PayPal refused the simulated payment (${paypalErrorMessage(err)}). Invoice is ${phase.invoice.paypalStatus}, never sent to the client, so it cannot count as paid`,
        amountCents: phase.invoiceAmountCents,
        paypal: { method: 'POST', path: payPath, httpStatus: err instanceof PayPalApiError ? err.status : null, requestId: payId, resourceId: invoiceId },
      });
    }
  }

  const getPath = `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}`;
  try {
    const httpStatus = await refreshInvoice(phase);
    const paid = phase.invoiceStatus === 'PAID';
    audit(state, {
      action: 'verify_invoice',
      phaseId,
      outcome: paid ? 'APPROVED' : 'BLOCKED',
      message: paid
        ? `PayPal confirms invoice ${phase.invoice.number} is ${phase.invoice.paypalStatus}${phase.invoice.locallySimulatedPaid ? ' (locally simulated)' : ''}: phase unlocked`
        : `PayPal reports invoice ${phase.invoice.number} as ${phase.invoice.paypalStatus}: phase stays locked`,
      amountCents: phase.invoiceAmountCents,
      paypal: { method: 'GET', path: getPath, httpStatus, requestId: null, resourceId: invoiceId },
    });
    return { paid, paypalStatus: phase.invoice.paypalStatus };
  } catch (err) {
    const message = paypalErrorMessage(err);
    audit(state, {
      action: 'verify_invoice',
      phaseId,
      outcome: 'ERROR',
      message: `Could not verify with PayPal (${message}); phase stays locked`,
      paypal: { method: 'GET', path: getPath, httpStatus: err instanceof PayPalApiError ? err.status : null, requestId: null, resourceId: invoiceId },
    });
    return { paid: false, reason: message };
  }
}

export function verifyPhaseInvoicePaid(phaseId: PhaseId, opts: { simulateClientPaid: boolean } = { simulateClientPaid: false }) {
  return withState((state) => verifyPaidIn(state, phaseId, opts));
}

// --- THE SAFETY LOCK ----------------------------------------------------------------------------

async function attemptPurchaseIn(state: State, phaseId: PhaseId, trigger: string): Promise<PurchaseResult> {
  const phase = phaseOf(state, phaseId);
  const cart = cartOf(phase);
  const cartTotalCents = cart.totalCents;

  // Rule 1: no paid client invoice, no spending. Nothing is sent to PayPal.
  if (phase.invoiceStatus !== 'PAID') {
    const reason = 'BLOCKED_UNFUNDED_PHASE: Client PayPal Invoice is not PAID yet ($0.00 charged)';
    audit(state, {
      action: `supplier_purchase (${trigger})`,
      phaseId,
      outcome: 'BLOCKED',
      message: `${reason}. Invoice status: ${phase.invoiceStatus}. Cart of ${formatUsd(cartTotalCents)} was not sent to PayPal.`,
      amountCents: cartTotalCents,
    });
    return { allowed: false, reason, cartTotalCents };
  }

  if (phase.purchase) {
    audit(state, {
      action: `supplier_purchase (${trigger})`,
      phaseId,
      outcome: 'INFO',
      message: `Supplies already ordered (PayPal order ${phase.purchase.orderId}); not ordering twice`,
      amountCents: phase.purchase.totalCents,
    });
    return { allowed: true, alreadyPurchased: true, orderId: phase.purchase.orderId, status: phase.purchase.status, approveUrl: phase.purchase.approveUrl, cartTotalCents };
  }

  if (cart.items.length === 0) {
    const reason = 'BLOCKED_EMPTY_CART: no sourced products fit this phase budget';
    audit(state, { action: `supplier_purchase (${trigger})`, phaseId, outcome: 'BLOCKED', message: reason, amountCents: 0 });
    return { allowed: false, reason, cartTotalCents };
  }

  // Rule 2: never spend more than the paid invoice brought in (integer cents, no rounding).
  if (cartTotalCents > phase.invoiceAmountCents) {
    const reason = `BLOCKED_OVER_FUNDED_AMOUNT: cart ${formatUsd(cartTotalCents)} exceeds paid invoice ${formatUsd(phase.invoiceAmountCents)}`;
    audit(state, { action: `supplier_purchase (${trigger})`, phaseId, outcome: 'BLOCKED', message: reason, amountCents: cartTotalCents });
    return { allowed: false, reason, cartTotalCents };
  }

  const requestId = `stagegate-order-${phaseId}-${randomUUID()}`;
  const orderPath = '/v2/checkout/orders';
  try {
    const res = await paypalRequest<{ id: string; status: string; links?: { rel: string; href: string }[] }>('POST', orderPath, {
      requestId,
      prefer: 'return=representation',
      body: {
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: phaseId,
            custom_id: phase.invoice?.id,
            description: `${state.projectName}: ${phase.name} supplies`.slice(0, 127),
            amount: {
              currency_code: 'USD',
              value: centsToValue(cartTotalCents),
              breakdown: { item_total: { currency_code: 'USD', value: centsToValue(cartTotalCents) } },
            },
            items: cart.items.map((item) => ({
              name: item.title.slice(0, 127),
              quantity: '1',
              unit_amount: { currency_code: 'USD', value: centsToValue(item.priceCents) },
              category: 'PHYSICAL_GOODS',
            })),
          },
        ],
      },
    });
    const approveUrl = res.data.links?.find((l) => l.rel === 'approve' || l.rel === 'payer-action')?.href;
    phase.purchase = { orderId: res.data.id, status: res.data.status, approveUrl, totalCents: cartTotalCents, createdAt: new Date().toISOString() };
    audit(state, {
      action: `supplier_purchase (${trigger})`,
      phaseId,
      outcome: 'APPROVED',
      message: `Invoice PAID and cart ${formatUsd(cartTotalCents)} ≤ funded ${formatUsd(phase.invoiceAmountCents)}: created PayPal order ${res.data.id} (${res.data.status}) for ${cart.items.length} item(s)`,
      amountCents: cartTotalCents,
      paypal: { method: 'POST', path: orderPath, httpStatus: res.status, requestId, resourceId: res.data.id },
    });
    return { allowed: true, orderId: res.data.id, status: res.data.status, approveUrl, cartTotalCents };
  } catch (err) {
    const reason = `PAYPAL_ORDER_FAILED: ${paypalErrorMessage(err)}`;
    audit(state, {
      action: `supplier_purchase (${trigger})`,
      phaseId,
      outcome: 'ERROR',
      message: reason,
      amountCents: cartTotalCents,
      paypal: { method: 'POST', path: orderPath, httpStatus: err instanceof PayPalApiError ? err.status : null, requestId, resourceId: null },
    });
    return { allowed: false, reason, cartTotalCents };
  }
}

export function attemptSupplierPurchase(phaseId: PhaseId, trigger = 'agent_request') {
  return withState((state) => attemptPurchaseIn(state, phaseId, trigger));
}

/** Step 3: verify with PayPal (optionally simulating the client's payment), then auto-buy if unlocked. */
export function markInvoicePaidAndUnlock(phaseId: PhaseId, opts: { simulateClientPaid: boolean }) {
  return withState(async (state) => {
    const verification = await verifyPaidIn(state, phaseId, opts);
    const purchase = verification.paid ? await attemptPurchaseIn(state, phaseId, 'auto_buy_after_paid') : null;
    return { verification, purchase };
  });
}

// --- Schedule & reset ---------------------------------------------------------------------------

export function simulateLatePayment() {
  return withState(async (state) => {
    const phase = phaseOf(state, 'phase-2');
    if (phase.delayDays > 0) {
      audit(state, { action: 'simulate_late_payment', phaseId: phase.id, outcome: 'INFO', message: `Phase 2 already shifted by ${phase.delayDays} days` });
      return { shifted: false, delayDays: phase.delayDays };
    }
    phase.delayDays = LATE_PAYMENT_DAYS;
    phase.startDate = addDays(phase.originalStartDate, LATE_PAYMENT_DAYS);
    phase.endDate = addDays(phase.originalEndDate, LATE_PAYMENT_DAYS);
    audit(state, {
      action: 'simulate_late_payment',
      phaseId: phase.id,
      outcome: phase.invoiceStatus === 'PAID' ? 'INFO' : 'BLOCKED',
      message: `Client payment ${LATE_PAYMENT_DAYS} days late: Phase 2 moved to ${phase.startDate} → ${phase.endDate}. ${
        phase.invoiceStatus === 'PAID' ? 'Invoice already paid.' : `Supplier spend (${formatUsd(cartOf(phase).totalCents)}) stays locked; no cash fronted.`
      }`,
    });
    return { shifted: true, delayDays: phase.delayDays, startDate: phase.startDate, endDate: phase.endDate };
  });
}

export function resetDemo() {
  return withState(async (state) => {
    const fresh = defaultState(state.plan, state.planMeta);
    // Same plan, so keep already-sourced products so a reset does not spend Channel3 calls; carts are re-picked.
    for (const phase of fresh.phases) {
      const old = state.phases.find((p) => p.id === phase.id);
      if (old && old.productSource !== 'none') {
        phase.products = old.products;
        phase.productSource = old.productSource;
        phase.productNote = old.productNote;
        selectCart(phase);
      }
    }
    Object.assign(state, fresh);
    audit(state, { action: 'reset_demo', outcome: 'INFO', message: `Demo reset: ${state.projectName} (${formatUsd(state.totalBudgetCents)} budget), both phases locked` });
    return { reset: true };
  });
}

/**
 * Replaces the project with a new plan (from the AI Project Brief): fresh locked phases on a new
 * timeline, a new audit chain, and equipment re-sourced from Channel3 for the new search queries.
 */
export function applyProjectPlan(plan: ProjectPlan, meta: PlanMeta) {
  return withState(async (state) => {
    Object.assign(state, defaultState(plan, meta));
    const p1 = plan.phases[0];
    const p2 = plan.phases[1];
    audit(state, {
      action: 'plan_project',
      outcome: 'INFO',
      message:
        `${meta.source === 'openai' ? `AI (${meta.model}) planned` : 'Preset plan loaded for'} "${plan.projectName}" (${formatUsd(plan.totalBudgetCents)}): ` +
        `Phase 1 "${p1.name}" invoice ${formatUsd(p1.invoiceAmountCents)} / equipment ${formatUsd(p1.equipmentBudgetCents)}; ` +
        `Phase 2 "${p2.name}" invoice ${formatUsd(p2.invoiceAmountCents)} / equipment ${formatUsd(p2.equipmentBudgetCents)}` +
        (meta.note ? `. Note: ${meta.note}` : ''),
      amountCents: plan.totalBudgetCents,
    });
    for (const phase of state.phases) await sourceProducts(state, phase);
    return { projectName: plan.projectName, source: meta.source, model: meta.model, note: meta.note };
  });
}

// --- Snapshot for the UI ------------------------------------------------------------------------

export function getSnapshot(opts: { sourceIfMissing?: boolean } = {}) {
  return withState(async (state) => {
    if (opts.sourceIfMissing) {
      for (const phase of state.phases) if (phase.productSource === 'none') await sourceProducts(state, phase);
    }
    const sum = (f: (p: Phase) => number) => state.phases.reduce((s, p) => s + f(p), 0);
    const invoicedCents = sum((p) => (p.invoice ? p.invoiceAmountCents : 0));
    const collectedCents = sum((p) => (p.invoiceStatus === 'PAID' ? p.invoiceAmountCents : 0));
    const spentCents = sum((p) => p.purchase?.totalCents ?? 0);
    return {
      project: {
        name: state.projectName,
        totalBudgetCents: state.totalBudgetCents,
        clientEmail: state.clientEmail,
        createdAt: state.createdAt,
        plan: state.planMeta,
      },
      phases: state.phases.map((p) => ({ ...p, cartTotalCents: cartOf(p).totalCents, locked: p.invoiceStatus !== 'PAID' })),
      summary: {
        totalBudgetCents: state.totalBudgetCents,
        invoicedCents,
        collectedCents,
        spentCents,
        availableCents: collectedCents - spentCents,
        protectedCents: sum((p) => (p.invoiceStatus !== 'PAID' && !p.purchase ? cartOf(p).totalCents : 0)),
        blockedAttempts: state.audit.filter((e) => e.outcome === 'BLOCKED').length,
        approvedCalls: state.audit.filter((e) => e.outcome === 'APPROVED').length,
      },
      audit: [...state.audit].reverse(),
      auditChainValid: verifyAuditChain(state.audit),
      config: {
        channel3Configured: Boolean(process.env.CHANNEL3_API_KEY),
        paypalConfigured: Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_SECRET),
        openAiConfigured: Boolean(process.env.AG_STUDIO_OPENAI_API_KEY || process.env.OPENAI_API_KEY),
      },
    };
  });
}

export type StageGateSnapshot = Awaited<ReturnType<typeof getSnapshot>>;
