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
  findAll(@Req() req: any) {
    return this.quizzesService.findAllByUser(req.user.uid);
  }

  @Get(':quizId')
  findOne(@Param('quizId') quizId: string) {
    return this.quizzesService.findOne(quizId);
  }

  @Delete(':quizId')
  remove(@Param('quizId') quizId: string, @Req() req: any) {
    return this.quizzesService.removeByUser(req.user.uid, quizId);
  }
}
