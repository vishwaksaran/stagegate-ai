'use client';

import { useEffect, useState } from 'react';
import type { AuditEntry, PhaseId, StageGateSnapshot } from '@/lib/stagegate';
import { MAX_BRIEF_LENGTH, PRESETS } from '@/lib/stagegate-presets';

// StageGate AI demo panel: timeline, sourced products, step buttons and the audit trail.
// All rules run on the server (lib/stagegate.ts); this only calls /api/stagegate and renders the result.

type Snapshot = StageGateSnapshot;
type PhaseView = Snapshot['phases'][number];
type Notice = { tone: 'ok' | 'blocked' | 'info' | 'error'; text: string; action?: string };

const usd = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });

const shortDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

const dayIndex = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);

export function StageGatePanel() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [phaseId, setPhaseId] = useState<PhaseId>('phase-1');
  const [simulatePaid, setSimulatePaid] = useState(true);
  const [brief, setBrief] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/stagegate', { cache: 'no-store' })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        if (cancelled) return;
        setSnap(data);
        setBrief(data.project?.plan?.brief ?? '');
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function run(action: string, extra: Record<string, unknown> = {}) {
    setBusy(action);
    setNotice(null);
    try {
      const res = await fetch('/api/stagegate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...extra }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSnap(data.snapshot);
      setNotice({ ...describe(action, data.result), action });
    } catch (err) {
      setNotice({ tone: 'error', text: err instanceof Error ? err.message : String(err), action });
    } finally {
      setBusy(null);
    }
  }

  if (!snap) {
    return (
      <section className="rounded-2xl border border-pp-border bg-pp-surface p-8">
        <h1 className="text-2xl font-semibold text-pp-navy">StageGate AI</h1>
        <p className="mt-2 text-pp-muted">{loadError ? `Could not load: ${loadError}` : 'Loading project and sourcing equipment from Channel3…'}</p>
      </section>
    );
  }

  const selected = snap.phases.find((p) => p.id === phaseId)!;
  const s = snap.summary;
  const planMeta = snap.project.plan ?? { source: 'preset', brief: '', model: null, note: null };

  const planFrom = (text: string, presetId?: string) => {
    setBrief(text);
    setPhaseId('phase-1');
    // A preset's text keeps its hand-written fallback plan even when typed rather than clicked.
    void run('plan_from_brief', { brief: text, presetId: presetId ?? PRESETS.find((p) => p.brief === text.trim())?.id });
  };

  return (
    <section className="space-y-6">
      {/* AI Project Brief */}
      <Card
        title="AI Project Brief"
        subtitle="Describe a client project and its budget. AI splits it into 2 invoice-funded phases, finds real equipment on Channel3, and resets the timeline."
        aside={
          <span
            className={`rounded-full px-3 py-1 text-xs font-semibold ${
              planMeta.source === 'openai' ? 'bg-pp-highlight text-pp-blue-dark' : 'bg-pp-canvas text-pp-muted'
            }`}
            title={planMeta.note ?? undefined}
          >
            {planMeta.source === 'openai' ? `Planned by OpenAI · ${planMeta.model}` : 'Preset plan'}
          </span>
        }
      >
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => planFrom(p.brief, p.id)}
              disabled={busy !== null}
              className="rounded-full border border-pp-border bg-pp-canvas px-3 py-1.5 text-sm font-semibold text-pp-ink transition hover:border-pp-blue hover:text-pp-blue disabled:cursor-wait disabled:opacity-50"
            >
              {p.label}
            </button>
          ))}
        </div>
        <form
          className="mt-3 flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            planFrom(brief);
          }}
        >
          <label htmlFor="stagegate-brief" className="sr-only">
            Project brief
          </label>
          <textarea
            id="stagegate-brief"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            maxLength={MAX_BRIEF_LENGTH}
            rows={2}
            placeholder="e.g. Food truck launch for a farmers market, total budget $1,500. First the serving setup, then the cooking equipment."
            className="min-h-[3.5rem] flex-1 resize-y rounded-xl border border-pp-border bg-pp-surface px-3 py-2 text-sm outline-none focus:border-pp-blue"
          />
          <button
            type="submit"
            disabled={busy !== null || brief.trim().length < 10}
            className="rounded-xl bg-pp-navy px-5 py-3 text-sm font-semibold text-white transition hover:bg-pp-blue-dark disabled:opacity-50"
          >
            {busy === 'plan_from_brief' ? 'Planning with AI…' : '✨ Generate plan with AI'}
          </button>
        </form>
        {busy === 'plan_from_brief' && (
          <p className="mt-2 text-xs text-pp-muted">Asking OpenAI for 2 phases, then searching Channel3 for the equipment. This takes 10–30 seconds.</p>
        )}
        {notice?.action === 'plan_from_brief' && <NoticeBox notice={notice} />}
      </Card>

      {/* Header */}
      <div className="rounded-2xl bg-pp-navy p-6 text-white sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-widest text-pp-sky">StageGate AI · Cashflow Safety Lock</p>
        <h1 className="mt-2 text-2xl font-semibold sm:text-3xl">
          {snap.project.name} <span className="text-white/60">({usd(snap.project.totalBudgetCents)} budget)</span>
        </h1>
        <p className="mt-2 max-w-3xl text-sm text-white/80">
          The AI agent can source equipment, but it can&apos;t spend a cent on a phase until that phase&apos;s client invoice is
          confirmed <strong>PAID by PayPal</strong>, and never more than the invoice brought in. Client invoices go to{' '}
          <code className="text-white">{snap.project.clientEmail}</code>.
        </p>
        <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Invoiced" value={usd(s.invoicedCents)} />
          <Stat label="Collected" value={usd(s.collectedCents)} />
          <Stat label="Spent on suppliers" value={usd(s.spentCents)} />
          <Stat label="Cash available" value={usd(s.availableCents)} />
          <Stat label="Spend held by lock" value={usd(s.protectedCents)} />
          <Stat label="Blocked attempts" value={String(s.blockedAttempts)} />
        </dl>
      </div>

      {/* Timeline */}
      <Card title="Project timeline" subtitle="Red = locked (client hasn't paid). Green = funded and unlocked.">
        <Timeline phases={snap.phases} />
      </Card>

      {/* Actions */}
      <Card title="Run the demo" subtitle="Pick a phase, then walk through the steps in order.">
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex rounded-full border border-pp-border p-1" role="tablist" aria-label="Phase">
            {snap.phases.map((p, i) => (
              <button
                key={p.id}
                role="tab"
                aria-selected={p.id === phaseId}
                onClick={() => setPhaseId(p.id)}
                className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
                  p.id === phaseId ? 'bg-pp-navy text-white' : 'text-pp-muted hover:text-pp-ink'
                }`}
              >
                Phase {i + 1}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm text-pp-muted">
            <input type="checkbox" checked={simulatePaid} onChange={(e) => setSimulatePaid(e.target.checked)} className="size-4 accent-pp-blue" />
            Simulate client paid in sandbox
          </label>
        </div>
        <p className="mt-3 text-sm text-pp-muted">
          <strong className="text-pp-ink">{selected.name}</strong>: invoice {usd(selected.invoiceAmountCents)}, equipment budget{' '}
          {usd(selected.equipmentBudgetCents)}, cart {usd(selected.cartTotalCents)}. Invoice status:{' '}
          <StatusPill status={selected.invoiceStatus} />
        </p>

        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <ActionButton busy={busy} action="create_invoice" onClick={() => run('create_invoice', { phaseId })}>
            1. Generate PayPal Client Invoice
          </ActionButton>
          <ActionButton busy={busy} action="attempt_premature_buy" tone="danger" onClick={() => run('attempt_premature_buy', { phaseId })}>
            2. Test Premature AI Buy (Safety Lock)
          </ActionButton>
          <ActionButton
            busy={busy}
            action="mark_invoice_paid_and_unlock"
            tone="success"
            onClick={() => run('mark_invoice_paid_and_unlock', { phaseId, simulateClientPaid: simulatePaid })}
          >
            3. Verify Client Paid &amp; Auto-Buy Supplies
          </ActionButton>
          <ActionButton busy={busy} action="simulate_late_payment" tone="warning" onClick={() => run('simulate_late_payment')}>
            4. Simulate 4-Day Late Payment
          </ActionButton>
          <ActionButton busy={busy} action="search_products" tone="plain" onClick={() => run('search_products')}>
            Re-search Channel3 Products
          </ActionButton>
          <ActionButton busy={busy} action="reset_demo" tone="plain" onClick={() => run('reset_demo')}>
            Reset Demo
          </ActionButton>
        </div>

        {notice && notice.action !== 'plan_from_brief' && <NoticeBox notice={notice} />}
      </Card>

      {/* Products */}
      <div className="grid gap-6 lg:grid-cols-2">
        {snap.phases.map((p, i) => (
          <ProductsCard key={p.id} phase={p} index={i} />
        ))}
      </div>

      {/* Audit trail */}
      <Card
        title="SHA-256 audit trail"
        subtitle="Every approved, blocked and failed call. Each row's hash covers the previous row's hash, so editing history breaks the chain."
        aside={
          <span
            className={`rounded-full px-3 py-1 text-xs font-semibold ${
              snap.auditChainValid ? 'bg-pp-success/10 text-pp-success' : 'bg-pp-danger/10 text-pp-danger'
            }`}
          >
            {snap.auditChainValid ? '✓ Chain intact' : '✗ Chain broken'}
          </span>
        }
      >
        <AuditTable entries={snap.audit} />
      </Card>
    </section>
  );
}

// --- Pieces ---------------------------------------------------------------------------------------

function describe(action: string, result: Record<string, unknown> | undefined): Notice {
  const r = (result ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (action) {
    case 'plan_from_brief':
      return r.source === 'openai'
        ? { tone: 'ok', text: `✨ AI (${r.model}) planned "${r.projectName}" and sourced its equipment from Channel3. Both phases start locked.` }
        : { tone: 'info', text: `Loaded the "${r.projectName}" preset plan. ${r.note ?? ''}` };
    case 'create_invoice':
      if (!r.ok) return { tone: 'error', text: `Invoice failed: ${r.error}` };
      return r.duplicate
        ? { tone: 'info', text: 'This phase already has an invoice, so no duplicate was created.' }
        : { tone: 'ok', text: `Real PayPal sandbox invoice created and sent to the client (status ${r.status}).` };
    case 'attempt_premature_buy':
      return r.allowed
        ? { tone: 'ok', text: `Allowed: the invoice is paid, PayPal order ${r.orderId} (${r.status}).` }
        : { tone: 'blocked', text: `🔒 Blocked: ${r.reason}` };
    case 'mark_invoice_paid_and_unlock': {
      const v = r.verification ?? {};
      if (!v.paid) return { tone: 'blocked', text: `Still locked: ${v.reason === 'NO_INVOICE' ? 'generate the invoice first (step 1).' : `PayPal says ${v.paypalStatus ?? v.reason}.`}` };
      const p = r.purchase ?? {};
      return p.allowed
        ? { tone: 'ok', text: `✅ PayPal confirms ${v.paypalStatus}. Supplies ordered: PayPal order ${p.orderId} for ${usd(p.cartTotalCents)}${p.alreadyPurchased ? ' (already ordered earlier)' : ''}.` }
        : { tone: 'blocked', text: `Paid, but the buy was blocked: ${p.reason}` };
    }
    case 'simulate_late_payment':
      return r.shifted
        ? { tone: 'info', text: `Phase 2 pushed back ${r.delayDays} days (${r.startDate} → ${r.endDate}). No cash was fronted to suppliers.` }
        : { tone: 'info', text: 'Phase 2 was already shifted.' };
    case 'reset_demo':
      return { tone: 'info', text: 'Demo reset. Both phases are locked again.' };
    case 'search_products':
      return { tone: 'info', text: 'Products re-sourced.' };
    default:
      return { tone: 'info', text: 'Done.' };
  }
}

function NoticeBox({ notice }: { notice: Notice }) {
  const tone = {
    ok: 'border-pp-success/40 bg-pp-success/10 text-pp-success',
    blocked: 'border-pp-danger/40 bg-pp-danger/10 text-pp-danger',
    info: 'border-pp-blue/30 bg-pp-highlight text-pp-blue-dark',
    error: 'border-pp-warning/40 bg-pp-warning/10 text-pp-warning',
  }[notice.tone];
  return (
    <div role="status" className={`mt-4 rounded-xl border px-4 py-3 text-sm ${tone}`}>
      {notice.text}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-white/10 px-3 py-2">
      <dt className="text-[11px] uppercase tracking-wider text-white/60">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function Card({ title, subtitle, aside, children }: { title: string; subtitle?: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-pp-border bg-pp-surface p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-pp-navy">{title}</h2>
          {subtitle && <p className="mt-0.5 text-sm text-pp-muted">{subtitle}</p>}
        </div>
        {aside}
      </div>
      <div className="mt-4">{children}</div>
    </div>
  );
}

function ActionButton({
  busy,
  action,
  tone = 'primary',
  onClick,
  children,
}: {
  busy: string | null;
  action: string;
  tone?: 'primary' | 'danger' | 'success' | 'warning' | 'plain';
  onClick: () => void;
  children: React.ReactNode;
}) {
  const styles = {
    primary: 'bg-pp-blue text-white hover:bg-pp-blue-dark',
    danger: 'bg-pp-danger text-white hover:opacity-90',
    success: 'bg-pp-success text-white hover:opacity-90',
    warning: 'bg-pp-warning text-white hover:opacity-90',
    plain: 'border border-pp-border bg-pp-surface text-pp-ink hover:bg-pp-canvas',
  }[tone];
  return (
    <button
      onClick={onClick}
      disabled={busy !== null}
      className={`rounded-xl px-4 py-3 text-left text-sm font-semibold transition disabled:cursor-wait disabled:opacity-50 ${styles}`}
    >
      {busy === action ? 'Working…' : children}
    </button>
  );
}

function StatusPill({ status }: { status: string }) {
  const paid = status === 'PAID';
  return (
    <span
      className={`ml-1 inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${
        paid ? 'bg-pp-success/10 text-pp-success' : 'bg-pp-danger/10 text-pp-danger'
      }`}
    >
      {paid ? '✓ PAID' : `🔒 ${status.replace('_', ' ')}`}
    </span>
  );
}

function Timeline({ phases }: { phases: PhaseView[] }) {
  const starts = phases.flatMap((p) => [dayIndex(p.startDate), dayIndex(p.originalStartDate)]);
  const ends = phases.flatMap((p) => [dayIndex(p.endDate), dayIndex(p.originalEndDate)]);
  const min = Math.min(...starts);
  const span = Math.max(...ends) + 1 - min;
  const pos = (start: string, end: string) => ({
    left: `${((dayIndex(start) - min) / span) * 100}%`,
    width: `${((dayIndex(end) + 1 - dayIndex(start)) / span) * 100}%`,
  });

  return (
    <div className="space-y-5">
      {phases.map((p, i) => {
        const paid = !p.locked;
        return (
          <div key={p.id}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 text-sm">
              <span className="font-semibold">
                Phase {i + 1}: {p.name}
              </span>
              <span className="text-pp-muted tabular-nums">
                {p.delayDays > 0 && (
                  <span className="mr-2 line-through">
                    {shortDate(p.originalStartDate)} – {shortDate(p.originalEndDate)}
                  </span>
                )}
                {shortDate(p.startDate)} – {shortDate(p.endDate)}
                {p.delayDays > 0 && <span className="ml-2 font-semibold text-pp-warning">+{p.delayDays} days late</span>}
              </span>
            </div>
            <div className="relative mt-2 h-10 rounded-lg bg-pp-canvas">
              {p.delayDays > 0 && (
                <div
                  className="absolute inset-y-1 rounded-md border-2 border-dashed border-pp-muted/40"
                  style={pos(p.originalStartDate, p.originalEndDate)}
                  aria-hidden
                />
              )}
              <div
                className={`absolute inset-y-1 flex items-center gap-2 overflow-hidden whitespace-nowrap rounded-md px-3 text-xs font-semibold text-white transition-all ${
                  paid ? 'bg-pp-success' : 'bg-pp-danger'
                }`}
                style={pos(p.startDate, p.endDate)}
              >
                {paid ? '✓ Funded' : '🔒 Locked'} · {usd(p.invoiceAmountCents)}
                {p.purchase && ' · supplies ordered'}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ProductsCard({ phase, index }: { phase: PhaseView; index: number }) {
  const over = phase.cartTotalCents > phase.equipmentBudgetCents;
  return (
    <Card
      title={`Phase ${index + 1} equipment`}
      subtitle={phase.name}
      aside={
        <span
          className={`rounded-full px-3 py-1 text-xs font-semibold ${
            phase.productSource === 'channel3' ? 'bg-pp-highlight text-pp-blue-dark' : 'bg-pp-warning/10 text-pp-warning'
          }`}
          title={phase.productNote}
        >
          {phase.productSource === 'channel3' ? 'Live from Channel3' : phase.productSource === 'fallback' ? 'Sample catalog' : 'Not sourced'}
        </span>
      }
    >
      {phase.productSource === 'fallback' && phase.productNote && (
        <p className="mb-3 text-xs text-pp-warning">Channel3 unavailable: {phase.productNote}</p>
      )}
      <div className="mb-3 flex items-center justify-between rounded-xl bg-pp-canvas px-4 py-2 text-sm">
        <span>
          Cart <strong className={over ? 'text-pp-danger' : ''}>{usd(phase.cartTotalCents)}</strong> of {usd(phase.equipmentBudgetCents)} budget
        </span>
        {phase.purchase ? (
          <span className="font-semibold text-pp-success">Ordered · {phase.purchase.orderId}</span>
        ) : (
          <span className={`font-semibold ${phase.locked ? 'text-pp-danger' : 'text-pp-success'}`}>{phase.locked ? '🔒 Spend locked' : 'Unlocked'}</span>
        )}
      </div>
      <ul className="grid gap-3 sm:grid-cols-2">
        {phase.products.map((p) => (
          <li
            key={p.id}
            className={`flex gap-3 rounded-xl border p-3 ${p.inCart ? 'border-pp-blue bg-pp-highlight/50' : 'border-pp-border'}`}
          >
            <div className="size-16 shrink-0 overflow-hidden rounded-lg bg-pp-canvas">
              {p.imageUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={p.imageUrl} alt="" className="size-full object-contain" loading="lazy" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 text-sm font-semibold leading-snug">
                {p.url ? (
                  <a href={p.url} target="_blank" rel="noreferrer" className="hover:text-pp-blue">
                    {p.title}
                  </a>
                ) : (
                  p.title
                )}
              </p>
              <p className="truncate text-xs text-pp-muted">{p.brand ?? p.query}</p>
              <p className="mt-1 flex items-center gap-2 text-sm">
                <span className="font-semibold tabular-nums">{usd(p.priceCents)}</span>
                {p.inCart && <span className="rounded-full bg-pp-blue px-2 py-0.5 text-[10px] font-semibold text-white">IN CART</span>}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function AuditTable({ entries }: { entries: AuditEntry[] }) {
  if (entries.length === 0) return <p className="text-sm text-pp-muted">No activity yet. Run step 1.</p>;
  const tone: Record<AuditEntry['outcome'], string> = {
    APPROVED: 'bg-pp-success/10 text-pp-success',
    BLOCKED: 'bg-pp-danger/10 text-pp-danger',
    INFO: 'bg-pp-highlight text-pp-blue-dark',
    ERROR: 'bg-pp-warning/10 text-pp-warning',
  };
  return (
    <div className="-mx-5 overflow-x-auto sm:-mx-6">
      <table className="w-full min-w-[860px] text-left text-sm">
        <thead className="border-y border-pp-border bg-pp-canvas text-xs uppercase tracking-wider text-pp-muted">
          <tr>
            <th className="px-4 py-2">#</th>
            <th className="px-4 py-2">Time</th>
            <th className="px-4 py-2">Outcome</th>
            <th className="px-4 py-2">Action</th>
            <th className="px-4 py-2">What happened</th>
            <th className="px-4 py-2">PayPal call</th>
            <th className="px-4 py-2 text-right">Amount</th>
            <th className="px-4 py-2">SHA-256</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-pp-border">
          {entries.map((e) => (
            <tr key={e.seq} className="align-top">
              <td className="px-4 py-2 tabular-nums text-pp-muted">{e.seq}</td>
              <td className="whitespace-nowrap px-4 py-2 tabular-nums text-pp-muted">{new Date(e.at).toLocaleTimeString()}</td>
              <td className="px-4 py-2">
                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tone[e.outcome]}`}>{e.outcome}</span>
              </td>
              <td className="px-4 py-2 font-mono text-xs">
                {e.action}
                {e.phaseId && <div className="text-pp-muted">{e.phaseId}</div>}
              </td>
              <td className="px-4 py-2">{e.message}</td>
              <td className="px-4 py-2 font-mono text-xs text-pp-muted">
                {e.paypal ? (
                  <>
                    {e.paypal.method} {e.paypal.path}
                    {e.paypal.httpStatus !== null && <div>HTTP {e.paypal.httpStatus}</div>}
                  </>
                ) : (
                  <span>No PayPal call</span>
                )}
              </td>
              <td className="px-4 py-2 text-right tabular-nums">{e.amountCents !== null ? usd(e.amountCents) : '—'}</td>
              <td className="px-4 py-2 font-mono text-xs text-pp-muted" title={`hash ${e.hash}\nprev ${e.prevHash}`}>
                {e.hash.slice(0, 12)}…
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
