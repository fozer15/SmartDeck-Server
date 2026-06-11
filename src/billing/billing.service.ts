import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RevenueCatService } from '../revenueCat/revenuecat.service';
import {
  APP_LIMITS,
  PlanType,
  getMonthlyCreditsForPlan,
  getRemainingCredits,
} from '../config/plan-limits';

type CreditSummary = {
  plan: PlanType;
  monthlyCredits: number;
  creditsUsed: number;
  remainingCredits: number;
};

@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly revenueCat: RevenueCatService,
  ) {}

  async resolvePlan(userId: string): Promise<PlanType> {
    const hasProEntitlement = await this.revenueCat.hasActiveEntitlement(
      userId,
      APP_LIMITS.SUBSCRIPTIONS.PRO_ENTITLEMENT_ID,
    );

    return hasProEntitlement ? PlanType.PRO : PlanType.FREE;
  }

  async getCreditSummary(userId: string): Promise<CreditSummary> {
    const [plan, usage] = await Promise.all([
      this.resolvePlan(userId),
      this.getUsageRecord(userId),
    ]);

    return this.buildCreditSummary(plan, usage.creditsUsed);
  }

  async canAffordCredits(userId: string, credits: number): Promise<CreditSummary & { canAfford: boolean }> {
    const summary = await this.getCreditSummary(userId);

    return {
      ...summary,
      canAfford: credits <= 0 || summary.remainingCredits >= credits,
    };
  }

  async consumeCredits(userId: string, credits: number, reason = 'Operation'): Promise<CreditSummary> {
    if (credits <= 0) {
      return this.getCreditSummary(userId);
    }

    const plan = await this.resolvePlan(userId);
    const monthlyCredits = getMonthlyCreditsForPlan(plan);

    return this.prisma.$transaction(async (tx) => {
      const usage = await tx.userUsageLimit.findUnique({
        where: { userId },
      });

      if (!usage) {
        throw new NotFoundException('User usage records not found.');
      }

      const remainingCredits = getRemainingCredits(monthlyCredits, usage.creditsUsed);
      if (remainingCredits < credits) {
        throw new ForbiddenException(
          `${reason} requires ${credits} credits, but only ${remainingCredits} credits remain this month.`,
        );
      }

      const updatedUsage = await tx.userUsageLimit.update({
        where: { userId },
        data: {
          creditsUsed: {
            increment: credits,
          },
        },
      });

      return this.buildCreditSummary(plan, updatedUsage.creditsUsed);
    });
  }

  private async getUsageRecord(userId: string) {
    const usage = await this.prisma.userUsageLimit.findUnique({
      where: { userId },
    });

    if (!usage) {
      throw new NotFoundException('User usage records not found.');
    }

    return usage;
  }

  private buildCreditSummary(plan: PlanType, creditsUsed: number): CreditSummary {
    const monthlyCredits = getMonthlyCreditsForPlan(plan);

    return {
      plan,
      monthlyCredits,
      creditsUsed,
      remainingCredits: getRemainingCredits(monthlyCredits, creditsUsed),
    };
  }
}