import express from 'express';
import multer from 'multer';
import pdf from 'pdf-parse';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const quizQuestionSchema = z.object({
  question: z.string().describe("The quiz question text"),
  options: z.array(z.string()).length(4).describe("Four multiple choice options"),
  correctAnswer: z.string().describe("The correct answer from the options"),
  explanation: z.string().describe("Brief explanation of why this answer is correct"),
  difficulty: z.enum(["easy", "medium", "hard"]).describe("Difficulty level of the question"),
  topic: z.string().describe("The main topic or concept this question covers")
});

const quizResponseSchema = z.object({
  quizzes: z.array(quizQuestionSchema).describe("Array of quiz questions")
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, file.fieldname + '-' + Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname))
  }),
  fileFilter: (req, file, cb) => cb(file.mimetype === 'application/pdf' ? null : new Error('Only PDF files allowed'), file.mimetype === 'application/pdf'),
  limits: { fileSize: 10 * 1024 * 1024 }
});

app.post('/api/generate-quiz', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded' });
    if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'Gemini API key not configured' });
    const filePath = path.join(__dirname, req.file.path);
    const pdfData = await pdf(fs.readFileSync(filePath));
    const customInstructions = req.body.instructions || '';
    const systemPrompt = `You are an expert educational content creator specialized in generating quiz questions from study materials.

Your task is to analyze the provided text and create high-quality quiz questions that test understanding of the key concepts.

Generate quiz questions in the following JSON format:
{
  "quizzes": [
    {
      "question": "The question text",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correctAnswer": "The correct option",
      "explanation": "Brief explanation of why this is correct",
      "difficulty": "easy|medium|hard",
      "topic": "The main topic this question covers"
    }
  ]
}

Guidelines:
- Create 5-10 questions covering the main topics
- Mix difficulty levels (easy, medium, hard)
- Ensure questions are clear and unambiguous
- Include 4 options for each question
- Provide helpful explanations
- Focus on understanding, not just memorization

${customInstructions ? `Additional instructions: ${customInstructions}` : ''}`;

    const response = await genAI.models.generateContent({
      model: 'gemini-3.1-flash-lite-preview',
      contents: `${systemPrompt}\n\nHere is the content from the PDF:\n\n${pdfData.text}\n\nPlease generate quiz questions based on this content.`,
      config: {
        responseMimeType: 'application/json',
        responseJsonSchema: zodToJsonSchema(quizResponseSchema)
      }
    });
    const quizData = quizResponseSchema.parse(JSON.parse(response.text));
    fs.unlinkSync(filePath);
    res.json({
      success: true,
      message: 'Quiz generated successfully',
      data: {
        filename: req.file.originalname,
        pages: pdfData.numpages,
        quiz: quizData,
        generatedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to generate quiz', details: error.message });
  }
});

app.use((err, req, res, next) => {
  res.status(500).json({ success: false, error: 'Something went wrong!', details: err.message });
});

app.listen(PORT);
