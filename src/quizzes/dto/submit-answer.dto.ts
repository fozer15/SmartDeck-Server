import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class SubmitAnswerDto {
  @IsString()
  questionId: string;

  @IsOptional()
  @IsString()
  answer?: string;

  @IsOptional()
  @IsBoolean()
  correct?: boolean;

  @IsOptional()
  @IsString()
  attemptId?: string;

  @IsOptional()
  @IsString()
  clientTimestamp?: string;
}
