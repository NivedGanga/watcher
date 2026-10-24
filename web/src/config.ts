// Build-time configuration. Every value is public (shipped to the browser);
// secrets never belong in this app.

export const REQUIRED_ENV = [
  'VITE_API_BASE_URL',
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_APP_ID',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FCM_VAPID_KEY',
] as const;

export type EnvName = (typeof REQUIRED_ENV)[number];

export interface AppConfig {
  apiBaseUrl: string;
  firebase: {
    apiKey: string;
    authDomain: string;
    projectId: string;
    appId: string;
    messagingSenderId: string;
  };
  vapidKey: string;
}

export function missingVars(env: Record<string, string | undefined>): EnvName[] {
  return REQUIRED_ENV.filter((name) => !env[name]);
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const missing = missingVars(env);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. ` +
        `Set ${missing.length > 1 ? 'them' : 'it'} in web/.env.local (see README).`,
    );
  }
  return {
    apiBaseUrl: env.VITE_API_BASE_URL!.replace(/\/+$/, ''),
    firebase: {
      apiKey: env.VITE_FIREBASE_API_KEY!,
      authDomain: env.VITE_FIREBASE_AUTH_DOMAIN!,
      projectId: env.VITE_FIREBASE_PROJECT_ID!,
      appId: env.VITE_FIREBASE_APP_ID!,
      messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID!,
    },
    vapidKey: env.VITE_FCM_VAPID_KEY!,
  };
}

export function getConfig(): AppConfig {
  return loadConfig(import.meta.env as Record<string, string | undefined>);
}
