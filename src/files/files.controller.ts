import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Req,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { FilesService } from './files.service';
import { AuthGuard } from '../auth/auth.guard';

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
  findAll(@Req() req: any) {
    return this.filesService.findAllByUser(req.user.uid);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) {
    return this.filesService.findOne(id, req.user.uid);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any) {
    return this.filesService.remove(id, req.user.uid);
  }
}
