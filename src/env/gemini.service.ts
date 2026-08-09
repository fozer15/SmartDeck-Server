import { Injectable } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { EnvService } from './env.service';

type GenerateContentRequest = Parameters<GoogleGenAI['models']['generateContent']>[0];
type UploadFileRequest = Parameters<GoogleGenAI['files']['upload']>[0];
type DeleteFileRequest = Parameters<GoogleGenAI['files']['delete']>[0];

@Injectable()
export class GeminiService {
  private readonly client: GoogleGenAI;

  constructor(private readonly env: EnvService) {
    this.client = new GoogleGenAI({ apiKey: env.geminiApiKey });
  }

  generateContent(request: Omit<GenerateContentRequest, 'model'> & { model?: string }) {
    return this.client.models.generateContent({
      ...request,
      model: request.model ?? this.env.geminiModel,
    });
  }

  /**
   * Quiz generation + tutor-chat use a separate, cheaper model
   * (GEMINI_MODEL_QUIZ). Falls back to GEMINI_MODEL if the env var is unset.
   */
  generateContentWithQuizModel(request: Omit<GenerateContentRequest, 'model'> & { model?: string }) {
    return this.client.models.generateContent({
      ...request,
      model: request.model ?? this.env.geminiModelQuiz,
    });
  }

  uploadFile(request: UploadFileRequest) {
    return this.client.files.upload(request);
  }

  deleteFile(request: DeleteFileRequest) {
    return this.client.files.delete(request);
  }
}