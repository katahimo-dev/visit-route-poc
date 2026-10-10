import { describe, expect, it } from 'vitest';
import { CODE_TTL_MS, canSend, issue, loginCodeId, MAX_ATTEMPTS, newCode, shouldRevoke, verify } from './login';

const now = Date.parse('2026-10-20T00:00:00Z');
const day = 86400000;

describe('ログインコード', () => {
  it('6桁の数字', () => {
    for (let i = 0; i < 50; i++) expect(newCode()).toMatch(/^\d{6}$/);
  });
  it('メールアドレスの大文字小文字・前後の空白は同じ ID', () => {
    expect(loginCodeId(' A@example.com ')).toBe(loginCodeId('a@example.com'));
  });
  it('正しいコードは ok、違えば wrong、期限切れ・試行上限は expired', () => {
    const doc = issue(null, '123456', now);
    expect(doc.codeHash).not.toContain('123456');
    expect(verify(doc, '123456', now + 1000)).toBe('ok');
    expect(verify(doc, '654321', now + 1000)).toBe('wrong');
    expect(verify(doc, '123456', now + CODE_TTL_MS)).toBe('expired');
    expect(verify({ ...doc, attempts: MAX_ATTEMPTS }, '123456', now)).toBe('expired');
    expect(verify(null, '123456', now)).toBe('expired');
  });
  it('新しいコードを出すと前のコードは使えない', () => {
    const first = issue(null, '111111', now);
    const second = issue(first, '222222', now + 61000);
    expect(verify(second, '111111', now + 62000)).toBe('wrong');
    expect(second.attempts).toBe(0);
  });
  it('送信は60秒あけ、1時間に5回まで', () => {
    let doc = issue(null, '000000', now);
    expect(canSend(doc, now + 30000)).toBe(false);
    expect(canSend(doc, now + 61000)).toBe(true);
    for (let i = 1; i < 5; i++) doc = issue(doc, '000000', now + i * 61000);
    expect(canSend(doc, now + 6 * 61000)).toBe(false);
    expect(canSend(doc, now + 3600_000 + 1000)).toBe(true);
  });
});

describe('使っていないアカウントの再認証', () => {
  const base = { tokensValidAfterMs: now - 100 * day, now };
  it('スタッフは14日、管理者は3日を超えたら切る', () => {
    expect(shouldRevoke({ ...base, role: 'staff', lastActiveMs: now - 13 * day })).toBe(false);
    expect(shouldRevoke({ ...base, role: 'staff', lastActiveMs: now - 15 * day })).toBe(true);
    expect(shouldRevoke({ ...base, role: 'admin', lastActiveMs: now - 2 * day })).toBe(false);
    expect(shouldRevoke({ ...base, role: 'admin', lastActiveMs: now - 4 * day })).toBe(true);
    expect(shouldRevoke({ ...base, role: 'operator', lastActiveMs: now - 4 * day })).toBe(true);
  });
  it('クレームの無い人・切ったあと使っていない人は切らない', () => {
    expect(shouldRevoke({ ...base, role: undefined, lastActiveMs: now - 30 * day })).toBe(false);
    expect(shouldRevoke({ role: 'staff', lastActiveMs: now - 30 * day, tokensValidAfterMs: now - 15 * day, now })).toBe(
      false,
    );
  });
});
