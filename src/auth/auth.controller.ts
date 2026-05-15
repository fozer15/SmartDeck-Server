import { Body, Controller, Post, Res } from '@nestjs/common';
import { AuthService } from './auth.service';
import { SignInDto } from './dto/sign-in.dto';
import type { Response } from 'express';
import { AUTH_TOKEN_COOKIE } from './auth.constants';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('sign-in')
  async signIn(@Body() dto: SignInDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.authService.signIn(dto.idToken);
    this.setAuthCookie(response, result.accessToken);
    return result;
  }

  // Sign-up uses the same endpoint - Firebase handles the difference
  @Post('sign-up')
  async signUp(@Body() dto: SignInDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.authService.signIn(dto.idToken);
    this.setAuthCookie(response, result.accessToken);
    return result;
  }

  @Post('sign-out')
  signOut(@Res({ passthrough: true }) response: Response) {
    response.clearCookie(AUTH_TOKEN_COOKIE, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
    });

    return { success: true };
  }

  private setAuthCookie(response: Response, token: string) {
    response.cookie(AUTH_TOKEN_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 1000,
    });
  }
}
