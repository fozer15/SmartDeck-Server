import { Subject, QuizTierPreference, QuizFormatPreference } from '@prisma/client';
import { IsString, IsOptional, IsArray, IsEnum, IsInt, Min, Max } from 'class-validator';

export class GenerateQuizDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsEnum(Subject)
  subject?: Subject;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  fileIds?: string[];

  @IsOptional()
  @IsString()
  audioFileId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  questionCount?: number;

  @IsOptional()
  @IsEnum(QuizTierPreference)
  questionTier?: QuizTierPreference;

  @IsOptional()
  @IsEnum(QuizFormatPreference)
  questionFormat?: QuizFormatPreference;

  @IsOptional()
  @IsString()
  instructions?: string;
}
