import { Injectable, Logger } from '@nestjs/common';
import { EnvService } from '../env/env.service';

type RevenueCatSubscriptionInterval = 'monthly' | 'yearly';
type MembershipOrigin = 'ios' | 'web';

export type RevenueCatActiveEntitlementSnapshot = {
  productIdentifier: string | null;
  purchaseDate: Date | null;
  expiresDate: Date | null;
  interval: RevenueCatSubscriptionInterval | null;
  cancelAtPeriodEnd: boolean;
  managementUrl: string | null;
  origin: MembershipOrigin;
};

type RevenueCatResolvedSubscription = {
  productIdentifier: string | null;
  purchaseDate: Date | null;
  expiresDate: Date | null;
  unsubscribeDetectedAt: Date | null;
};

@Injectable()
export class RevenueCatService {
  private readonly logger = new Logger(RevenueCatService.name);
  private readonly apiKey: string;
  private readonly stripe_key: string;
  private readonly baseUrl = 'https://api.revenuecat.com/v1';

  constructor( private env: EnvService) {
    // Retrieves the API key from your .env file
    this.apiKey = env.revenueCatApiKey;
    this.stripe_key = env.stripeRevenueCatApiKey;
  }

  async syncStripePurchase(appUserId: string, fetchToken: string, retries = 4): Promise<any> {
    if (!this.apiKey) {
      throw new Error('RevenueCat API key is missing from environment variables.');
    }

    const response = await fetch(`${this.baseUrl}/receipts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.stripe_key}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Platform': 'stripe',
      },
      body: JSON.stringify({
        app_user_id: appUserId,
        fetch_token: fetchToken,
      }),
    });

    if (!response.ok && response.status === 529) {
      if (retries > 0) {
        this.logger.warn(`RevenueCat Stripe sync failed (attempt ${4 - retries}): ${response.status} ${response.statusText}. Retrying...`);
        await new Promise(res => setTimeout(res, 1000 * (4 - retries)));
        return this.syncStripePurchase(appUserId, fetchToken, retries - 1);
      }
      const errorText = await response.text();
      throw new Error(`RevenueCat Stripe sync failed: ${response.status} ${response.statusText} ${errorText}`.trim());
    }

    return response.json();
  }

  /**
   * Checks if a user has a specific active entitlement.
   * * @param appUserId The unique ID of the user in your app/RevenueCat
   * @param entitlementId The specific entitlement identifier (e.g., 'premium')
   * @returns boolean True if the user has the active entitlement, false otherwise
   */
  async hasActiveEntitlement(appUserId: string, entitlementId: string): Promise<boolean> {
    if (!this.apiKey) {
      this.logger.error('RevenueCat API key is missing from environment variables.');
      return false;
    }

    try {
      return Boolean(await this.getActiveEntitlementSnapshot(appUserId, entitlementId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to check RevenueCat entitlements: ${message}`);
      return false;
    }
  }

  async getActiveEntitlementSnapshot(
    appUserId: string,
    entitlementId: string,
  ): Promise<RevenueCatActiveEntitlementSnapshot | null> {
    if (!this.apiKey) {
      this.logger.error('RevenueCat API key is missing from environment variables.');
      return null;
    }

    try {
      const data = await this.getSubscriberInfo(appUserId);
    
      if (!data) {
        return null;
      }

      const entitlement = data?.subscriber?.entitlements?.[entitlementId];
      if (!entitlement) {
        return null;
      }

      const managementUrl = this.parseManagementUrl(data?.subscriber?.management_url);
      const origin = this.inferMembershipOrigin(managementUrl);
      const resolvedSubscription = this.resolveEntitlementSubscriptionFromProduct(
        data?.subscriber,
        entitlement.product_identifier,
        entitlement,
      );
      const productIdentifier = resolvedSubscription.productIdentifier;
      const purchaseDate = resolvedSubscription.purchaseDate;
      const expiresDate = resolvedSubscription.expiresDate;
      const unsubscribeDetectedAt = resolvedSubscription.unsubscribeDetectedAt;
      const cancelAtPeriodEnd = origin === 'ios' && Boolean(unsubscribeDetectedAt);
   
      if (expiresDate && expiresDate.getTime() <= Date.now()) {
        return null;
      }
        
      return {
        productIdentifier,
        purchaseDate,
        expiresDate,
        interval: this.inferSubscriptionInterval(productIdentifier, purchaseDate, expiresDate),
        cancelAtPeriodEnd,
        managementUrl,
        origin,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to load RevenueCat entitlement snapshot: ${message}`);
      return null;
    }
  }

  private async getSubscriberInfo(appUserId: string) {
    const response = await fetch(`${this.baseUrl}/subscribers/${encodeURIComponent(appUserId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
      },
    });
    
    if (!response.ok) { 
      this.logger.error(`RevenueCat API error: ${response.status} ${response.statusText}`);
      return null;
    }
    
    return response.json();
  }

  private parseRevenueCatDate(value: unknown) {
    if (typeof value !== 'string' || !value.trim()) {
      return null;
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private parseManagementUrl(value: unknown) {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  private inferMembershipOrigin(managementUrl: string | null): MembershipOrigin {
    return managementUrl?.includes('apps.apple.com/account/subscriptions')
      ? 'ios'
      : 'web';
  }

  private resolveEntitlementSubscriptionFromProduct(
    subscriber: any,
    rawProductIdentifier: unknown,
    entitlement: any,
  ): RevenueCatResolvedSubscription {
    const productIdentifier = typeof rawProductIdentifier === 'string'
      ? rawProductIdentifier
      : null;
    const subscription = productIdentifier
      ? subscriber?.subscriptions?.[productIdentifier]
      : null;

    return {
      productIdentifier,
      purchaseDate: this.parseRevenueCatDate(
        subscription?.purchase_date
          || entitlement?.purchase_date
          || subscription?.original_purchase_date,
      ),
      expiresDate: this.parseRevenueCatDate(
        subscription?.expires_date
          || entitlement?.expires_date,
      ),
      unsubscribeDetectedAt: this.parseRevenueCatDate(subscription?.unsubscribe_detected_at),
    };
  }

  private inferSubscriptionInterval(
    productIdentifier: string | null,
    purchaseDate: Date | null,
    expiresDate: Date | null,
  ): RevenueCatSubscriptionInterval | null {
    if (productIdentifier === this.env.stripeProMonthlyProductId) {
      return 'monthly';
    }

    if (productIdentifier === this.env.stripeProYearlyProductId) {
      return 'yearly';
    }

    if (!purchaseDate || !expiresDate) {
      return null;
    }

    const durationDays = (expiresDate.getTime() - purchaseDate.getTime()) / (24 * 60 * 60 * 1000);
    return durationDays >= 90 ? 'yearly' : 'monthly';
  }
}