export enum PlanType {
  FREE = 'FREE',
  PRO = 'PRO',
}

/**
 * Sentinel value stored in MONTHLY_CREDITS for unlimited plans.
 * Any value of -1 means "no credit cap — usage is recorded for monitoring only".
 */
export const UNLIMITED_CREDITS = -1 as const;

export enum CreditCostType {
  PDF_PAGE = 'PDF_PAGE',
  AUDIO_MINUTE = 'AUDIO_MINUTE',
  IMAGE_UPLOAD = 'IMAGE_UPLOAD',
  QUIZ_GENERATION = 'QUIZ_GENERATION',
  TUTOR_CHAT_MESSAGE = 'TUTOR_CHAT_MESSAGE',
  TEXT_CHARACTERS = 'TEXT_CHARACTERS',
  SOLVE = 'SOLVE',
}

type CreditFactor = {
  credits: number;
  unitSize: number;
  minimumCharge?: number;
};

export const APP_LIMITS = {
  SUBSCRIPTIONS: {
    PRO_ENTITLEMENT_ID: 'SmartDeck Pro',
  },
  SYSTEM: {
    MAX_PASTE_CHARACTERS_PER_REQUEST: 10000,
    MAX_PDF_FILE_SIZE_MB: 15,
    MAX_AUDIO_FILE_SIZE_MB: 25,
    // Free plan: 30 credits per day, lazy-reset on first request after midnight UTC.
    FREE_PLAN_DAILY_CREDITS: 30,
  },
  MONTHLY_CREDITS: {
    [PlanType.FREE]: 30,   // daily allowance (reset each UTC day)
    // PRO is unlimited — use the UNLIMITED_CREDITS sentinel (-1).
    // Usage is still recorded for abuse monitoring.
    [PlanType.PRO]: -1,
  },
  QUIZ_GENERATION: {
    MIN_QUESTIONS_PER_DECK: 1,
    MAX_QUESTIONS_PER_DECK: {
      [PlanType.FREE]: 50,
      [PlanType.PRO]: 100,
    },
  },
  CREDIT_FACTORS: {
    [CreditCostType.PDF_PAGE]: { credits: 1, unitSize: 2, minimumCharge: 1 },
    [CreditCostType.AUDIO_MINUTE]: { credits: 2, unitSize: 1, minimumCharge: 2 },
    [CreditCostType.IMAGE_UPLOAD]: { credits: 8, unitSize: 1, minimumCharge: 8 },
    [CreditCostType.QUIZ_GENERATION]: { credits: 15, unitSize: 1, minimumCharge: 15 },
    [CreditCostType.TUTOR_CHAT_MESSAGE]: { credits: 3, unitSize: 1, minimumCharge: 3 },
    [CreditCostType.TEXT_CHARACTERS]: { credits: 1, unitSize: 2000, minimumCharge: 1 },
    // SOLVE costs the same as quiz generation — it calls Gemini with potentially
    // multiple images and produces a long-form structured response.
    [CreditCostType.SOLVE]: { credits: 18, unitSize: 1, minimumCharge: 18 },
  } satisfies Record<CreditCostType, CreditFactor>,
} as const;

export const normalizePlanType = (
  plan: PlanType | string | null | undefined,
): PlanType => {
  return Object.values(PlanType).includes(plan as PlanType)
    ? (plan as PlanType)
    : PlanType.FREE;
};

export const getMonthlyCreditsForPlan = (
  plan: PlanType | string | null | undefined,
): number => {
  return APP_LIMITS.MONTHLY_CREDITS[normalizePlanType(plan)];
};

/** Alias that makes the daily-reset semantics explicit at call sites. */
export const getDailyCreditsForPlan = getMonthlyCreditsForPlan;

export const isUnlimitedPlan = (
  plan: PlanType | string | null | undefined,
): boolean => {
  return getMonthlyCreditsForPlan(plan) === UNLIMITED_CREDITS;
};

export const getMaxQuestionsPerDeckForPlan = (
  plan: PlanType | string | null | undefined,
): number => {
  return APP_LIMITS.QUIZ_GENERATION.MAX_QUESTIONS_PER_DECK[normalizePlanType(plan)];
};

export const calculateCreditsForUnits = (
  type: CreditCostType,
  units: number,
): number => {
  if (!Number.isFinite(units) || units <= 0) {
    return 0;
  }

  const factor = APP_LIMITS.CREDIT_FACTORS[type];
  const billedUnits = Math.ceil(units / factor.unitSize);
  const rawCredits = billedUnits * factor.credits;

  return Math.max(factor.minimumCharge ?? 0, rawCredits);
};

export const getRemainingCredits = (
  monthlyCredits: number,
  creditsUsed: number,
): number => {
  // Unlimited plans: return sentinel so callers can detect it.
  if (monthlyCredits === UNLIMITED_CREDITS) return UNLIMITED_CREDITS;
  return Math.max(monthlyCredits - creditsUsed, 0);
};