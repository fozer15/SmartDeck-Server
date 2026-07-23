import { IsString, IsNotEmpty, IsOptional, IsArray } from 'class-validator';

export class SolutionChatDto {
  @IsString()
  @IsNotEmpty()
  message: string;

  // Optional: If you want to support multi-turn chat history later
  @IsOptional()
  @IsArray()
  history?: Array<{ role: 'user' | 'model'; text: string }>;
}