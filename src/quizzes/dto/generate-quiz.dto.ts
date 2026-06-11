import { Subject, QuizTierPreference, QuizFormatPreference } from '@prisma/client';
import { IsString, IsOptional, IsArray, IsEnum, IsInt, Min, Max, IsNotEmpty, IsObject, MaxLength, MinLength } from 'class-validator';

export class GenerateQuizDto {
  @IsNotEmpty()
  @IsString()
  title!: string;

  @IsOptional()
  @IsEnum(Subject)
  subject?: Subject;

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

  // Free-form notes/text the user pasted in. When provided (and no files/audio),
  // the deck will be generated directly from this text.
  @IsOptional()
  @IsString()
  @MinLength(20, { message: 'text must be at least 20 characters' })
  @MaxLength(50_000, { message: 'text is too long (max 100,000 characters)' })
  text?: string;

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
