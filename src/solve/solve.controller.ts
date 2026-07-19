import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';

import { AuthGuard } from '../auth/auth.guard';
import { SolveDto } from './dto/solve.dto';
import { SolveService } from './solve.service';

/**
 * POST /solve
 *
 * Accepts one or more image fileIds (already uploaded via /files),
 * sends them to Gemini with a structured academic-solver system prompt,
 * and returns a Markdown + LaTeX solution.
 *
 * Cost: 15 credits per request (same as QUIZ_GENERATION), regardless of
 * the number of images.
 */
@Controller('solve')
@UseGuards(AuthGuard)
export class SolveController {
  constructor(private readonly solveService: SolveService) {}

  @Post()
  solve(@Req() req: any, @Body() dto: SolveDto) {
    return this.solveService.solve(req.user.uid, {
      fileIds: dto.fileIds,
      note: dto.note,
    });
  }
}
