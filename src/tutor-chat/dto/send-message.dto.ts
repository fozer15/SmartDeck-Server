import { IsArray, IsOptional, IsString, MaxLength, ArrayMaxSize } from 'class-validator';

/**
 * Payload for POST /tutor-chat/messages
 *
 * All fields are optional individually but the request must include at least
 * one of `text` or `fileIds` (validated in the service).
 *
 * - `conversationId` — omit to start a new conversation. Provide it to append
 *   to an existing thread the user owns.
 * - `quizId` — optional deck context. When present, deck analytics are folded
 *   into the tutor's system instruction. When absent, the tutor operates as a
 *   general study companion.
 * - `text` — the user's message.
 * - `fileIds` — IDs of previously uploaded files (PDFs / images) to attach.
 */
export class SendTutorMessageDto {
  @IsOptional()
  @IsString()
  conversationId?: string;

  @IsOptional()
  @IsString()
  quizId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8000)
  text?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  fileIds?: string[];
}
