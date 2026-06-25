import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

export const signedUploadTypes = ['pdf', 'audio', 'image', 'avatar'] as const;

export type SignedUploadType = (typeof signedUploadTypes)[number];

export class CreateSignedUploadDto {
  @IsString()
  fileName: string;

  @IsString()
  mimeType: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  size: number;

  @IsIn(signedUploadTypes)
  uploadType: SignedUploadType;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageCount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(60 * 60 * 12)
  audioDurationSeconds?: number;
}