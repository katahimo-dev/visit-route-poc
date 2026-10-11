import { jstDate } from '@vrp/shared';
import { signInWithCustomToken } from 'firebase/auth';
import { useEffect, useState } from 'react';
import { call, messageOf } from '../../lib/api';
import { auth } from '../../lib/firebase';

const EMAIL_KEY = 'vrp.signInEmail';
/** コード入力の途中か（メールを見に行っている間にアプリが読み込み直されても戻れるように） */
const STEP_KEY = 'vrp.loginStep';
/** デモ用のログインボタンを出すか（デモ用のプロジェクトのビルドだけ true） */
const DEMO = import.meta.env.VITE_DEMO_LOGIN === 'true';

class LoginError extends Error {}

async function signIn(token: string): Promise<void> {
  await signInWithCustomToken(auth, token).catch(() => {
    throw new LoginError('ログインできませんでした。電波の良い場所で再度お試しください');
  });
}

/** メールに届く6桁のコードでログイン（アプリから出ずにログインできる。ADR-0007） */
export function LoginPage() {
  const [email, setEmail] = useState(localStorage.getItem(EMAIL_KEY) ?? '');
  const [code, setCode] = useState('');
  const [step, setStepState] = useState<'email' | 'code'>(
    sessionStorage.getItem(STEP_KEY) === 'code' ? 'code' : 'email',
  );
  const setStep = (s: 'email' | 'code') => {
    sessionStorage.setItem(STEP_KEY, s);
    setStepState(s);
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof LoginError ? e.message : messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const send = () =>
    run(async () => {
      await call('requestLoginCode', { email });
      localStorage.setItem(EMAIL_KEY, email.trim());
      setCode('');
      setStep('code');
    });

  const verify = () =>
    run(async () => {
      const { token } = await call('verifyLoginCode', { email, code });
      await signIn(token);
      sessionStorage.removeItem(STEP_KEY);
    });

  return (
    <div className="staff-shell stack" style={{ paddingTop: 48 }}>
      <h1>訪問ルート</h1>
      <div className="card stack">
        {step === 'email' ? (
          <>
            <label>
              メールアドレス
              <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <button type="button" className="btn btn-primary btn-big" disabled={!email || busy} onClick={send}>
              コードを送信
            </button>
            <p className="sub">メールに届く6桁の数字を、この画面に入力するとログインできます。</p>
            <button type="button" className="btn" disabled={!email || busy} onClick={() => setStep('code')}>
              届いたコードを入力する
            </button>
          </>
        ) : (
          <>
            <p>{email} に届いた6桁の数字を入力してください（10分間有効）。</p>
            <label>
              コード
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
            </label>
            <button
              type="button"
              className="btn btn-primary btn-big"
              disabled={code.length !== 6 || busy}
              onClick={verify}
            >
              ログイン
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setStep('email')}>
              メールアドレスの修正・再送信
            </button>
          </>
        )}
        {error && <p className="error">{error}</p>}
      </div>
      {DEMO && <DemoLogin busy={busy} run={run} />}
    </div>
  );
}

type DemoStaff = { id: string; name: string; visits: number };
/** 入れたデモのパスワード（ログアウトして別の人で入り直すときに、もう一度打たなくてよいように。タブを閉じれば消える） */
const DEMO_PW_KEY = 'vrp.demoPassword';

/**
 * デモで試す：簡易パスワードを入れると、管理者か、選んだスタッフとしてメールなしで入れる
 * （デモの事業所だけ。パスワードは不特定多数をはじくだけのもの。ADR-0007）
 */
function DemoLogin({ busy, run }: { busy: boolean; run: (fn: () => Promise<void>) => Promise<void> }) {
  const [password, setPassword] = useState(sessionStorage.getItem(DEMO_PW_KEY) ?? '');
  const [staff, setStaff] = useState<DemoStaff[] | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async (pw: string) => {
    setOpening(true);
    setError(null);
    try {
      const r = await call('demoStaffList', { password: pw, date: jstDate(Date.now()) });
      sessionStorage.setItem(DEMO_PW_KEY, pw);
      setStaff(r.staff);
    } catch (e) {
      sessionStorage.removeItem(DEMO_PW_KEY);
      setError(messageOf(e));
    } finally {
      setOpening(false);
    }
  };

  // 前に入れたパスワードがあれば、そのまま開く
  // biome-ignore lint/correctness/useExhaustiveDependencies: 最初の1回だけ
  useEffect(() => {
    const saved = sessionStorage.getItem(DEMO_PW_KEY);
    if (saved) open(saved);
  }, []);

  const enter = (as: 'admin' | 'staff', staffId: string | null = null) =>
    run(async () => {
      const { token } = await call('demoSignIn', { password, as, staffId });
      await signIn(token);
    });

  return (
    <div className="card stack">
      <h2>デモで試す</h2>
      <p className="sub">架空の事業所のデータで、メールなしで画面を試せます。</p>
      {staff === null ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            open(password);
          }}
        >
          <label>
            デモのパスワード
            <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <button type="submit" className="btn" disabled={!password || opening}>
            {opening ? '確認中…' : 'デモを開く'}
          </button>
          {error && <p className="error">{error}</p>}
        </form>
      ) : (
        <>
          <button type="button" className="btn" disabled={busy} onClick={() => enter('admin')}>
            管理者として試す（PC向け）
          </button>
          <strong>スタッフとして試す（スマホ向け）</strong>
          <div className="demo-staff">
            {staff.map((s) => (
              <button key={s.id} type="button" className="btn" disabled={busy} onClick={() => enter('staff', s.id)}>
                <span>{s.name}</span>
                <span className="sub">{s.visits > 0 ? `今日 ${s.visits}件` : '今日は休み'}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
