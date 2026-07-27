import { IsString, IsOptional, IsIn } from 'class-validator';

export class SignInDto {
  @IsString()
  idToken: string; // Firebase ID token

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  deviceId?: string;

  @IsOptional()
  @IsString()
  school?: string;

  @IsOptional()
  @IsString()
  degree?: string;

  @IsOptional()
  @IsIn(['en', 'zh', 'hi', 'es', 'fr','tr','pt'])
  lang?: string;
}
