import { Body, Controller, Get, Param, Post, Req, UseGuards , Delete} from '@nestjs/common';

import { AuthGuard } from '../auth/auth.guard';
import { SolveDto } from './dto/solve.dto';
import { SolveService } from './solve.service';
import {SolutionChatDto} from "./dto/solution-chat.dto"
/**
 * POST  /solve/jobs               — enqueue a solve job → { status, jobId }
 * GET   /solve/jobs               — list caller's jobs (last 50, no result body)
 * GET   /solve/jobs/:jobId        — poll a job; includes resultSolution when completed
 *
 * GET   /solve/solutions          — history list: title + first image per solution
 * GET   /solve/solutions/:id      — full detail: content + all images + job meta
 */
@Controller('solve')
@UseGuards(AuthGuard)
export class SolveController {
  constructor(private readonly solveService: SolveService) {}

  // ── Jobs ──────────────────────────────────────────────────────────────────

  @Post('jobs')
  enqueue(@Req() req: any, @Body() dto: SolveDto) {
    return this.solveService.enqueueSolveJob(req.user.uid, {
      fileIds: dto.fileIds,
      note: dto.note,
    });
  }

  @Get('jobs')
  listJobs(@Req() req: any) {
    return this.solveService.listSolveJobs(req.user.uid);
  }

  @Get('jobs/:jobId')
  getJob(@Param('jobId') jobId: string, @Req() req: any) {
    return this.solveService.getSolveJob(req.user.uid, jobId);
  }

  // ── Solutions (history) ───────────────────────────────────────────────────

  @Get('solutions')
  listSolutions(@Req() req: any) {
    return this.solveService.listSolutions(req.user.uid);
  }

  @Get('solutions/:solutionId')
  getSolution(@Param('solutionId') solutionId: string, @Req() req: any) {
    return this.solveService.getSolution(req.user.uid, solutionId);
  }

  @Delete('solutions/:solutionId')
  deleteSolution(@Param('solutionId') solutionId: string, @Req() req: any) {
    return this.solveService.deleteSolution(req.user.uid, solutionId);
  }

  @Post('solutions/:solutionId/chat')
  chatAboutSolution(
    @Param('solutionId') solutionId: string,
    @Body() dto: SolutionChatDto,
    @Req() req: any
  ) {
    return this.solveService.chatAboutSolution(req.user.uid, solutionId, dto);
  }
}
