import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import { getMessaging, isSupported, type Messaging } from 'firebase/messaging';
import { getConfig } from '../config';

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let messaging: Messaging | null | undefined;

export function firebaseApp(): FirebaseApp {
  if (!app) app = initializeApp(getConfig().firebase);
  return app;
}

export function firebaseAuth(): Auth {
  if (!auth) auth = getAuth(firebaseApp());
  return auth;
}

// Resolves to a Messaging instance, or null when FCM isn't supported in this
// browser (e.g. iOS Safari outside a home-screen install).
export async function firebaseMessaging(): Promise<Messaging | null> {
  if (messaging === undefined) {
    messaging = (await isSupported().catch(() => false)) ? getMessaging(firebaseApp()) : null;
  }
  return messaging;
}

export function resetFirebaseForTests(): void {
  app = null;
  auth = null;
  messaging = undefined;
}
