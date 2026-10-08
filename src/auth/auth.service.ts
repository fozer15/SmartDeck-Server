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
    let decodedToken: admin.auth.DecodedIdToken;

    try {
      // Verify Firebase ID token
      decodedToken = await this.firebaseApp.auth().verifyIdToken(dto.idToken);
    } catch (error) {
      console.error('Error verifying Firebase ID token:', error);
      throw new UnauthorizedException('Invalid Firebase token');
    }

    // Database/profile failures must not be reported as invalid Firebase
    // tokens. Anonymous users legitimately have no email until they link an
    // account, so `email` remains undefined for their initial guest profile.
    const { uid, email, name, picture } = decodedToken;
    const {school, degree, name: onboardingName, lang, deviceId} = dto;
    const user = await this.usersService.findOrCreate({
      id: uid,
      email,
      school: school || undefined,
      degree: degree || undefined,
      preferredLanguage: (lang as AppLanguage) || 'en',
      name: onboardingName || name || undefined,
      avatarUrl: picture || undefined,
      deviceId,
    });

    return {
      user,
      accessToken: dto.idToken,
    };
  }

  async verifyToken(idToken: string) {
    try {
      const decodedToken = await this.firebaseApp.auth().verifyIdToken(idToken);
      return decodedToken;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
