import admin from 'firebase-admin';
import type { AuthProvider, VerifiedToken, PushProvider, PushMessage } from './types.js';
import { PushError } from './types.js';

let app: admin.app.App | null = null;

function firebaseApp(projectId: string, serviceAccountJsonB64: string): admin.app.App {
  if (!app) {
    const serviceAccount = JSON.parse(
      Buffer.from(serviceAccountJsonB64, 'base64').toString('utf8'),
    ) as admin.ServiceAccount;
    app = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId,
    });
  }
  return app;
}

export class FirebaseAuthProvider implements AuthProvider {
  constructor(
    private projectId: string,
    private serviceAccountJsonB64: string,
  ) {}

  async verifyIdToken(token: string): Promise<VerifiedToken | null> {
    try {
      const decoded = await firebaseApp(this.projectId, this.serviceAccountJsonB64)
        .auth()
        .verifyIdToken(token);
      if (!decoded.email) return null;
      return {
        uid: decoded.uid,
        email: decoded.email,
        emailVerified: decoded.email_verified === true,
      };
    } catch {
      return null;
    }
  }
}

export class FcmPushProvider implements PushProvider {
  constructor(
    private projectId: string,
    private serviceAccountJsonB64: string,
  ) {}

  async send(message: PushMessage): Promise<void> {
    try {
      await firebaseApp(this.projectId, this.serviceAccountJsonB64)
        .messaging()
        .send({
          token: message.token,
          data: message.data,
          webpush: { headers: message.headers },
        });
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err && typeof err.code === 'string'
          ? err.code
          : 'messaging/internal-error';
      // Never include the FCM token or message content in the error.
      throw new PushError(code, 'FCM send failed');
    }
  }
}
