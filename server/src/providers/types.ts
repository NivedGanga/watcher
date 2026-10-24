/** A drizzle database handle or transaction — both support query methods. */
export type DbLike = unknown;

export interface VerifiedToken {
  uid: string;
  email: string;
  emailVerified: boolean;
}

export interface AuthProvider {
  verifyIdToken(token: string): Promise<VerifiedToken | null>;
}

export interface PushMessage {
  token: string;
  data: Record<string, string>;
  headers: Record<string, string>;
}

export class PushError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const PUSH_NOT_REGISTERED = 'messaging/registration-token-not-registered';

export interface PushProvider {
  send(message: PushMessage): Promise<void>;
}

export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}

export interface JobRunner {
  enqueue(
    kind: string,
    payload: Record<string, unknown>,
    runAt: Date,
    opts?: { dbOrTx?: DbLike; dedupeKey?: string },
  ): Promise<void>;
}

export interface HealthCheck {
  ping(url: string): Promise<void>;
}

export interface Deps {
  auth: AuthProvider;
  push: PushProvider;
  email: EmailProvider;
  jobs: JobRunner;
  healthcheck: HealthCheck;
}
