import { Controller, Get, Post, Param, Body, UseGuards, Req, Delete, Query } from '@nestjs/common';
import { QuizzesService } from './quizzes.service';
import { GenerateQuizDto } from './dto/generate-quiz.dto';
import { AuthGuard } from '../auth/auth.guard';
import { SubmitAnswerDto } from './dto/submit-answer.dto';

@Controller('quizzes')
@UseGuards(AuthGuard) // Protect all routes in this controller
export class QuizzesController {
  constructor(private readonly quizzesService: QuizzesService) {}

  @Post('generate')
  generate(@Req() req: any, @Body() dto: GenerateQuizDto) {
    return this.quizzesService.generate(req.user.uid, dto);
  }

  @Post(':quizId/play')
  play(@Param('quizId') quizId: string, @Req() req: any, @Body() body?: { replay?: boolean }) {
    return this.quizzesService.startOrResumeSession(req.user.uid, quizId, { replay: Boolean(body?.replay) });
  }

  @Get(':quizId/session')
  getSessionByQuizId(@Param('quizId') quizId: string, @Req() req: any) {
    return this.quizzesService.getSessionByQuizId(req.user.uid, quizId);
  }

  @Get('sessions/:sessionId/batch')
  getQuestionBatch(
    @Param('sessionId') sessionId: string,
    @Req() req: any,
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedOffset = Number.isNaN(Number(offset)) ? 0 : Number(offset);
    const parsedLimit = Number.isNaN(Number(limit)) ? undefined : Number(limit);
    return this.quizzesService.getQuestionBatch(req.user.uid, sessionId, parsedOffset, parsedLimit);
  }

  @Post('sessions/:sessionId/answer')
  submitAnswer(
    @Param('sessionId') sessionId: string,
    @Req() req: any,
    @Body() dto: SubmitAnswerDto,
  ) {
    return this.quizzesService.submitAnswer(req.user.uid, sessionId, dto);
  }

  @Post('sessions/:sessionId/shuffle')
  shuffleRemainingQuestions(@Param('sessionId') sessionId: string, @Req() req: any) {
    return this.quizzesService.shuffleRemainingQuestions(req.user.uid, sessionId);
  }

  @Get()
  findAll(
    @Req() req: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('title') title?: string,
    @Query('subject') subject?: string | string[],
  ) {
    const paginate = page !== undefined || limit !== undefined;
    const parsedPage = Number(page) > 0 ? Number(page) : 1;
    const parsedLimit = Number(limit) > 0 ? Number(limit) : 6;
    return this.quizzesService.findAllByUser(req.user.uid, {
      page: parsedPage,
      limit: parsedLimit,
      title: title || undefined,
      subject: this.toSubjectFilters(subject),
      paginate,
    });
  }

  @Get('public')
  findAllPublic(
    @Req() req: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('title') title?: string,
    @Query('subject') subject?: string | string[],
  ) {
    const paginate = page !== undefined || limit !== undefined;
    const parsedPage = Number(page) > 0 ? Number(page) : 1;
    const parsedLimit = Number(limit) > 0 ? Number(limit) : 6;
    return this.quizzesService.findAllPublic(req.user.uid, {
      page: parsedPage,
      limit: parsedLimit,
      title: title || undefined,
      subject: this.toSubjectFilters(subject),
      paginate,
    });
  }

  private toSubjectFilters(subject?: string | string[]) {
    if (!subject) {
      return undefined;
    }

    const values = (Array.isArray(subject) ? subject : [subject]).filter(Boolean);
    return values.length ? values : undefined;
  }

  @Get(':quizId/analytics')
  getAnalytics(@Param('quizId') quizId: string, @Req() req: any) {
    return this.quizzesService.getDeckAnalytics(req.user.uid, quizId);
  }

  @Get(':quizId/likes')
  getDeckLikes(@Param('quizId') quizId: string, @Req() req: any) {
    return this.quizzesService.getDeckLikesForOwner(req.user.uid, quizId);
  }

  @Post(':quizId/tutor-chat')
  tutorChat(
    @Param('quizId') quizId: string,
    @Req() req: any,
    @Body() body: { messages: { role: 'user' | 'assistant'; text: string }[] },
  ) {
    return this.quizzesService.tutorChat(req.user.uid, quizId, body.messages ?? []);
  }

  @Get(':quizId')
  findOne(@Param('quizId') quizId: string) {
    return this.quizzesService.findOne(quizId);
  }

  @Delete(':quizId')
  remove(@Param('quizId') quizId: string, @Req() req: any) {
    return this.quizzesService.removeByUser(req.user.uid, quizId);
  }

  @Post(':quizId/public')
  handlePublic(@Param('quizId') quizId: string, @Req() req: any) {
    return this.quizzesService.togglePublic(req.user.uid, quizId);
  }

  @Post(':quizId/like')
  likeAction(@Param('quizId') quizId: string, @Req() req: any) {
    return this.quizzesService.handleLikeAction(req.user.uid, quizId);
  }

  @Post(':quizId/save')
  saveDeck(@Param('quizId') quizId: string, @Req() req: any) {
    return this.quizzesService.handleSave(req.user.uid, quizId);
  }
}
