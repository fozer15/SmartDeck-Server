import { Controller, Get, Post, Patch, Param, Body, UseGuards, Req } from '@nestjs/common';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { AuthGuard } from '../auth/auth.guard';
import { AppLanguage } from '@prisma/client';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  findOrCreate(@Body() dto: CreateUserDto) {
    return this.usersService.findOrCreate(dto);
  }

  @Get()
  findAll() {
    return this.usersService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.usersService.findOne(id);
  }

  @Patch('me/profile')
  @UseGuards(AuthGuard)
  updateProfile(@Req() req: any, @Body() body: { name?: string; preferredLanguage?: AppLanguage }) {
    return this.usersService.updateProfile(req.user.uid, body);
  }

  @Get(':id/public-profile')
  @UseGuards(AuthGuard)
  getPublicProfile(@Param('id') id: string, @Req() req: any) {
    return this.usersService.getPublicProfile(req.user.uid, id);
  }

  @Post(':id/follow')
  @UseGuards(AuthGuard)
  toggleFollow(@Param('id') id: string, @Req() req: any) {
    return this.usersService.toggleFollow(req.user.uid, id);
  }
}
