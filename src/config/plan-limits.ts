export enum PlanType {
  FREE = 'FREE',
  PRO = 'PRO',
}

export enum CreditCostType {
  PDF_PAGE = 'PDF_PAGE',
  AUDIO_MINUTE = 'AUDIO_MINUTE',
  IMAGE_UPLOAD = 'IMAGE_UPLOAD',
  QUIZ_GENERATION = 'QUIZ_GENERATION',
  TUTOR_CHAT_MESSAGE = 'TUTOR_CHAT_MESSAGE',
  TEXT_CHARACTERS = 'TEXT_CHARACTERS',
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
  },
  MONTHLY_CREDITS: {
    [PlanType.FREE]: 250,
    [PlanType.PRO]: 2500,
  },
  CREDIT_FACTORS: {
    [CreditCostType.PDF_PAGE]: { credits: 1, unitSize: 2, minimumCharge: 1 },
    [CreditCostType.AUDIO_MINUTE]: { credits: 2, unitSize: 1, minimumCharge: 2 },
    [CreditCostType.IMAGE_UPLOAD]: { credits: 8, unitSize: 1, minimumCharge: 8 },
    [CreditCostType.QUIZ_GENERATION]: { credits: 15, unitSize: 1, minimumCharge: 15 },
    [CreditCostType.TUTOR_CHAT_MESSAGE]: { credits: 3, unitSize: 1, minimumCharge: 3 },
    [CreditCostType.TEXT_CHARACTERS]: { credits: 1, unitSize: 2000, minimumCharge: 1 },
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
  return Math.max(monthlyCredits - creditsUsed, 0);
};