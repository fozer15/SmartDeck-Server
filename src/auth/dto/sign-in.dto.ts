import { IsString } from 'class-validator';

export class SignInDto {
  @IsString()
  idToken: string; // Firebase ID token
}
