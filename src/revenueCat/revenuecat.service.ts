import { Injectable, Logger } from '@nestjs/common';
import { EnvService } from '../env/env.service';

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

  async syncStripePurchase(appUserId: string, fetchToken: string, retries = 3): Promise<any> {
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
      const response = await fetch(`${this.baseUrl}/subscribers/${encodeURIComponent(appUserId)}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Accept': 'application/json',
        },
      });
     
      if (!response.ok) {
        this.logger.error(`RevenueCat API error: ${response.status} ${response.statusText}`);
        return false;
      }

      const data = await response.json();
      
      // Navigate the response safely to find active entitlements
      const activeEntitlements = data?.subscriber?.entitlements;

      // If the specific entitlement exists in the 'active' object, return true
      if (activeEntitlements && activeEntitlements[entitlementId]) {
        return true;
      }

      return false;
    } catch (error) {
      this.logger.error(`Failed to check RevenueCat entitlements: ${error.message}`);
      return false;
    }
  }
}