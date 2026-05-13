import { IsEmail, IsEnum, IsOptional, IsString } from 'class-validator';
import { AppLanguage } from '@prisma/client';

export class CreateUserDto {
  @IsString()
  id: string; // Firebase UID

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  avatarUrl?: string;

  @IsOptional()
  @IsEnum(AppLanguage)
  preferredLanguage?: AppLanguage;
}
