import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, StreamableFile, UnauthorizedException, UseGuards } from '@nestjs/common';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { AuthGuard } from '../auth/auth.guard';
import { AppLanguage } from '@prisma/client';
import { AuthService } from '../auth/auth.service';
import type { Response } from 'express';
import { AUTH_TOKEN_COOKIE } from '../auth/auth.constants';

@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly authService: AuthService,
  ) {}

  @Post()
  findOrCreate(@Body() dto: CreateUserDto) {
    return this.usersService.findOrCreate(dto);
  }

  @Get()
  findAll() {
    return this.usersService.findAll();
  }

  @Get('search')
  @UseGuards(AuthGuard)
  searchUsers(@Req() req: any, @Query('q') q?: string) {
    return this.usersService.searchByName(req.user.uid, q || '');
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.usersService.findOne(id);
  }

  @Get(':id/avatar')
  async getAvatar(@Param('id') id: string, @Req() req: any, @Res({ passthrough: true }) response: Response) {
    const avatar = await this.usersService.getAvatarContent(id);
    response.setHeader('Content-Type', avatar.mimeType || 'application/octet-stream');
    response.setHeader('Cache-Control', 'private, max-age=300');
    return new StreamableFile(avatar.buffer);
  }

  @Patch('me/profile')
  @UseGuards(AuthGuard)
  updateProfile(@Req() req: any, @Body() body: { name?: string; preferredLanguage?: AppLanguage; school?: string; degree?: string }) {
    return this.usersService.updateProfile(req.user.uid, body);
  }

  @Get(':id/public-profile')
  @UseGuards(AuthGuard)
  getPublicProfile(@Param('id') id: string, @Req() req: any) {
    return this.usersService.getPublicProfile(req.user.uid, id);
  }

  @Get(':id/followers')
  @UseGuards(AuthGuard)
  getFollowers(@Param('id') id: string, @Req() req: any) {
    return this.usersService.getFollowers(req.user.uid, id);
  }

  @Get(':id/following')
  @UseGuards(AuthGuard)
  getFollowing(@Param('id') id: string, @Req() req: any) {
    return this.usersService.getFollowing(req.user.uid, id);
  }

  @Post(':id/follow')
  @UseGuards(AuthGuard)
  toggleFollow(@Param('id') id: string, @Req() req: any) {
    return this.usersService.toggleFollow(req.user.uid, id);
  }

  @Delete('me')
  @UseGuards(AuthGuard)
  async deleteAccount(@Req() req: any, @Res({ passthrough: true }) response: Response) {
    const result = await this.usersService.deleteAccount(req.user.uid);
    response.clearCookie(AUTH_TOKEN_COOKIE, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
    });
    return result;
  }

  private getAuthCookie(cookieHeader?: string) {
    if (!cookieHeader) {
      return null;
    }

    const cookies = cookieHeader.split(';');

    for (const cookie of cookies) {
      const trimmed = cookie.trim();
      if (trimmed.startsWith(`${AUTH_TOKEN_COOKIE}=`)) {
        return decodeURIComponent(trimmed.slice(AUTH_TOKEN_COOKIE.length + 1));
      }
    }

    return null;
  }
}
