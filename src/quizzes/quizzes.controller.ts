import { Controller, Get, Post, Param, Query, Body, UseGuards, Req, Delete } from '@nestjs/common';
import { QuizzesService } from './quizzes.service';
import { GenerateQuizDto } from './dto/generate-quiz.dto';
import { AuthGuard } from '../auth/auth.guard';
import { SubmitAnswerDto } from './dto/submit-answer.dto';

@Controller('quizzes')
@UseGuards(AuthGuard) // Protect all routes in this controller
export class QuizzesController {
  constructor(private readonly quizzesService: QuizzesService) {}

  @Post('generate')
  generate(@Body() dto: GenerateQuizDto) {
    return this.quizzesService.generate(dto);
  }

  @Post(':id/play')
  play(@Param('id') quizId: string, @Req() req: any) {
    return this.quizzesService.startOrResumeSession(req.user.uid, quizId);
  }

  @Get('sessions/:id')
  getSession(@Param('id') sessionId: string, @Req() req: any) {
    return this.quizzesService.getSession(req.user.uid, sessionId);
  }

  @Post('sessions/:id/answer')
  submitAnswer(
    @Param('id') sessionId: string,
    @Req() req: any,
    @Body() dto: SubmitAnswerDto,
  ) {
    return this.quizzesService.submitAnswer(req.user.uid, sessionId, dto);
  }

  @Get()
  findAll(@Query('userId') userId: string) {
    return this.quizzesService.findAllByUser(userId);
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
