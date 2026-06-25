import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Req,
  UseGuards,
  StreamableFile,
  Res,
  Body,
} from '@nestjs/common';
import { FilesService } from './files.service';
import { AuthGuard } from '../auth/auth.guard';
import { CreateSignedUploadDto } from './dto/create-signed-upload.dto';
import { CompleteSignedUploadDto } from './dto/complete-signed-upload.dto';
import type { Response } from 'express';

@Controller('files')
@UseGuards(AuthGuard)
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  @Post('upload-request')
  createSignedUpload(@Body() body: CreateSignedUploadDto, @Req() req: any) {
    return this.filesService.createSignedUpload(req.user.uid, body);
  }

  @Post('upload-complete')
  completeSignedUpload(@Body() body: CompleteSignedUploadDto, @Req() req: any) {
    return this.filesService.completeSignedUpload(req.user.uid, body.uploadToken);
  }

  @Get()
  findAll(
    @Req() req: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('name') name?: string,
    @Query('timeOrder') timeOrder?: string,
  ) {
    const paginate = page !== undefined || limit !== undefined;
    const parsedPage = Number(page) > 0 ? Number(page) : 1;
    const parsedLimit = Number(limit) > 0 ? Number(limit) : 5;
    return this.filesService.findAllByUser(req.user.uid, {
      page: parsedPage,
      limit: parsedLimit,
      name: name || undefined,
      timeOrder: this.toTimeOrder(timeOrder),
      paginate,
    });
  }

  @Get(':id/view-url')
  getViewUrl(@Param('id') id: string, @Req() req: any) {
    return this.filesService.getViewUrlForUser(id, req.user.uid);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) {
    return this.filesService.findOne(id, req.user.uid);
  }

  @Get(':id/content')
  async getContent(@Param('id') id: string, @Req() req: any, @Res({ passthrough: true }) response: Response) {
    const file = await this.filesService.getFileBufferForUser(id, req.user.uid);
    response.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    response.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.originalName)}"`);
    return new StreamableFile(file.buffer);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any) {
    return this.filesService.remove(id, req.user.uid);
  }

  private toTimeOrder(value?: string): 'asc' | 'desc' {
    return String(value || '').toLowerCase() === 'asc' ? 'asc' : 'desc';
  }
}
