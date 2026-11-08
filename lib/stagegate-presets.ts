// Project plans for StageGate AI. Safe to import from client components (no server code).
//
// A plan is what the AI Project Brief produces: a project with exactly two phases, each funded by
// one client invoice and with an equipment budget the agent may spend once that invoice is paid.
// Each preset also carries a hand-written plan, used as-is when OpenAI is not configured or fails,
// so the one-click demo always works.

export type PhasePlan = {
  name: string;
  invoiceAmountCents: number;
  equipmentBudgetCents: number;
  durationDays: number;
  searchQueries: string[];
};

export type ProjectPlan = {
  projectName: string;
  totalBudgetCents: number;
  phases: [PhasePlan, PhasePlan];
};

export type Preset = { id: string; label: string; brief: string; plan: ProjectPlan };

export const PRESETS: Preset[] = [
  {
    id: 'espresso',
    label: 'Pop-Up Espresso Bar ($800)',
    brief:
      'Pop-up espresso bar for a weekend market. Total client budget $800. First we need a barista tamper and prep station, then a commercial espresso grinder and disposable cups.',
    plan: {
      projectName: 'Pop-Up Espresso Bar',
      totalBudgetCents: 80_000,
      phases: [
        {
          name: 'Barista Tamper & Prep Station',
          invoiceAmountCents: 15_000,
          equipmentBudgetCents: 9_500,
          durationDays: 7,
          searchQueries: ['58mm espresso tamper', 'espresso knock box'],
        },
        {
          name: 'Commercial Espresso Grinder & Cups',
          invoiceAmountCents: 65_000,
          equipmentBudgetCents: 42_000,
          durationDays: 14,
          searchQueries: ['commercial espresso grinder', 'disposable paper coffee cups 8 oz'],
        },
      ],
    },
  },
  {
    id: 'game-booth',
    label: 'Indie Game Launch Booth ($1,200)',
    brief:
      'Launch booth for an indie video game at a gaming expo. Total client budget $1,200. Phase one is the booth display and signage, phase two is the playable demo station with a monitor and controllers.',
    plan: {
      projectName: 'Indie Game Launch Booth',
      totalBudgetCents: 120_000,
      phases: [
        {
          name: 'Booth Display & Signage',
          invoiceAmountCents: 40_000,
          equipmentBudgetCents: 26_000,
          durationDays: 7,
          searchQueries: ['retractable banner stand', 'trade show table cover'],
        },
        {
          name: 'Playable Demo Station',
          invoiceAmountCents: 80_000,
          equipmentBudgetCents: 52_000,
          durationDays: 10,
          searchQueries: ['24 inch gaming monitor', 'wireless game controller'],
        },
      ],
    },
  },
  {
    id: 'wedding-studio',
    label: 'Wedding Photo Studio ($950)',
    brief:
      'Pop-up photo studio for a wedding reception. Total client budget $950. First the backdrop and lighting setup, then a photo booth printer and props for guests.',
    plan: {
      projectName: 'Wedding Photo Studio',
      totalBudgetCents: 95_000,
      phases: [
        {
          name: 'Backdrop & Lighting Setup',
          invoiceAmountCents: 35_000,
          equipmentBudgetCents: 22_000,
          durationDays: 7,
          searchQueries: ['photography backdrop stand', 'LED softbox lighting kit'],
        },
        {
          name: 'Photo Booth Printer & Props',
          invoiceAmountCents: 60_000,
          equipmentBudgetCents: 39_000,
          durationDays: 10,
          searchQueries: ['instant photo printer', 'wedding photo booth props'],
        },
      ],
    },
  },
];

export const DEFAULT_PLAN = PRESETS[0].plan;
export const MAX_BRIEF_LENGTH = 1000;
