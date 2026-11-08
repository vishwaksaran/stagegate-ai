import {
  applyProjectPlan,
  attemptSupplierPurchase,
  createAndSendPhaseInvoice,
  getSnapshot,
  isPhaseId,
  markInvoicePaidAndUnlock,
  resetDemo,
  searchProducts,
  simulateLatePayment,
  type PhaseId,
} from '@/lib/stagegate';
import { planFromBrief } from '@/lib/stagegate-ai';
import { MAX_BRIEF_LENGTH } from '@/lib/stagegate-presets';

// StageGate AI API. GET returns the whole project; POST { action, phaseId?, simulateClientPaid? } runs one step
// and returns its result plus the updated project. See lib/stagegate.ts for the rules.

export const dynamic = 'force-dynamic';

const ACTIONS = [
  'plan_from_brief',
  'search_products',
  'create_invoice',
  'attempt_premature_buy',
  'mark_invoice_paid_and_unlock',
  'simulate_late_payment',
  'reset_demo',
] as const;
type Action = (typeof ACTIONS)[number];

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function GET() {
  try {
    return Response.json(await getSnapshot({ sourceIfMissing: true }), { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return Response.json({ error: errorMessage(err) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let body: { action?: unknown; phaseId?: unknown; simulateClientPaid?: unknown; brief?: unknown; presetId?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Request body must be JSON.' }, { status: 400 });
  }

  const action = body.action as Action;
  if (!ACTIONS.includes(action)) {
    return Response.json({ error: `Unknown action. Use one of: ${ACTIONS.join(', ')}` }, { status: 400 });
  }
  if (body.phaseId !== undefined && !isPhaseId(body.phaseId)) {
    return Response.json({ error: 'phaseId must be "phase-1" or "phase-2".' }, { status: 400 });
  }
  const phaseId = body.phaseId as PhaseId | undefined;

  try {
    let result: unknown;
    switch (action) {
      case 'plan_from_brief': {
        const brief = typeof body.brief === 'string' ? body.brief.trim() : '';
        if (brief.length < 10 || brief.length > MAX_BRIEF_LENGTH) {
          return Response.json({ error: `Write a project brief of 10 to ${MAX_BRIEF_LENGTH} characters.` }, { status: 400 });
        }
        // Plan first (slow, outside the state lock), then swap the project in one step.
        const { plan, meta } = await planFromBrief(brief, typeof body.presetId === 'string' ? body.presetId : undefined);
        result = await applyProjectPlan(plan, meta);
        break;
      }
      case 'search_products':
        result = await searchProducts(phaseId);
        break;
      case 'create_invoice':
        result = await createAndSendPhaseInvoice(phaseId ?? 'phase-1');
        break;
      case 'attempt_premature_buy':
        result = await attemptSupplierPurchase(phaseId ?? 'phase-1', 'premature_ai_buy_test');
        break;
      case 'mark_invoice_paid_and_unlock':
        result = await markInvoicePaidAndUnlock(phaseId ?? 'phase-1', { simulateClientPaid: body.simulateClientPaid !== false });
        break;
      case 'simulate_late_payment':
        result = await simulateLatePayment();
        break;
      case 'reset_demo':
        result = await resetDemo();
        break;
    }
    return Response.json({ action, result, snapshot: await getSnapshot() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return Response.json({ action, error: errorMessage(err) }, { status: 500 });
  }
}
