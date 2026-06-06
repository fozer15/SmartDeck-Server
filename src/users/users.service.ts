import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EnvService } from '../env/env.service';
import { FilesService } from '../files/files.service';
import { CreateUserDto } from './dto/create-user.dto';
import {AppLanguage} from '@prisma/client';
import admin from "firebase-admin";

@Injectable()
export class UsersService {
  private appBaseUrl: string;

  constructor(
    private prisma: PrismaService,
    private env: EnvService,
    private filesService: FilesService,
  ) {
    this.appBaseUrl = env.appBaseUrl;
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
          school: existingUser.school || dto.school,
          avatarUrl: existingUser.avatarUrl || dto.avatarUrl,
          preferredLanguage: (existingUser as { preferredLanguage?: AppLanguage }).preferredLanguage || dto.preferredLanguage || 'en',
        } as any,
      });

      return this.withAvatarEndpointUrl(updatedUser);
    }

    // Create new user with Firebase UID as ID

    const createdUser = await this.prisma.user.create({
      data: {
        id: dto.id,
        email: dto.email,
        name: dto.name,
        school: dto.school,
        degree: dto.degree,
        avatarUrl: dto.avatarUrl,
        preferredLanguage: dto.preferredLanguage || 'en',
      } as any,
    });

    await this.prisma.userUsageLimit.create({
      data:{
        userId:dto.id,
      }
    })
    
    return this.withAvatarEndpointUrl(createdUser);
  }

  async searchByName(viewerId: string, query: string) {
    if (!query || query.trim().length < 1) {
      return [];
    }

    const users = await this.prisma.user.findMany({
      where: {
        name: { contains: query.trim(), mode: 'insensitive' },
        id: { not: viewerId },
      },
      select: {
        id: true,
        name: true,
        avatarUrl: true,
        followers: {
          where: { followerId: viewerId },
          select: { id: true },
          take: 1,
        },
      },
      take: 20,
      orderBy: { name: 'asc' },
    });

    return users.map((user) => ({
      id: user.id,
      name: user.name,
      avatarUrl: this.toAvatarUrl(user.id, user.avatarUrl),
      isFollowing: user.followers.length > 0,
    }));
  }

  async findAll() {
    const users = await this.prisma.user.findMany();
    return users.map((user) => this.withAvatarEndpointUrl(user));
  }
  //TODO can be turned to soft delete later
  async deleteAccount(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Delete all uploaded files from R2 before deleting the user
    const files = await this.prisma.uploadedFile.findMany({
      where: { userId },
      select: { id: true, r2Key: true },
    });

    for (const file of files) {
      await this.filesService.deleteFile(file.id).catch(() => {});
    }

    // Cascades handle sessions, quizzes, likes, saves, follows
    await admin.auth().deleteUser(userId);
    await this.prisma.user.delete({ where: { id: userId } });

    return { success: true };
  }


  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
    });
    if (!user) throw new NotFoundException('User not found');
    return this.withAvatarEndpointUrl(user);
  }

  async updateProfile(userId: string, data: { name?: string; preferredLanguage?: AppLanguage; school?: string; degree?: string }) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.preferredLanguage !== undefined && { preferredLanguage: data.preferredLanguage }),
        ...(data.school !== undefined && { school: data.school }),
        ...(data.degree !== undefined && { degree: data.degree }),
      } as any,
    });
    return this.withAvatarEndpointUrl(user);
  }

  async getPublicProfile(viewerId: string, profileUserId: string) {
    const isMe = viewerId === profileUserId;

    const user = await this.prisma.user.findUnique({
      where: { id: profileUserId },
      select: {
        id: true,
        name: true,
        avatarUrl: true,
        createdAt: true,
        school: true,
        degree: true,
        _count: {
          select: {
            followers: true,
            following: true,
            quizzes: isMe ? true : { where: { isPublic: true } } as any,
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
          where: isMe ? {} : { isPublic: true },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            title: true,
            subject: true,
            createdAt: true,
            questionCount: true,
            questionFormat: true,
            isPublic: true,
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

    const decks = user.quizzes.map((deck) => ({
      id: deck.id,
      title: deck.title,
      subject: deck.subject,
      createdAt: deck.createdAt,
      likeCount: deck._count.likes,
      questionCount: deck.questionCount,
      questionFormat: deck.questionFormat,
      isPublic: deck.isPublic,
    }));

    const totalLikes = decks.reduce((sum, deck) => sum + Number(deck.likeCount || 0), 0);

    return {
      id: user.id,
      name: user.name,
      school: user.school,
      degree: user.degree,
      avatarUrl: this.toAvatarUrl(user.id, user.avatarUrl),
      createdAt: user.createdAt,
      isMe,
      isFollowing: Array.isArray(user.followers) ? user.followers.length > 0 : false,
      followerCount: user._count.followers,
      followingCount: user._count.following,
      // when viewing own profile: total decks (public + private). Otherwise: only public decks.
      deckCount: user._count.quizzes,
      totalLikes,
      publicDecks: decks,
    };
  }

  async getFollowers(viewerId: string, profileUserId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: profileUserId },
      select: {
        followers: {
          orderBy: { createdAt: 'desc' },
          select: {
            createdAt: true,
            follower: {
              select: {
                id: true,
                name: true,
                avatarUrl: true,
                followers: {
                  where: { followerId: viewerId },
                  select: { id: true },
                  take: 1,
                },
              },
            },
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user.followers.map((entry) => ({
      id: entry.follower.id,
      name: entry.follower.name,
      avatarUrl: this.toAvatarUrl(entry.follower.id, entry.follower.avatarUrl),
      followedAt: entry.createdAt,
      isFollowing: entry.follower.id === viewerId ? false : entry.follower.followers.length > 0,
    }));
  }

  async getFollowing(viewerId: string, profileUserId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: profileUserId },
      select: {
        following: {
          orderBy: { createdAt: 'desc' },
          select: {
            createdAt: true,
            following: {
              select: {
                id: true,
                name: true,
                avatarUrl: true,
                followers: {
                  where: { followerId: viewerId },
                  select: { id: true },
                  take: 1,
                },
              },
            },
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user.following.map((entry) => ({
      id: entry.following.id,
      name: entry.following.name,
      avatarUrl: this.toAvatarUrl(entry.following.id, entry.following.avatarUrl),
      followedAt: entry.createdAt,
      isFollowing: entry.following.id === viewerId ? false : entry.following.followers.length > 0,
    }));
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

  async getAvatarContent(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        avatarUrl: true,
      },
    });

    if (!user?.avatarUrl) {
      throw new NotFoundException('Avatar not found');
    }

    if (/^https?:\/\//i.test(user.avatarUrl)) {
      const response = await fetch(user.avatarUrl);
      if (!response.ok) {
        throw new BadGatewayException('Avatar source could not be loaded');
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      return {
        buffer,
        mimeType: response.headers.get('content-type') || 'application/octet-stream',
      };
    }

    return this.filesService.getObjectBuffer(user.avatarUrl);
  }

  private withAvatarEndpointUrl<T extends { id: string; avatarUrl: string | null }>(user: T): T {
    return {
      ...user,
      avatarUrl: this.toAvatarUrl(user.id, user.avatarUrl),
    };
  }

  private toAvatarUrl(userId: string, value?: string | null) {
    if (!value) {
      return null;
    }

    return `${this.appBaseUrl}/users/${encodeURIComponent(userId)}/avatar`;
  }
}
