import { IsString } from 'class-validator';

export class CompleteSignedUploadDto {
  @IsString()
  uploadToken: string;
}