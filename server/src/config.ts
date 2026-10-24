export interface Config {
  databaseUrl: string;
  firebaseProjectId: string;
  firebaseServiceAccountJsonB64: string;
  resendApiKey: string;
  emailFrom: string;
  appUrl: string;
  corsOrigin: string;
  deviceTokenEncKey: string; // base64, 32 bytes
  machineKeyPepper: string;
  cronSecret: string;
  healthcheckUrl: string;
  awayMaxHours: number;
  returnIdleMinutes: number;
}

const REQUIRED = [
  'DATABASE_URL',
  'FIREBASE_PROJECT_ID',
  'FIREBASE_SERVICE_ACCOUNT_JSON_B64',
  'RESEND_API_KEY',
  'EMAIL_FROM',
  'APP_URL',
  'CORS_ORIGIN',
  'DEVICE_TOKEN_ENC_KEY',
  'MACHINE_KEY_PEPPER',
  'CRON_SECRET',
  'HEALTHCHECK_URL',
] as const;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  for (const name of REQUIRED) {
    if (!env[name]) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
  }
  const encKey = env.DEVICE_TOKEN_ENC_KEY!;
  const keyBytes = Buffer.from(encKey, 'base64');
  if (keyBytes.length !== 32) {
    throw new Error('DEVICE_TOKEN_ENC_KEY must be 32 random bytes, base64-encoded');
  }
  const awayMaxHours = Number(env.AWAY_MAX_HOURS ?? '8');
  const returnIdleMinutes = Number(env.RETURN_IDLE_MINUTES ?? '5');
  if (!Number.isFinite(awayMaxHours) || awayMaxHours <= 0) {
    throw new Error('AWAY_MAX_HOURS must be a positive number');
  }
  if (!Number.isFinite(returnIdleMinutes) || returnIdleMinutes <= 0) {
    throw new Error('RETURN_IDLE_MINUTES must be a positive number');
  }
  return {
    databaseUrl: env.DATABASE_URL!,
    firebaseProjectId: env.FIREBASE_PROJECT_ID!,
    firebaseServiceAccountJsonB64: env.FIREBASE_SERVICE_ACCOUNT_JSON_B64!,
    resendApiKey: env.RESEND_API_KEY!,
    emailFrom: env.EMAIL_FROM!,
    appUrl: env.APP_URL!.replace(/\/$/, ''),
    corsOrigin: env.CORS_ORIGIN!,
    deviceTokenEncKey: encKey,
    machineKeyPepper: env.MACHINE_KEY_PEPPER!,
    cronSecret: env.CRON_SECRET!,
    healthcheckUrl: env.HEALTHCHECK_URL!,
    awayMaxHours,
    returnIdleMinutes,
  };
}
