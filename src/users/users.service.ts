import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async findOrCreate(dto: CreateUserDto) {
    // 1. Already signed in with this exact provider before → return that user
    const existingAccount = await this.prisma.account.findUnique({
      where: { provider_providerAccountId: { provider: dto.provider, providerAccountId: dto.providerAccountId } },
      include: { user: true },
    });
    if (existingAccount) return existingAccount.user;

    // 2. A User with this email already exists (e.g. signed up with email, now linking Google)
    //    → attach a new Account to the existing User instead of creating a duplicate
    if (dto.email) {
      const existingUser = await this.prisma.user.findUnique({ where: { email: dto.email } });
      if (existingUser) {
        await this.prisma.account.create({
          data: {
            userId: existingUser.id,
            provider: dto.provider,
            providerAccountId: dto.providerAccountId,
            accessToken: dto.accessToken,
            refreshToken: dto.refreshToken,
          },
        });
        return existingUser;
      }
    }

    // 3. Completely new user → create User + Account together
    return this.prisma.user.create({
      data: {
        email: dto.email,
        name: dto.name,
        avatarUrl: dto.avatarUrl,
        accounts: {
          create: {
            provider: dto.provider,
            providerAccountId: dto.providerAccountId,
            passwordHash: dto.passwordHash,
            accessToken: dto.accessToken,
            refreshToken: dto.refreshToken,
          },
        },
      },
    });
  }

  async findAll() {
    return this.prisma.user.findMany();
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { accounts: { select: { provider: true, createdAt: true } } },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }
}
