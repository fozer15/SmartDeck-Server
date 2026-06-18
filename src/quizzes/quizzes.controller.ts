import { BadRequestException, Controller, Get, Post, Patch, Param, Body, UseGuards, Req, Delete, Query } from '@nestjs/common';
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

  @Post('generation-jobs')
  enqueueGeneration(@Req() req: any, @Body() dto: GenerateQuizDto) {
    return this.quizzesService.enqueueGeneration(req.user.uid, dto);
  }

  @Get('generation-jobs')
  listGenerationJobs(@Req() req: any) {
    return this.quizzesService.listGenerationJobs(req.user.uid);
  }

  @Get('generation-jobs/:jobId')
  getGenerationJob(@Param('jobId') jobId: string, @Req() req: any) {
    return this.quizzesService.getGenerationJob(req.user.uid, jobId);
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

  @Get(':quizId/questions')
  getDeckQuestions(
    @Param('quizId') quizId: string,
    @Req() req: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    // Default to page 1 and a reasonable limit (e.g., 10 or 20) if not provided
    const parsedPage = Number(page) > 0 ? Number(page) : 1;
    const parsedLimit = Number(limit) > 0 ? Number(limit) : 10; 

    return this.quizzesService.getQuestionsByQuizId(
      req.user.uid, 
      quizId, 
      parsedPage, 
      parsedLimit
    );
  }

  @Get()
  findAll(
    @Req() req: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('title') title?: string,
    @Query('subject') subject?: string | string[],
    @Query('timeOrder') timeOrder?: string,
  ) {
    const paginate = page !== undefined || limit !== undefined;
    const parsedPage = Number(page) > 0 ? Number(page) : 1;
    const parsedLimit = Number(limit) > 0 ? Number(limit) : 5;
    return this.quizzesService.findAllByUser(req.user.uid, {
      page: parsedPage,
      limit: parsedLimit,
      title: title || undefined,
      subject: this.toSubjectFilters(subject),
      timeOrder: this.toTimeOrder(timeOrder),
      paginate,
    });
  }

  @Get('search')
  searchPublicDecks(
    @Req() req: any,
    @Query('q') title?: string,
    @Query('subject') subject?: string | string[],
    @Query('school') school?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    console.log(subject);
    console.log(title);
    console.log(school);
    const paginate = page !== undefined || limit !== undefined;
    const parsedPage = Number(page) > 0 ? Number(page) : 1;
    const parsedLimit = Number(limit) > 0 ? Number(limit) : 12;
    return this.quizzesService.searchPublicDecks(req.user.uid, {
      title: title || undefined,
      subject: this.toSubjectFilters(subject),
      school: school || undefined,
      page: parsedPage,
      limit: parsedLimit,
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
    @Query('view') view?: string,
    @Query('timeOrder') timeOrder?: string,
    @Query('userId') userId?: string,
  ) {
    const paginate = page !== undefined || limit !== undefined;
    const parsedPage = Number(page) > 0 ? Number(page) : 1;
    const parsedLimit = Number(limit) > 0 ? Number(limit) : 5;
    return this.quizzesService.findAllPublic(req.user.uid, {
      page: parsedPage,
      limit: parsedLimit,
      title: title || undefined,
      subject: this.toSubjectFilters(subject),
      view: this.toPublicDeckView(view),
      timeOrder: this.toTimeOrder(timeOrder),
      paginate,
      filterUserId: userId || undefined,
    });
  }

  private toSubjectFilters(subject?: string | string[]) {
    if (!subject) {
      return undefined;
    }

    const values = (Array.isArray(subject) ? subject : [subject]).filter(Boolean);
    return values.length ? values : undefined;
  }

  private toPublicDeckView(view?: string): 'trending' | 'newest' | 'following' {
    const normalizedView = String(view || '').toLowerCase();

    if (normalizedView === 'trending' || normalizedView === 'following') {
      return normalizedView;
    }

    return 'newest';
  }

  private toTimeOrder(value?: string): 'asc' | 'desc' {
    return String(value || '').toLowerCase() === 'asc' ? 'asc' : 'desc';
  }

  @Get(':quizId/analytics')
  getAnalytics(@Param('quizId') quizId: string, @Req() req: any) {
    return this.quizzesService.getDeckAnalytics(req.user.uid, quizId);
  }

  @Get(':quizId/likes')
  getDeckLikes(@Param('quizId') quizId: string, @Req() req: any) {
    return this.quizzesService.getDeckLikesForOwner(req.user.uid, quizId);
  }

 @Get(':quizId/tutor-chat')
  getTutorHistory(
    @Param('quizId') quizId: string,
    @Req() req: any,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = Number(limit) > 0 ? Number(limit) : 20; // Default to 20 messages per chunk
    return this.quizzesService.getTutorChatHistory(req.user.uid, quizId, cursor, parsedLimit);
  }

  @Delete(':quizId/tutor-chat')
  clearTutorHistory(@Param('quizId') quizId: string, @Req() req: any) {
    return this.quizzesService.clearTutorChatHistory(req.user.uid, quizId);
  }

  @Post(':quizId/tutor-chat')
  async tutorChat(
    @Param('quizId') quizId: string,
    @Req() req: any,
    @Body() body: { text: string }, // Strictly expect only the text
  ) {
    // Call your service function with just the clean text
    return this.quizzesService.tutorChat(req.user.uid, quizId, body.text.trim());
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

  @Patch(':quizId/title')
  updateTitle(
    @Param('quizId') quizId: string,
    @Req() req: any,
    @Body() body: { title: string },
  ) {
    return this.quizzesService.updateDeckTitle(req.user.uid, quizId, body.title);
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
