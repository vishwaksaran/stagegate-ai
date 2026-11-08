// AI Project Brief: turns a plain-English brief into a two-phase StageGate plan with OpenAI.
//
// The model only proposes names, amounts and search terms. Before anything is used, validatePlan()
// enforces the money rules in plain code: the two invoices add up exactly to the budget (taken from
// the brief when it states one), each equipment budget fits inside its invoice, and all amounts are
// whole cents. The Safety Lock itself never involves the model. Server-side only.

import { aiModels, openAiKey } from './ai';
import { PRESETS, type PhasePlan, type ProjectPlan } from './stagegate-presets';
import type { PlanMeta } from './stagegate';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const MAX_BUDGET_CENTS = 1_000_000; // $10,000: this is a small-project demo.

const SYSTEM_PROMPT = `You plan small client projects for StageGate AI, a cashflow safety lock.
Split the project into exactly 2 sequential phases. Each phase is funded by one client invoice; once that
invoice is paid, an agent buys the phase's physical equipment online.
Rules:
- clientInvoiceUsd of both phases must add up exactly to totalBudgetUsd. Phase 1 is a smaller deposit (15-45% of the budget).
- equipmentBudgetUsd is the part of each invoice spent on physical goods: 50-70% of that phase's invoice. The rest is labour and margin.
- searchQueries: 2 short shopping search terms per phase (2-5 words each) for physical products a store sells, most important first.
- durationDays: 5-21.
- Use the budget stated in the brief. If none is stated, pick a realistic one under $5,000.`;

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['projectName', 'totalBudgetUsd', 'phases'],
  properties: {
    projectName: { type: 'string' },
    totalBudgetUsd: { type: 'number' },
    phases: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'clientInvoiceUsd', 'equipmentBudgetUsd', 'durationDays', 'searchQueries'],
        properties: {
          name: { type: 'string' },
          clientInvoiceUsd: { type: 'number' },
          equipmentBudgetUsd: { type: 'number' },
          durationDays: { type: 'integer' },
          searchQueries: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

type RawPlan = {
  projectName: string;
  totalBudgetUsd: number;
  phases: { name: string; clientInvoiceUsd: number; equipmentBudgetUsd: number; durationDays: number; searchQueries: string[] }[];
};

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const toCents = (usd: number) => Math.round(usd * 100);
const clean = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** The first dollar amount in the brief, e.g. "$1,200" -> 120000 cents. */
export function budgetFromBrief(brief: string): number | null {
  const m = brief.match(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/);
  if (!m) return null;
  const cents = Number(m[1].replaceAll(',', '')) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
  return cents > 0 ? cents : null;
}

/** Deterministic guardrails over whatever the model returned. Throws if it is unusable. */
export function validatePlan(raw: RawPlan, statedBudgetCents: number | null): ProjectPlan {
  if (!raw || !Array.isArray(raw.phases) || raw.phases.length < 2) throw new Error('the plan needs 2 phases');
  const total = statedBudgetCents ?? toCents(Number(raw.totalBudgetUsd));
  if (!Number.isFinite(total) || total < 10_000 || total > MAX_BUDGET_CENTS) {
    throw new Error('budget must be between $100 and $10,000');
  }

  // Phase 1 is the deposit; phase 2 is exactly the rest, so the invoices always sum to the budget.
  const proposed1 = toCents(Number(raw.phases[0].clientInvoiceUsd));
  const invoice1 = clamp(Number.isFinite(proposed1) ? proposed1 : Math.round(total * 0.25), Math.round(total * 0.1), Math.round(total * 0.6));
  const invoices = [invoice1, total - invoice1];

  const phases = raw.phases.slice(0, 2).map((p, i): PhasePlan => {
    const invoice = invoices[i];
    const equipment = toCents(Number(p.equipmentBudgetUsd));
    const queries = (Array.isArray(p.searchQueries) ? p.searchQueries : []).map((q) => clean(q, 60)).filter(Boolean).slice(0, 3);
    if (queries.length === 0) throw new Error(`phase ${i + 1} has no search terms`);
    return {
      // The UI already labels phases, so drop a model-added "Phase 1:" prefix.
      name: clean(p.name, 80).replace(/^phase\s*\d+\s*[:\-–—.]\s*/i, '').slice(0, 60) || `Phase ${i + 1}`,
      invoiceAmountCents: invoice,
      // Equipment can never exceed what the invoice brings in.
      equipmentBudgetCents: clamp(Number.isFinite(equipment) ? equipment : Math.round(invoice * 0.6), Math.round(invoice * 0.2), invoice),
      durationDays: clamp(Math.round(Number(p.durationDays)) || 7, 3, 30),
      searchQueries: queries,
    };
  });

  return { projectName: clean(raw.projectName, 60) || 'Client Project', totalBudgetCents: total, phases: [phases[0], phases[1]] };
}

async function askOpenAI(brief: string, apiKey: string, model: string): Promise<RawPlan> {
  const res = await fetch(OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      input: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: brief },
      ],
      text: { format: { type: 'json_schema', name: 'stagegate_plan', strict: true, schema: PLAN_SCHEMA } },
      max_output_tokens: 4000,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const data = (await res.json().catch(() => ({}))) as {
    error?: { message?: string };
    output?: { type: string; content?: { type: string; text?: string }[] }[];
  };
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${data.error?.message ?? 'request failed'}`);

  const text = data.output
    ?.filter((o) => o.type === 'message')
    .flatMap((o) => o.content ?? [])
    .find((c) => c.type === 'output_text')?.text;
  if (!text) throw new Error('OpenAI returned no plan text');
  return JSON.parse(text) as RawPlan;
}

/**
 * Plans a project from a brief. With a preset id, the preset's hand-written plan is the fallback
 * when OpenAI is missing or fails; a custom brief needs OpenAI.
 */
export async function planFromBrief(brief: string, presetId?: string): Promise<{ plan: ProjectPlan; meta: PlanMeta }> {
  const preset = PRESETS.find((p) => p.id === presetId);
  const apiKey = openAiKey();
  const model = aiModels()[0];

  if (apiKey) {
    try {
      const plan = validatePlan(await askOpenAI(brief, apiKey, model), budgetFromBrief(brief));
      return { plan, meta: { source: 'openai', brief, model, note: null } };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (!preset) throw new Error(`AI planning failed: ${reason}`);
      return { plan: preset.plan, meta: { source: 'preset', brief, model: null, note: `OpenAI unavailable (${reason}), used the built-in preset plan` } };
    }
  }
  if (preset) {
    return { plan: preset.plan, meta: { source: 'preset', brief, model: null, note: 'AG_STUDIO_OPENAI_API_KEY not set, used the built-in preset plan' } };
  }
  throw new Error('Set AG_STUDIO_OPENAI_API_KEY in .env.local to plan custom briefs with AI, or pick a preset.');
}
