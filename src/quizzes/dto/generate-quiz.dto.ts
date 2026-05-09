import { Subject, QuizTierPreference, QuizFormatPreference } from '@prisma/client';
import { IsString, IsOptional, IsArray, IsEnum, IsInt, Min, Max, IsNotEmpty, IsObject } from 'class-validator';

export class GenerateQuizDto {
  @IsNotEmpty()
  @IsString()
  title!: string;

  @IsNotEmpty()
  @IsEnum(Subject)
  subject!: Subject;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  fileIds?: string[];

  @IsOptional()
  @IsObject()
  pageSelections?: Record<string, number[]>;

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
