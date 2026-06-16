import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RevenueCatService } from '../revenueCat/revenuecat.service';
import { EnvService } from '../env/env.service';
import {
  APP_LIMITS,
  PlanType,
  getMonthlyCreditsForPlan,
  getRemainingCredits,
} from '../config/plan-limits';
import Stripe from 'stripe';

type CreditSummary = {
  plan: PlanType;
  monthlyCredits: number;
  creditsUsed: number;
  remainingCredits: number;
};

type BillingInterval = 'monthly' | 'yearly';

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  private readonly stripe: Stripe | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly revenueCat: RevenueCatService,
    private readonly env: EnvService,
  ) {
    this.stripe = this.env.stripeSecretKey
      ? new Stripe(this.env.stripeSecretKey)
      : null;
  }

  async createCheckoutSession(userId: string, email: string | undefined, interval: BillingInterval, returnPath?: string) {
    const stripe = this.getStripeClient();
    const priceId = this.getPriceIdForInterval(interval);
    const plan = await this.resolvePlan(userId);

    if (plan === PlanType.PRO) {
      throw new ForbiddenException('User is already on the Pro plan.');
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      allow_promotion_codes: true,
      client_reference_id: userId,
      customer_email: email,
      success_url: this.buildCheckoutReturnUrl(returnPath, 'success'),
      cancel_url: this.buildCheckoutReturnUrl(returnPath, 'canceled'),
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      metadata: {
        appUserId: userId,
        billingInterval: interval,
      },
      subscription_data: {
        metadata: {
          appUserId: userId,
          billingInterval: interval,
        },
      },
    });

    if (!session.url) {
      throw new InternalServerErrorException('Stripe checkout session did not return a redirect URL.');
    }

    return {
      url: session.url,
      id: session.id,
    };
  }

  async handleStripeWebhook(signature: string | undefined, rawBody: Buffer | undefined) {
    const stripe = this.getStripeClient();
    console.log('Received Stripe webhook event');
    if (!this.env.stripeWebhookSecret) {
      throw new ServiceUnavailableException('Stripe webhook secret is not configured.');
    }

    if (!signature) {
      throw new BadRequestException('Missing Stripe signature header.');
    }

    if (!rawBody) {
      throw new BadRequestException('Missing raw Stripe webhook body.');
    }

    let event: Stripe.Event;

    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, this.env.stripeWebhookSecret);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Stripe webhook signature error.';
      throw new BadRequestException(message);
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        this.logger.debug(`Processing Stripe checkout session completed event for session ${session.id}`);
        await this.syncCheckoutSessionToRevenueCat(session);
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        await this.syncSubscriptionToRevenueCat(subscription);
        break;
      }
      default:
        this.logger.debug(`Ignoring Stripe event ${event.type}`);
    }

    return { received: true };
  }

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

  private getStripeClient() {
    if (!this.stripe) {
      throw new ServiceUnavailableException('Stripe secret key is not configured.');
    }

    return this.stripe;
  }

  private getPriceIdForInterval(interval: BillingInterval) {
    const priceId = interval === 'yearly'
      ? this.env.stripeProYearlyPriceId
      : this.env.stripeProMonthlyPriceId;

    if (!priceId) {
      throw new ServiceUnavailableException(`Stripe price ID for ${interval} billing is not configured.`);
    }

    return priceId;
  }

  private buildCheckoutReturnUrl(returnPath: string | undefined, checkoutState: 'success' | 'canceled') {
    const safeReturnPath = typeof returnPath === 'string' && returnPath.startsWith('/')
      ? returnPath
      : '/decks';
    const url = new URL(safeReturnPath, `${this.env.clientAppUrl}/`);
    url.searchParams.set('checkout', checkoutState);
    return url.toString();
  }

  private async syncCheckoutSessionToRevenueCat(session: Stripe.Checkout.Session) {
    const appUserId = session.metadata?.appUserId || session.client_reference_id || undefined;
    
    const fetchToken = this.getStripeFetchTokenFromCheckoutSession(session);

    if (!appUserId || !fetchToken) {
      this.logger.warn(`Skipping RevenueCat sync for checkout session ${session.id} because appUserId or fetch token is missing.`);
      return;
    }

    await this.revenueCat.syncStripePurchase(appUserId, fetchToken);
  }

  private async syncSubscriptionToRevenueCat(subscription: Stripe.Subscription) {
    const appUserId = subscription.metadata?.appUserId;

    if (!appUserId) {
      this.logger.warn(`Skipping RevenueCat sync for Stripe subscription ${subscription.id} because appUserId metadata is missing.`);
      return;
    }

    await this.revenueCat.syncStripePurchase(appUserId, subscription.id);
  }

  private getStripeFetchTokenFromCheckoutSession(session: Stripe.Checkout.Session) {
    if (typeof session.subscription === 'string') {
      return session.subscription;
    }

    if (session.subscription && typeof session.subscription === 'object' && 'id' in session.subscription) {
      return session.subscription.id;
    }

    return session.id;
  }
}