import { IsArray, IsOptional, IsString, ArrayMinSize, ArrayMaxSize, MaxLength } from 'class-validator';

/**
 * POST /solve
 *
 * At least one image fileId is required. Up to 10 images per request.
 * An optional text note lets the user add context ("focus on part b" etc.).
 */
export class SolveDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsString({ each: true })
  fileIds: string[];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
