import { isSignInWithEmailLink, sendSignInLinkToEmail, signInWithEmailLink } from 'firebase/auth';
import { useEffect, useState } from 'react';
import { auth } from '../../lib/firebase';

const EMAIL_KEY = 'vrp.signInEmail';

/** メールリンクでログイン（パスワードを覚えなくてよい） */
export function LoginPage() {
  const [email, setEmail] = useState(localStorage.getItem(EMAIL_KEY) ?? '');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needEmail, setNeedEmail] = useState(false);
  const linkMode = isSignInWithEmailLink(auth, location.href);

  useEffect(() => {
    if (!linkMode) return;
    const saved = localStorage.getItem(EMAIL_KEY);
    if (!saved) {
      // 別の端末・ブラウザでリンクを開いたとき
      setNeedEmail(true);
      return;
    }
    signInWithEmailLink(auth, saved, location.href)
      .then(() => history.replaceState(null, '', '/'))
      .catch(() => setError('リンクの期限が切れています。もう一度メールを送ってください'));
  }, [linkMode]);

  const send = async () => {
    setError(null);
    try {
      localStorage.setItem(EMAIL_KEY, email);
      await sendSignInLinkToEmail(auth, email, { url: `${location.origin}/`, handleCodeInApp: true });
      setSent(true);
    } catch {
      setError('送れませんでした。メールアドレスを確かめてください');
    }
  };

  const finish = async () => {
    setError(null);
    try {
      await signInWithEmailLink(auth, email, location.href);
      localStorage.setItem(EMAIL_KEY, email);
      history.replaceState(null, '', '/');
    } catch {
      setError('ログインできませんでした。もう一度メールを送ってください');
    }
  };

  return (
    <div className="staff-shell stack" style={{ paddingTop: 48 }}>
      <h1>訪問ルート</h1>
      <div className="card stack">
        {linkMode && !needEmail && !error && <p>ログインしています…</p>}
        {(needEmail || (!linkMode && !sent)) && (
          <>
            <label>
              メールアドレス
              <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            {needEmail ? (
              <button type="button" className="btn btn-primary btn-big" disabled={!email} onClick={finish}>
                ログインする
              </button>
            ) : (
              <button type="button" className="btn btn-primary btn-big" disabled={!email} onClick={send}>
                メールを送る
              </button>
            )}
            {!needEmail && <p className="sub">届いたメールのリンクを、このスマホで開くとログインできます。</p>}
          </>
        )}
        {sent && (
          <>
            <h2>メールを送りました</h2>
            <p>{email} に届いたメールのリンクを押してください。</p>
            <button type="button" className="btn" onClick={() => setSent(false)}>
              送り直す
            </button>
          </>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
