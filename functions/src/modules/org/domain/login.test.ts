import { describe, expect, it } from 'vitest';
import {
  CODE_TTL_MS,
  canSend,
  checkDemoPassword,
  demoPasswordHash,
  demoStaffOf,
  failed,
  isDemoStaffId,
  issue,
  loginCodeId,
  MAX_ATTEMPTS,
  MAX_DEMO_STAFF,
  MAX_FAILURES_PER_DAY,
  newCode,
  shouldRevoke,
  verify,
} from './login';

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
  it('24時間に間違いが多すぎたら、コードを出さず照合もしない（新しいコードを出しても引き継ぐ）', () => {
    let doc = issue(null, '123456', now);
    for (let i = 0; i < MAX_FAILURES_PER_DAY; i++) doc = { ...doc, ...failed(doc, now + i) };
    const next = issue(doc, '123456', now + 1000);
    expect(canSend(next, now + 3600_000)).toBe(false);
    expect(verify(next, '123456', now + 2000)).toBe('expired');
    expect(canSend(next, now + 86400_000 + 1000)).toBe(true);
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

describe('デモのスタッフ', () => {
  it('seed が作った在籍中の人だけを番号順に、その日の件数（取り消しを除く）つきで返す', () => {
    const staff = [
      { id: 's10', name: '十', active: true },
      { id: 's2', name: '二', active: true },
      { id: 's3', name: '休止', active: false },
      { id: '0b6f4c1e-added-by-demo-admin', name: 'こちらへログイン', active: true },
    ];
    const visits = [
      { staffId: 's2', cancelled: false },
      { staffId: 's2', cancelled: true },
      { staffId: null, cancelled: false },
      { staffId: 's10', cancelled: false },
    ];
    expect(demoStaffOf(staff, visits)).toEqual([
      { id: 's2', name: '二', visits: 1 },
      { id: 's10', name: '十', visits: 1 },
    ]);
  });
  it('件数に上限がある', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ id: `s${i + 1}`, name: `${i}`, active: true }));
    expect(demoStaffOf(many, [])).toHaveLength(MAX_DEMO_STAFF);
  });
  it('seed の ID の形だけを通す', () => {
    expect(isDemoStaffId('s1')).toBe(true);
    expect(isDemoStaffId('s1/x')).toBe(false);
    expect(isDemoStaffId('staff1')).toBe(false);
  });
});

describe('デモの簡易パスワード', () => {
  const hash = demoPasswordHash('cutest1234');
  it('合っていれば通し、違う・ハッシュ未設定・形の違うハッシュなら通さない', () => {
    expect(checkDemoPassword('cutest1234', hash)).toBe(true);
    expect(checkDemoPassword('cutest12345', hash)).toBe(false);
    expect(checkDemoPassword('cutest1234', '')).toBe(false);
    expect(checkDemoPassword('cutest1234', 'zz')).toBe(false);
  });
  it('設定ファイルにはパスワードそのものを置かない（ハッシュは64桁の16進）', () => {
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('cutest');
  });
});
