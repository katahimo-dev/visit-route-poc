import { signInWithCustomToken } from 'firebase/auth';
import { useState } from 'react';
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
    throw new LoginError('ログインできませんでした。電波のよい場所でもう一度お試しください');
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

  const demo = (as: 'admin' | 'staff') =>
    run(async () => {
      const { token } = await call('demoSignIn', { as });
      await signIn(token);
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
              コードを送る
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
              ログインする
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setStep('email')}>
              メールアドレスを直す・送り直す
            </button>
          </>
        )}
        {error && <p className="error">{error}</p>}
      </div>
      {DEMO && (
        <div className="card stack">
          <h2>デモで試す</h2>
          <p className="sub">架空の事業所のデータで、メールなしで画面を試せます。</p>
          <button type="button" className="btn" disabled={busy} onClick={() => demo('staff')}>
            スタッフとして試す
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => demo('admin')}>
            管理者として試す
          </button>
        </div>
      )}
    </div>
  );
}
