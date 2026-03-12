import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async findOrCreate(dto: CreateUserDto) {
    // Check if user already exists (using Firebase UID)
    const existingUser = await this.prisma.user.findUnique({
      where: { id: dto.id },
    });

    if (existingUser) {
      // Update user info in case it changed in Firebase
      return this.prisma.user.update({
        where: { id: dto.id },
        data: {
          email: dto.email,
          name: dto.name,
          avatarUrl: dto.avatarUrl,
        },
      });
    }

    // Create new user with Firebase UID as ID
    return this.prisma.user.create({
      data: {
        id: dto.id,
        email: dto.email,
        name: dto.name,
        avatarUrl: dto.avatarUrl,
      },
    });
  }

  async findAll() {
    return this.prisma.user.findMany();
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }
}
