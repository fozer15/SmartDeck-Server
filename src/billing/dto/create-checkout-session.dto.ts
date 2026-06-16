import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateCheckoutSessionDto {
  @IsIn(['monthly', 'yearly'])
  interval: 'monthly' | 'yearly';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  returnPath?: string;
}