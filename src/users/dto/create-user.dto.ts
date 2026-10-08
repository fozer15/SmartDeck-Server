import { IsEmail, IsEnum, IsOptional, IsString } from 'class-validator';
import { AppLanguage } from '@prisma/client';

export class CreateUserDto {
  @IsString()
  id: string; // Firebase UID

  @IsOptional()
  @IsEmail()
  email?: string | null;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  school?: string;

  @IsOptional()
  @IsString()
  degree?: string;

  @IsOptional()
  @IsString()
  avatarUrl?: string;

  @IsOptional()
  @IsString()
  deviceId?: string;

  @IsOptional()
  @IsEnum(AppLanguage)
  preferredLanguage?: AppLanguage;
}
