import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { UsersService } from '../users/users.service';
import { EnvService } from '../env/env.service';
import { SignInDto } from './dto/sign-in.dto';
import { AppLanguage } from '@prisma/client';


const APP_LANGUAGE_LABELS: Record<AppLanguage, string> = {
  en: 'English',
  zh: 'Chinese',
  hi: 'Hindi',
  es: 'Spanish',
  fr: 'French',
  tr: 'Turkish',
  pt: 'Portuguese'
};

@Injectable()
export class AuthService {
  private firebaseApp: admin.app.App;

  constructor(
    private env: EnvService,
    private usersService: UsersService,
  ) {
    // Initialize Firebase Admin SDK
    this.firebaseApp = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: env.firebaseProjectId,
        clientEmail: env.firebaseClientEmail,
        privateKey: env.firebasePrivateKey,
      }),
    });
  }

  async signIn(dto:SignInDto) {
    try {
      // Verify Firebase ID token
      const decodedToken = await admin.auth().verifyIdToken(dto.idToken);
      
      // Extract user info from Firebase token
      const { uid, email, name, picture, firebase } = decodedToken;
      const {school,degree,name:OnboardingName, lang, deviceId} = dto;
      const user = await this.usersService.findOrCreate({
        id: uid,
        email: email,
        school:school || undefined,
        degree:degree || undefined,
        preferredLanguage:lang as AppLanguage || "en",
        name: OnboardingName || name || undefined,
        avatarUrl: picture || undefined,
        deviceId
      });

      return {
        user,
        accessToken: dto.idToken, // You can use Firebase token or generate your own JWT
      };
    } catch (error) {
      console.error('Error verifying Firebase ID token:', error);
      throw new UnauthorizedException('Invalid Firebase token');
    }
  }

  async verifyToken(idToken: string) {
    try {
      const decodedToken = await admin.auth().verifyIdToken(idToken);
      return decodedToken;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
