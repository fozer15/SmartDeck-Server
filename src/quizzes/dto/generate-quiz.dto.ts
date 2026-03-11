import { IsString, IsOptional, IsArray } from 'class-validator';

export class GenerateQuizDto {
  @IsString()
  userId: string;

  @IsArray()
  @IsString({ each: true })
  fileIds: string[];

  @IsOptional()
  @IsString()
  instructions?: string;
}
