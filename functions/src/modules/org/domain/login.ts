import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * メールの6桁コードでのログインと、使っていないアカウントの再認証（ADR-0007）。純粋関数。
 */

export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
/** 同じアドレスへの送信：前回から60秒あける、1時間に5回まで */
export const RESEND_INTERVAL_MS = 60 * 1000;
export const MAX_SENDS_PER_HOUR = 5;

export type LoginCodeDoc = {
  codeHash: string;
  salt: string;
  expiresAt: number;
  attempts: number;
  /** 直近1時間の送信時刻 */
  sentAt: number[];
};

/** コードの文書ID（メールアドレスをそのまま ID にしない） */
export function loginCodeId(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

export function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function hashCode(code: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${code}`).digest('hex');
}

/** 新しいコードを発行した文書。前のコードは無効になり、送信の履歴は引き継ぐ */
export function issue(prev: LoginCodeDoc | null, code: string, now: number): LoginCodeDoc {
  const salt = randomBytes(16).toString('hex');
  return {
    codeHash: hashCode(code, salt),
    salt,
    expiresAt: now + CODE_TTL_MS,
    attempts: 0,
    sentAt: [...recentSends(prev, now), now],
  };
}

function recentSends(doc: LoginCodeDoc | null, now: number): number[] {
  return (doc?.sentAt ?? []).filter((t) => now - t < 3600_000);
}

/** 送ってよいか（連打・乱発を防ぐ） */
export function canSend(doc: LoginCodeDoc | null, now: number): boolean {
  const sends = recentSends(doc, now);
  if (sends.length >= MAX_SENDS_PER_HOUR) return false;
  return sends.every((t) => now - t >= RESEND_INTERVAL_MS);
}

export type VerifyResult = 'ok' | 'wrong' | 'expired';

/** コードを確かめる。期限切れ・試行回数の上限は expired（新しいコードを送ってもらう） */
export function verify(doc: LoginCodeDoc | null, code: string, now: number): VerifyResult {
  if (!doc || doc.expiresAt <= now || doc.attempts >= MAX_ATTEMPTS) return 'expired';
  const a = Buffer.from(hashCode(code, doc.salt), 'hex');
  const b = Buffer.from(doc.codeHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b) ? 'ok' : 'wrong';
}

/** 使わなかったら再認証にするまでの日数（スタッフ14日、管理者・運営者3日） */
export function inactivityDays(role: unknown): number | null {
  if (role === 'staff') return 14;
  if (role === 'admin' || role === 'operator') return 3;
  return null;
}

/**
 * ログインの継続を切るか。lastActiveMs はトークンを最後に更新した時刻（アプリを使っている間は1時間ごとに更新される）。
 * すでに切った人（切ったあと使っていない人）は、もう一度は切らない。
 */
export function shouldRevoke(u: {
  role: unknown;
  lastActiveMs: number | null;
  tokensValidAfterMs: number | null;
  now: number;
}): boolean {
  const days = inactivityDays(u.role);
  if (days === null || u.lastActiveMs === null) return false;
  if (u.tokensValidAfterMs !== null && u.tokensValidAfterMs >= u.lastActiveMs) return false;
  return u.now - u.lastActiveMs > days * 86400000;
}
