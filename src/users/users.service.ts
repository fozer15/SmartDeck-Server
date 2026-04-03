import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EnvService } from '../env/env.service';
import { CreateUserDto } from './dto/create-user.dto';

@Injectable()
export class UsersService {
  private r2PublicUrl: string;

  constructor(
    private prisma: PrismaService,
    private env: EnvService,
  ) {
    this.r2PublicUrl = env.r2PublicUrl;
  }

  async findOrCreate(dto: CreateUserDto) {
    // Check if user already exists (using Firebase UID)
    const existingUser = await this.prisma.user.findUnique({
      where: { id: dto.id },
    });

    if (existingUser) {
      // Update user info in case it changed in Firebase
      const updatedUser = await this.prisma.user.update({
        where: { id: dto.id },
        data: {
          email: dto.email,
          name: existingUser.name || dto.name,
          avatarUrl: existingUser.avatarUrl || dto.avatarUrl,
        },
      });

      return this.withPublicAvatarUrl(updatedUser);
    }

    // Create new user with Firebase UID as ID
    const createdUser = await this.prisma.user.create({
      data: {
        id: dto.id,
        email: dto.email,
        name: dto.name,
        avatarUrl: dto.avatarUrl,
      },
    });

    return this.withPublicAvatarUrl(createdUser);
  }

  async findAll() {
    const users = await this.prisma.user.findMany();
    return users.map((user) => this.withPublicAvatarUrl(user));
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
    });
    if (!user) throw new NotFoundException('User not found');
    return this.withPublicAvatarUrl(user);
  }

  async updateProfile(userId: string, data: { name?: string }) {
    console.log('Updating profile for userId:', userId, 'with data:', data);
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
      },
    });
    return this.withPublicAvatarUrl(user);
  }

  private withPublicAvatarUrl<T extends { avatarUrl: string | null }>(user: T): T {
    return {
      ...user,
      avatarUrl: this.toPublicUrl(user.avatarUrl),
    };
  }

  private toPublicUrl(value?: string | null) {
    if (!value) {
      return null;
    }

    if (/^https?:\/\//i.test(value)) {
      return value;
    }

    return this.r2PublicUrl ? `${this.r2PublicUrl}/${value}` : value;
  }
}
