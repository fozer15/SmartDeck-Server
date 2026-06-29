import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RevenueCatService } from '../revenueCat/revenuecat.service';
import type { RevenueCatActiveEntitlementSnapshot } from '../revenueCat/revenuecat.service';
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
type MembershipOrigin = 'ios' | 'web';

type MembershipStatus = {
  plan: PlanType;
  subscriptionId: string | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: number | null;
  origin: MembershipOrigin | null;
  managementUrl: string | null;
};

type RevenueCatRenewalInterval = 'monthly' | 'yearly';

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

    const existingSubscription = await this.findLatestCancelableSubscriptionForUser(stripe, userId);

    if (existingSubscription) {
      throw new ForbiddenException('User already has an active Pro subscription.');
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
      automatic_tax: { 
      enabled: true 
      },
      billing_address_collection: 'required',
    });

    if (!session.url) {
      throw new InternalServerErrorException('Stripe checkout session did not return a redirect URL.');
    }

    return {
      url: session.url,
      id: session.id,
    };
  }

  async cancelMembership(userId: string) {
    const stripe = this.getStripeClient();
    const plan = await this.resolvePlan(userId);

    if (plan !== PlanType.PRO) {
      throw new BadRequestException('User does not have an active Pro membership.');
    }

    const subscription = await this.findLatestCancelableSubscriptionForUser(stripe, userId);

    if (!subscription) {
      throw new NotFoundException('No active Stripe subscription found for this user.');
    }

    if (subscription.cancel_at_period_end) {
      return this.buildMembershipCancellationResponse(subscription, true);
    }

    const updatedSubscription = await stripe.subscriptions.update(subscription.id, {
      cancel_at_period_end: true,
    });

    await this.syncSubscriptionToRevenueCat(updatedSubscription);

    return this.buildMembershipCancellationResponse(updatedSubscription, false);
  }

  async renewMembership(userId: string) {
    const stripe = this.getStripeClient();
    const plan = await this.resolvePlan(userId);

    if (plan !== PlanType.PRO) {
      throw new BadRequestException('User does not have an active Pro membership.');
    }

    const subscription = await this.findLatestCancelableSubscriptionForUser(stripe, userId);

    if (!subscription) {
      throw new NotFoundException('No active Stripe subscription found for this user.');
    }

    if (!subscription.cancel_at_period_end) {
      return this.buildMembershipRenewalResponse(subscription, true);
    }

    const updatedSubscription = await stripe.subscriptions.update(subscription.id, {
      cancel_at_period_end: false,
    });

    await this.syncSubscriptionToRevenueCat(updatedSubscription);

    return this.buildMembershipRenewalResponse(updatedSubscription, false);
  }

  async getMembershipStatus(userId: string): Promise<MembershipStatus> {
    const subscription = this.stripe
      ? await this.findLatestCancelableSubscriptionForUser(this.stripe, userId)
      : null;
    const entitlementSnapshot = await this.getValidatedEntitlementSnapshot(userId, subscription);
    
    const fallbackCurrentPeriodEnd = entitlementSnapshot?.expiresDate
      ? Math.floor(entitlementSnapshot.expiresDate.getTime() / 1000)
      : null;

    if (!this.stripe) {
      return {
        plan: entitlementSnapshot ? PlanType.PRO : PlanType.FREE,
        subscriptionId: null,
        cancelAtPeriodEnd: Boolean(entitlementSnapshot?.cancelAtPeriodEnd),
        currentPeriodEnd: fallbackCurrentPeriodEnd,
        origin: entitlementSnapshot?.origin || null,
        managementUrl: entitlementSnapshot?.managementUrl || null,
      };
    }

    const plan = entitlementSnapshot ? PlanType.PRO : PlanType.FREE;
    const origin = entitlementSnapshot?.origin || (subscription ? 'web' : null);
    const managementUrl = entitlementSnapshot?.managementUrl || null;

    if (!subscription) {
      return {
        plan,
        subscriptionId: null,
        cancelAtPeriodEnd: Boolean(entitlementSnapshot?.cancelAtPeriodEnd),
        currentPeriodEnd: fallbackCurrentPeriodEnd,
        origin,
        managementUrl,
      };
    }

    return {
      plan,
      subscriptionId: subscription.id,
      cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
      currentPeriodEnd: this.getSubscriptionCurrentPeriodEnd(subscription) || fallbackCurrentPeriodEnd,
      origin,
      managementUrl,
    };
  }

  async handleStripeWebhook(signature: string | undefined, rawBody: Buffer | undefined) {
    const stripe = this.getStripeClient();
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
    const hasProEntitlement = Boolean(await this.getValidatedEntitlementSnapshot(userId));

    return hasProEntitlement ? PlanType.PRO : PlanType.FREE;
  }

  async getCreditSummary(userId: string): Promise<CreditSummary> {
    // Plan resolution (RevenueCat HTTP) and usage record (DB) are independent —
    // fan them out in parallel, then apply the lazy reset if needed.
    const [plan, usage] = await Promise.all([
      this.resolvePlan(userId),
      this.getUsageRecord(userId),
    ]);

    const effectiveUsage = await this.applyLazyResetIfNeeded(userId, plan, usage);
    return this.buildCreditSummary(plan, effectiveUsage.creditsUsed);
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

    // Fetch plan + usage in parallel, then run the lazy-reset side effect.
    const [plan, usage] = await Promise.all([
      this.resolvePlan(userId),
      this.getUsageRecord(userId),
    ]);
    await this.applyLazyResetIfNeeded(userId, plan, usage);

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

  /**
   * Resets the user's monthly credit usage and stamps a new lastResetDate.
   * Used by RevenueCat renewal events and internal lazy reset flows.
   */
  async resetUserCredits(userId: string): Promise<CreditSummary> {
    const plan = await this.resolvePlan(userId);

    const updatedUsage = await this.applyCreditReset(userId, new Date(), `manual:${plan}`);
    return this.buildCreditSummary(plan, updatedUsage.creditsUsed);
  }

  /**
    * RevenueCat sends an event for every successful renewal / purchase / refund.
    * We only accept safe cycle-start events here and derive the interval from the
    * canonical subscriber snapshot to avoid product-change abuse.
   *
   * @see https://www.revenuecat.com/docs/integrations/webhooks/event-types
   */
  async handleRevenueCatWebhook(authHeader: string | undefined, body: any) {
    const expectedAuth = this.env.revenueCatWebhookAuth;
    if (!expectedAuth) {
      throw new ServiceUnavailableException('RevenueCat webhook auth secret is not configured.');
    }

    if (!authHeader || authHeader !== `Bearer ${expectedAuth}` && authHeader !== expectedAuth) {
      throw new UnauthorizedException('Invalid RevenueCat webhook authorization header.');
    }

    const event = body?.event;
    if (!event || typeof event !== 'object') {
      throw new BadRequestException('Invalid RevenueCat webhook payload: missing event.');
    }

    const eventType: string = event.type;
    const appUserId: string | undefined =
      event.app_user_id || event.original_app_user_id || event.aliases?.[0];

    if (!appUserId) {
      this.logger.warn(`Ignoring RevenueCat ${eventType} event with no app_user_id.`);
      return { received: true, ignored: true, reason: 'missing_app_user_id' };
    }

    // Events that should grant a fresh credit allowance.
    const creditGrantingEvents = new Set([
      'INITIAL_PURCHASE',
      'RENEWAL',
    ]);

    if (!creditGrantingEvents.has(eventType)) {
      this.logger.debug(`Ignoring RevenueCat event type "${eventType}" for user ${appUserId}.`);
      return { received: true, ignored: true, reason: `unsupported_event:${eventType}` };
    }

    // Make sure the user actually exists before touching usage records.
    const user = await this.prisma.user.findUnique({
      where: { id: appUserId },
      select: { id: true },
    });

    if (!user) {
      this.logger.warn(`RevenueCat ${eventType} for unknown user ${appUserId}, skipping reset.`);
      return { received: true, ignored: true, reason: 'unknown_user' };
    }

    const cycleStartedAt = this.getRevenueCatEventCycleStart(event)
      || await this.getRevenueCatEntitlementCycleStart(appUserId)
      || new Date();
    const lastResetTime = (await this.getUsageRecord(appUserId)).lastResetDate?.getTime() || 0;

    if (cycleStartedAt.getTime() <= lastResetTime) {
      this.logger.debug(`Ignoring RevenueCat ${eventType} for user ${appUserId} because cycle ${cycleStartedAt.toISOString()} was already applied.`);
      return { received: true, ignored: true, reason: 'already_reset_for_cycle' };
    }

    if (eventType === 'RENEWAL') {
      const renewalInterval = this.getRevenueCatEventInterval(event)
        || await this.getRevenueCatRenewalInterval(appUserId);

      if (renewalInterval !== 'monthly') {
        this.logger.debug(`Ignoring RevenueCat RENEWAL for user ${appUserId} because interval is ${renewalInterval || 'unknown'}.`);
        return { received: true, ignored: true, reason: `unsupported_interval:${renewalInterval || 'unknown'}` };
      }
    }

    await this.applyCreditReset(appUserId, cycleStartedAt, `revenuecat:${eventType}`);
    return { received: true, reset: true, eventType, appUserId };
  }

  /**
   * Applies any due lazy reset for free users and yearly subscribers using an
   * already-loaded usage record (so callers can fetch plan + usage in parallel).
   * Returns the (possibly refreshed) usage record.
   */
  private async applyLazyResetIfNeeded(
    userId: string,
    plan: PlanType,
    usage: { creditsUsed: number; lastResetDate: Date | null },
  ) {
    const nextResetAt = plan === PlanType.FREE
      ? this.getLatestFreePlanResetBoundary(usage.lastResetDate)
      : await this.getLatestYearlyPlanResetBoundary(userId, usage.lastResetDate);

    if (!nextResetAt) {
      return usage;
    }

    const refreshed = await this.prisma.userUsageLimit.update({
      where: { userId },
      data: {
        creditsUsed: 0,
        lastResetDate: nextResetAt,
      },
    });

    this.logger.log(`Lazy-reset credits for user ${userId} (plan=${plan}, resetAt=${nextResetAt.toISOString()}).`);
    return refreshed;
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

  private getLatestFreePlanResetBoundary(lastResetDate: Date | string | null | undefined) {
    const anchor = this.normalizeResetAnchor(lastResetDate);
    return this.getLatestMonthlyBoundary(
      anchor,
      Date.now(),
      Number.POSITIVE_INFINITY,
      APP_LIMITS.SYSTEM.FREE_PLAN_RESET_INTERVAL_MONTHS,
    );
  }

  private async getLatestYearlyPlanResetBoundary(userId: string, lastResetDate: Date | string | null | undefined) {
    const activeEntitlement = await this.getValidatedEntitlementSnapshot(userId);

    if (!activeEntitlement || activeEntitlement.interval !== 'yearly') {
      return null;
    }

    if (!activeEntitlement.purchaseDate || !activeEntitlement.expiresDate) {
      return null;
    }

    const annualPeriodStart = activeEntitlement.purchaseDate;
    const annualPeriodEndMs = activeEntitlement.expiresDate.getTime();
    const lastResetTime = this.normalizeResetAnchor(lastResetDate).getTime();

    if (annualPeriodStart.getTime() > lastResetTime) {
      return annualPeriodStart;
    }

    const monthlyBoundary = this.getLatestMonthlyBoundary(
      annualPeriodStart,
      Date.now(),
      annualPeriodEndMs,
    );

    return monthlyBoundary && monthlyBoundary.getTime() > lastResetTime
      ? monthlyBoundary
      : null;
  }

  private async getRevenueCatRenewalInterval(userId: string): Promise<RevenueCatRenewalInterval | null> {
    const activeEntitlement = await this.getValidatedEntitlementSnapshot(userId);

    return activeEntitlement?.interval || null;
  }

  private async getRevenueCatEntitlementCycleStart(userId: string) {
    const activeEntitlement = await this.getValidatedEntitlementSnapshot(userId);

    return activeEntitlement?.purchaseDate || null;
  }

  private getRevenueCatEventCycleStart(event: any) {
    const purchasedAtMs = Number(event?.purchased_at_ms || 0);
    if (!Number.isFinite(purchasedAtMs) || purchasedAtMs <= 0) {
      return null;
    }

    const date = new Date(purchasedAtMs);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private getRevenueCatEventInterval(event: any): RevenueCatRenewalInterval | null {
    const productId = typeof event?.product_id === 'string' ? event.product_id : null;

    if (productId === this.env.stripeProMonthlyPriceId) {
      return 'monthly';
    }

    if (productId === this.env.stripeProYearlyPriceId) {
      return 'yearly';
    }

    const purchasedAtMs = Number(event?.purchased_at_ms || 0);
    const expirationAtMs = Number(event?.expiration_at_ms || 0);
    if (!Number.isFinite(purchasedAtMs) || !Number.isFinite(expirationAtMs) || purchasedAtMs <= 0 || expirationAtMs <= 0) {
      return null;
    }

    const durationDays = (expirationAtMs - purchasedAtMs) / (24 * 60 * 60 * 1000);
    return durationDays >= 90 ? 'yearly' : 'monthly';
  }

  private normalizeResetAnchor(value: Date | string | null | undefined) {
    const parsed = value ? new Date(value) : new Date();
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }

  private async applyCreditReset(userId: string, resetAt: Date, reason: string) {
    const updatedUsage = await this.prisma.userUsageLimit.upsert({
      where: { userId },
      update: {
        creditsUsed: 0,
        lastResetDate: resetAt,
      },
      create: {
        userId,
        creditsUsed: 0,
        lastResetDate: resetAt,
      },
    });

    this.logger.log(`Reset credits for user ${userId} (reason=${reason}, resetAt=${resetAt.toISOString()}).`);
    return updatedUsage;
  }

  private getLatestMonthlyBoundary(
    anchor: Date,
    effectiveNowMs: number,
    upperBoundMs = Number.POSITIVE_INFINITY,
    stepMonths = 1,
  ) {
    let currentBoundary = new Date(anchor);
    let nextBoundary = this.addMonthsClamped(anchor, stepMonths);

    while (nextBoundary.getTime() <= effectiveNowMs && nextBoundary.getTime() < upperBoundMs) {
      currentBoundary = nextBoundary;
      nextBoundary = this.addMonthsClamped(nextBoundary, stepMonths);
    }

    return currentBoundary.getTime() > anchor.getTime()
      ? currentBoundary
      : null;
  }

  private addMonthsClamped(date: Date, months: number) {
    const next = new Date(date);
    const originalDay = next.getUTCDate();
    const originalHours = next.getUTCHours();
    const originalMinutes = next.getUTCMinutes();
    const originalSeconds = next.getUTCSeconds();
    const originalMilliseconds = next.getUTCMilliseconds();

    next.setUTCDate(1);
    next.setUTCMonth(next.getUTCMonth() + months);

    const lastDayOfTargetMonth = new Date(Date.UTC(
      next.getUTCFullYear(),
      next.getUTCMonth() + 1,
      0,
    )).getUTCDate();

    next.setUTCDate(Math.min(originalDay, lastDayOfTargetMonth));
    next.setUTCHours(originalHours, originalMinutes, originalSeconds, originalMilliseconds);
    return next;
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

  private async findLatestCancelableSubscriptionForUser(stripe: Stripe, userId: string) {
    const subscriptions = await stripe.subscriptions.list({
      status: 'all',
      limit: 100,
    });

    const cancellableStatuses = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete']);
  
    return subscriptions.data
      .filter((subscription) => subscription.metadata?.appUserId === userId)
      .filter((subscription) => cancellableStatuses.has(subscription.status))
      .sort((left, right) => right.created - left.created)[0] || null;
  }

  private buildMembershipCancellationResponse(subscription: Stripe.Subscription, alreadyScheduled: boolean) {
    const currentPeriodEnd = this.getSubscriptionCurrentPeriodEnd(subscription);

    return {
      status: alreadyScheduled ? 'already_scheduled' : 'cancel_scheduled',
      subscriptionId: subscription.id,
      cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
      currentPeriodEnd,
    };
  }

  private buildMembershipRenewalResponse(subscription: Stripe.Subscription, alreadyActive: boolean) {
    return {
      status: alreadyActive ? 'already_active' : 'renewed',
      subscriptionId: subscription.id,
      cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
      currentPeriodEnd: this.getSubscriptionCurrentPeriodEnd(subscription),
    };
  }

  private async getValidatedEntitlementSnapshot(
    userId: string,
    subscription?: Stripe.Subscription | null,
  ): Promise<RevenueCatActiveEntitlementSnapshot | null> {
    const entitlement = await this.revenueCat.getActiveEntitlementSnapshot(
      userId,
      APP_LIMITS.SUBSCRIPTIONS.PRO_ENTITLEMENT_ID,
    );

    if (!this.stripe) {
      return entitlement;
    }

    const activeSubscription = subscription === undefined
      ? await this.findLatestCancelableSubscriptionForUser(this.stripe, userId)
      : subscription;

    return this.validateWebEntitlementAgainstStripeSubscription(
      userId,
      entitlement,
      activeSubscription,
    );
  }

  private validateWebEntitlementAgainstStripeSubscription(
    userId: string,
    entitlement: RevenueCatActiveEntitlementSnapshot | null,
    subscription: Stripe.Subscription | null,
  ) {
    if (!entitlement || entitlement.origin !== 'web') {
      return entitlement;
    }
    
    if (!subscription) {
      this.logger.warn(
        `Ignoring RevenueCat web entitlement for user ${userId} because no matching Stripe subscription was found.`,
      );
      return null;
    }

    const stripeProductId = this.getTrustedStripeProductIdentifier(subscription);
    if (!stripeProductId) {
      this.logger.warn(
        `Ignoring RevenueCat web entitlement for user ${userId} because Stripe subscription ${subscription.id} does not contain a trusted SmartDeck product.`,
      );
      return null;
    }

    return {
      ...entitlement,
      productIdentifier: stripeProductId,
      interval: this.getIntervalForStripeProductIdentifier(stripeProductId) || entitlement.interval,
    };
  }

  private getTrustedStripeProductIdentifier(subscription: Stripe.Subscription) {
    const trustedProductIds = new Set([
      this.env.stripeProMonthlyProductId,
      this.env.stripeProYearlyProductId,
    ].filter((productId): productId is string => typeof productId === 'string' && productId.length > 0));

    const stripeProductIds = subscription.items.data
      .map((item) => {
        const product = item.price?.product;

        if (typeof product === 'string' && product.length > 0) {
          return product;
        }

        if (product && typeof product === 'object' && 'id' in product && typeof product.id === 'string') {
          return product.id;
        }

        return null;
      })
      .filter((productId): productId is string => typeof productId === 'string' && productId.length > 0);

    return stripeProductIds.find((productId) => trustedProductIds.has(productId)) || null;
  }

  private getIntervalForStripeProductIdentifier(productIdentifier: string): RevenueCatRenewalInterval | null {
    if (productIdentifier === this.env.stripeProMonthlyProductId) {
      return 'monthly';
    }

    if (productIdentifier === this.env.stripeProYearlyProductId) {
      return 'yearly';
    }

    return null;
  }

  private getSubscriptionCurrentPeriodEnd(subscription: Stripe.Subscription) {
    return Number((subscription as any)?.cancel_at || 0)
      || Number((subscription as any)?.current_period_end || 0)
      || null;
  }
}