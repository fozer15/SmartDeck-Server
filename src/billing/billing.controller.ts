import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { BillingService } from './billing.service';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';

@Controller('billing')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Post('checkout-session')
  @UseGuards(AuthGuard)
  createCheckoutSession(@Req() req: any, @Body() body: CreateCheckoutSessionDto) {
    return this.billingService.createCheckoutSession(
      req.user.uid,
      req.user.email,
      body.interval,
      body.returnPath,
    );
  }

  @Post('cancel-membership')
  @UseGuards(AuthGuard)
  cancelMembership(@Req() req: any) {
    return this.billingService.cancelMembership(req.user.uid);
  }

  @Post('renew-membership')
  @UseGuards(AuthGuard)
  renewMembership(@Req() req: any) {
    return this.billingService.renewMembership(req.user.uid);
  }

  @Get('membership-status')
  @UseGuards(AuthGuard)
  getMembershipStatus(@Req() req: any) {
    return this.billingService.getMembershipStatus(req.user.uid);
  }

  @Post('webhooks/stripe')
  @HttpCode(200)
  handleStripeWebhook(@Req() req: any) {
    return this.billingService.handleStripeWebhook(
      req.headers['stripe-signature'],
      req.rawBody,
    );
  }
}