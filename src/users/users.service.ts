import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EnvService } from '../env/env.service';
import { CreateUserDto } from './dto/create-user.dto';
import {AppLanguage} from '@prisma/client';

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
          preferredLanguage: (existingUser as { preferredLanguage?: AppLanguage }).preferredLanguage || dto.preferredLanguage || 'en',
        } as any,
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
        preferredLanguage: dto.preferredLanguage || 'en',
      } as any,
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

  async updateProfile(userId: string, data: { name?: string; preferredLanguage?: AppLanguage }) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.preferredLanguage !== undefined && { preferredLanguage: data.preferredLanguage }),
      } as any,
    });
    return this.withPublicAvatarUrl(user);
  }

  async getPublicProfile(viewerId: string, profileUserId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: profileUserId },
      select: {
        id: true,
        name: true,
        avatarUrl: true,
        createdAt: true,
        _count: {
          select: {
            followers: true,
            following: true,
          },
        },
        followers: viewerId
          ? {
              where: { followerId: viewerId },
              select: { id: true },
              take: 1,
            }
          : false,
        quizzes: {
          where: { isPublic: true },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            title: true,
            subject: true,
            createdAt: true,
            _count: {
              select: {
                likes: true,
              },
            },
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const publicDecks = user.quizzes.map((deck) => ({
      id: deck.id,
      title: deck.title,
      subject: deck.subject,
      createdAt: deck.createdAt,
      likeCount: deck._count.likes,
    }));

    const totalLikes = publicDecks.reduce((sum, deck) => sum + Number(deck.likeCount || 0), 0);

    return {
      id: user.id,
      name: user.name,
      avatarUrl: this.toPublicUrl(user.avatarUrl),
      createdAt: user.createdAt,
      isMe: viewerId === user.id,
      isFollowing: Array.isArray(user.followers) ? user.followers.length > 0 : false,
      followerCount: user._count.followers,
      followingCount: user._count.following,
      publicDeckCount: publicDecks.length,
      totalLikes,
      publicDecks,
    };
  }

  async toggleFollow(viewerId: string, profileUserId: string) {
    if (viewerId === profileUserId) {
      throw new BadRequestException('You cannot follow yourself');
    }

    const targetUser = await this.prisma.user.findUnique({
      where: { id: profileUserId },
      select: { id: true },
    });

    if (!targetUser) {
      throw new NotFoundException('User not found');
    }

    const existingFollow = await this.prisma.userFollow.findUnique({
      where: {
        followerId_followingId: {
          followerId: viewerId,
          followingId: profileUserId,
        },
      },
    });

    if (existingFollow) {
      await this.prisma.userFollow.delete({
        where: { id: existingFollow.id },
      });

      const followerCount = await this.prisma.userFollow.count({
        where: { followingId: profileUserId },
      });

      return { isFollowing: false, followerCount };
    }

    await this.prisma.userFollow.create({
      data: {
        followerId: viewerId,
        followingId: profileUserId,
      },
    });

    const followerCount = await this.prisma.userFollow.count({
      where: { followingId: profileUserId },
    });

    return { isFollowing: true, followerCount };
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
