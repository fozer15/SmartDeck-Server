import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
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

  @Post('webhooks/stripe')
  @HttpCode(200)
  handleStripeWebhook(@Req() req: any) {
    return this.billingService.handleStripeWebhook(
      req.headers['stripe-signature'],
      req.rawBody,
    );
  }
}