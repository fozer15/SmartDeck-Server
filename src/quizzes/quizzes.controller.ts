import { Controller, Get, Post, Param, Body, UseGuards, Req, Delete, Query, HttpCode, HttpStatus } from '@nestjs/common';
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

  @Post(':id/play')
  @HttpCode(HttpStatus.NO_CONTENT)
  async play(@Param('id') quizId: string, @Req() req: any, @Body() body?: { replay?: boolean }) {
    await this.quizzesService.startOrResumeSession(req.user.uid, quizId, { replay: Boolean(body?.replay) });
  }

  @Get(':id/session')
  getSessionByQuizId(@Param('id') quizId: string, @Req() req: any) {
    return this.quizzesService.getSessionByQuizId(req.user.uid, quizId);
  }

  @Get('sessions/:id')
  getSession(@Param('id') sessionId: string, @Req() req: any) {
    return this.quizzesService.getSession(req.user.uid, sessionId);
  }

  @Get('sessions/:id/batch')
  getQuestionBatch(
    @Param('id') sessionId: string,
    @Req() req: any,
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedOffset = Number.isNaN(Number(offset)) ? 0 : Number(offset);
    const parsedLimit = Number.isNaN(Number(limit)) ? undefined : Number(limit);
    return this.quizzesService.getQuestionBatch(req.user.uid, sessionId, parsedOffset, parsedLimit);
  }

  @Post('sessions/:id/answer')
  submitAnswer(
    @Param('id') sessionId: string,
    @Req() req: any,
    @Body() dto: SubmitAnswerDto,
  ) {
    return this.quizzesService.submitAnswer(req.user.uid, sessionId, dto);
  }

  @Post('sessions/:id/shuffle')
  shuffleRemainingQuestions(@Param('id') sessionId: string, @Req() req: any) {
    return this.quizzesService.shuffleRemainingQuestions(req.user.uid, sessionId);
  }

  @Get()
  findAll(@Req() req: any) {
    return this.quizzesService.findAllByUser(req.user.uid);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.quizzesService.findOne(id);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any) {
    return this.quizzesService.removeByUser(req.user.uid, id);
  }
}
