import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvService } from '../env/env.service';

@Injectable()
export class RevenueCatService {
  private readonly logger = new Logger(RevenueCatService.name);
  private readonly apiKey: string;
  private readonly baseUrl = 'https://api.revenuecat.com/v1';

  constructor( private env: EnvService) {
    // Retrieves the API key from your .env file
    this.apiKey = env.revenueCatApiKey;
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
      const response = await fetch(`${this.baseUrl}/subscribers/${appUserId}`, {
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
      const activeEntitlements = data?.subscriber?.entitlements?.active;

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