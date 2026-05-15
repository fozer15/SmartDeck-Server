import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
  UseGuards,
  StreamableFile,
  Res,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { FilesService } from './files.service';
import { AuthGuard } from '../auth/auth.guard';
import type { Response } from 'express';

@Controller('files')
@UseGuards(AuthGuard)
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  @Post('upload')
  @UseInterceptors(
    FileInterceptor('pdf', {
      storage: memoryStorage(),
      fileFilter: (req, file, cb) => {
        if (file.mimetype !== 'application/pdf') return cb(new BadRequestException('Only PDF files allowed'), false);
        cb(null, true);
      },
      limits: { fileSize: 20 * 1024 * 1024 },
    }),
  )
  upload(@UploadedFile() file: Express.Multer.File, @Req() req: any) {
    if (!file) throw new BadRequestException('No PDF file uploaded');
    return this.filesService.upload(req.user.uid, file);
  }

  @Post('upload-audio')
  @UseInterceptors(
    FileInterceptor('audio', {
      storage: memoryStorage(),
      fileFilter: (req, file, cb) => {
        const allowed = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/x-m4a', 'audio/mp4'];
        if (!allowed.includes(file.mimetype)) {
          return cb(new BadRequestException('Only audio files are allowed (MP3, WAV, OGG, WebM, M4A)'), false);
        }
        cb(null, true);
      },
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  uploadAudio(@UploadedFile() file: Express.Multer.File, @Req() req: any) {
    if (!file) throw new BadRequestException('No audio file uploaded');
    return this.filesService.upload(req.user.uid, file);
  }

  @Post('upload-image')
  @UseInterceptors(
    FileInterceptor('image', {
      storage: memoryStorage(),
      fileFilter: (req, file, cb) => {
        const allowed = ['image/png', 'image/jpeg', 'image/webp'];
        if (!allowed.includes(file.mimetype)) {
          return cb(new BadRequestException('Only image files are allowed (PNG, JPEG, WEBP)'), false);
        }
        cb(null, true);
      },
      limits: { fileSize: 20 * 1024 * 1024 },
    }),
  )
  uploadImage(@UploadedFile() file: Express.Multer.File, @Req() req: any) {
    if (!file) throw new BadRequestException('No image file uploaded');
    return this.filesService.upload(req.user.uid, file);
  }

  @Post('upload-avatar')
  @UseInterceptors(
    FileInterceptor('avatar', {
      storage: memoryStorage(),
      fileFilter: (req, file, cb) => {
        const allowedMimeTypes = ['image/png', 'image/jpeg', 'image/webp'];
        if (!allowedMimeTypes.includes(file.mimetype)) {
          return cb(new BadRequestException('Only PNG, JPEG, or WEBP images are allowed'), false);
        }
        cb(null, true);
      },
      limits: { fileSize: 5 * 1024 * 1024 },
    }),
  )
  uploadAvatar(@UploadedFile() file: Express.Multer.File, @Req() req: any) {
    if (!file) throw new BadRequestException('No avatar image uploaded');
    return this.filesService.uploadAvatar(req.user.uid, file);
  }

  @Get()
  findAll(
    @Req() req: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('name') name?: string,
  ) {
    const paginate = page !== undefined || limit !== undefined;
    const parsedPage = Number(page) > 0 ? Number(page) : 1;
    const parsedLimit = Number(limit) > 0 ? Number(limit) : 6;
    return this.filesService.findAllByUser(req.user.uid, {
      page: parsedPage,
      limit: parsedLimit,
      name: name || undefined,
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
}
