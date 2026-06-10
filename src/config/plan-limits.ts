// src/config/limits.ts

// Define our subscription plans
export enum PlanType {
  FREE = 'FREE',
  PRO = 'PRO',
  // Future plans such as 'ENTERPRISE' or 'STUDENT' can be added here
}

// Application-wide limit rules (Single Source of Truth)
export const APP_LIMITS = {
  
  // 1. SECURITY AND API LIMITS
  // System-wide limits independent of user subscription plans
  SYSTEM: {
    MAX_PASTE_CHARACTERS_PER_REQUEST: 10000, // Maximum characters allowed per text paste
    MAX_PDF_FILE_SIZE_MB: 15,                // Maximum PDF file size
    MAX_AUDIO_FILE_SIZE_MB: 25,             // Maximum audio file size
    AI_CREDIT_COST_PER_TEXT_PASTE: 1,       // AI credit cost per text paste operation
  },

  // 2. MONTHLY USAGE QUOTAS (Plan-based)
  MONTHLY_QUOTAS: {
    [PlanType.FREE]: {
      pdfPages: 100,
      audioMinutes: 30,
      aiCredits: 5,
      image: 20,
      tutorChat: 20,
      textCharcter: 50000 // this is for "paste from notes" option
    },
    [PlanType.PRO]: {
      pdfPages: 1000,      // Higher limits for PRO users
      audioMinutes: 300,
      aiCredits: 100,
      tutorChat:1000,
      image: 100,
      textCharacter:200000
    },
  }
} as const; // Makes values immutable (readonly) in TypeScript

// 3. HELPER FUNCTIONS
// Simplifies limit retrieval in the backend
export const getLimitsForPlan = (
  plan: PlanType | string | null | undefined
) => {
  // Fallback to FREE if the plan is undefined or invalid
  const validPlan = Object.values(PlanType).includes(plan as PlanType)
    ? (plan as PlanType)
    : PlanType.FREE;

  return APP_LIMITS.MONTHLY_QUOTAS[validPlan];
};