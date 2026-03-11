import { IsEmail, IsEnum, IsOptional, IsString } from 'class-validator';
import { AuthProvider} from '@prisma/client';

export class CreateUserDto {
  @IsEnum(AuthProvider)
  provider: AuthProvider;

  @IsString()
  providerAccountId: string;

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
  @IsString()
  passwordHash?: string; // only for email provider

  @IsOptional()
  @IsString()
  accessToken?: string;

  @IsOptional()
  @IsString()
  refreshToken?: string;
}
