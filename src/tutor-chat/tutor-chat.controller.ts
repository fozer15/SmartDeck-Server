import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { AuthGuard } from '../auth/auth.guard';
import { SendTutorMessageDto } from './dto/send-message.dto';
import { UpdateConversationDto } from './dto/update-conversation.dto';
import { TutorChatService } from './tutor-chat.service';

/**
 * Tutor chat is now a first-class resource keyed on `conversationId` — a user
 * can have many concurrent conversations, may attach a deck (`quizId`) or run
 * a standalone chat, and can resume any prior thread.
 *
 * Routes:
 *  - POST   /tutor-chat/messages                       — send message (creates convo if omitted)
 *  - GET    /tutor-chat/conversations                  — list convos, newest first
 *  - GET    /tutor-chat/conversations/:id              — fetch one convo (metadata)
 *  - GET    /tutor-chat/conversations/:id/messages     — paginated message history
 *  - PATCH  /tutor-chat/conversations/:id              — rename
 *  - DELETE /tutor-chat/conversations/:id              — delete (cascades)
 */
@Controller('tutor-chat')
@UseGuards(AuthGuard)
export class TutorChatController {
  constructor(private readonly tutorChatService: TutorChatService) {}

  @Get('conversations')
  listConversations(
    @Req() req: any,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = Number(limit) > 0 ? Number(limit) : 20;
    return this.tutorChatService.listConversations(req.user.uid, cursor, parsedLimit);
  }

  @Get('conversations/:conversationId')
  getConversation(
    @Param('conversationId') conversationId: string,
    @Req() req: any,
  ) {
    return this.tutorChatService.getConversation(req.user.uid, conversationId);
  }

  @Get('conversations/:conversationId/messages')
  getMessages(
    @Param('conversationId') conversationId: string,
    @Req() req: any,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = Number(limit) > 0 ? Number(limit) : 20;
    return this.tutorChatService.getMessages(
      req.user.uid,
      conversationId,
      cursor,
      parsedLimit,
    );
  }

  @Patch('conversations/:conversationId')
  updateConversation(
    @Param('conversationId') conversationId: string,
    @Req() req: any,
    @Body() dto: UpdateConversationDto,
  ) {
    return this.tutorChatService.updateConversation(req.user.uid, conversationId, dto);
  }

  @Delete('conversations/:conversationId')
  deleteConversation(
    @Param('conversationId') conversationId: string,
    @Req() req: any,
  ) {
    return this.tutorChatService.deleteConversation(req.user.uid, conversationId);
  }

  @Post('messages')
  sendMessage(@Req() req: any, @Body() dto: SendTutorMessageDto) {
    return this.tutorChatService.sendMessage(req.user.uid, {
      conversationId: dto.conversationId,
      quizId: dto.quizId,
      text: dto.text,
      fileIds: dto.fileIds,
    });
  }
}
