import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';
import { UsersService } from '../users/users.service';

@Injectable()
export class AuthService {
  private firebaseApp: admin.app.App;

  constructor(
    private config: ConfigService,
    private usersService: UsersService,
  ) {
    // Initialize Firebase Admin SDK
    this.firebaseApp = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: config.get('FIREBASE_PROJECT_ID'),
        clientEmail: config.get('FIREBASE_CLIENT_EMAIL'),
        privateKey: config.get('FIREBASE_PRIVATE_KEY')?.replace(/\\n/g, '\n'),
      }),
    });
  }

  async signIn(idToken: string) {
    try {
      // Verify Firebase ID token
      const decodedToken = await admin.auth().verifyIdToken(idToken);
      
      // Extract user info from Firebase token
      const { uid, email, name, picture, firebase } = decodedToken;
      
      const user = await this.usersService.findOrCreate({
        id: uid,
        email: email,
        name: name || undefined,
        avatarUrl: picture || undefined,
      });

      return {
        user,
        accessToken: idToken, // You can use Firebase token or generate your own JWT
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
