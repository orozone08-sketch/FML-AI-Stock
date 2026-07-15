export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ACCOUNTING: DurableObjectNamespace;
  ASSETS: Fetcher;
  APP_ENV: string;
  SITE_URL: string;
  DEPLOY_COMMIT?: string;
  SESSION_HMAC_KEY: string;
  CSRF_HMAC_KEY: string;
  BOOTSTRAP_ADMIN_EMAIL?: string;
  BOOTSTRAP_ADMIN_PASSWORD?: string;
}
export interface AuthUser {
  id: number;
  name: string;
  email: string;
  role: Role;
  companyId: number | null;
  activeCompanyId: number | null;
  forcePasswordChange: boolean;
  permissions: Record<string, ReadonlySet<Action>>;
  csrfToken: string;
  sessionId: number;
}

export type Role = "ADMIN" | "STOCK" | "SALES" | "ACCOUNTS" | "VIEWER";
export type Action = "view" | "create" | "edit" | "approve" | "export" | "deactivate";

export interface AppVariables {
  user: AuthUser | null;
  requestId: string;
}

export interface D1Meta {
  rows_read?: number;
  rows_written?: number;
  duration?: number;
}

export interface CommandEnvelope<T = unknown> {
  type: string;
  userId: number;
  companyId: number | null;
  idempotencyKey: string;
  requestDigest: string;
  payload: T;
}
