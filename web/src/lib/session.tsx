import { DEFAULT_TERMS, type Org, type Role, type Terms } from '@vrp/shared';
import { onIdTokenChanged, signOut, type User } from 'firebase/auth';
import { doc, onSnapshot, waitForPendingWrites } from 'firebase/firestore';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { auth, CACHE_KEY, CLEAR_KEY, db, persistent } from './firebase';

/** 端末のデータを消して読み込み直す（消すのは次の起動時、SDK を使う前。firebase.ts） */
function clearAndReload(): void {
  localStorage.removeItem(CACHE_KEY);
  localStorage.setItem(CLEAR_KEY, '1');
  location.reload();
}

export type Session = {
  user: User;
  role: Role | null;
  orgId: string | null;
  staffId: string | null;
  org: Org | null;
  terms: Terms;
};

type State = { loading: boolean; session: Session | null };
const Ctx = createContext<State>({ loading: true, session: null });

/** ログイン状態とクレーム（事業所・ロール・スタッフ）と事業所設定 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ loading: true, session: null });
  useEffect(() => {
    let unsubOrg: (() => void) | null = null;
    const unsub = onIdTokenChanged(auth, async (user) => {
      unsubOrg?.();
      unsubOrg = null;
      if (!user) {
        // ログアウト・再認証切れ（使わなかった日数が過ぎた等）。端末に残ったデータを消す。
        // 未送信の記録は、ログインしていない状態ではルールで拒まれ送れないので、残しても意味がない
        if (persistent) {
          setState({ loading: true, session: null });
          clearAndReload();
          return;
        }
        setState({ loading: false, session: null });
        return;
      }
      const { claims } = await user.getIdTokenResult();
      const role = (claims.role as Role | undefined) ?? null;
      // スタッフだけ端末に保存する。前回と違えば設定を変えて読み込み直す（firebase.ts）
      const wantPersistent = role === 'staff';
      if (wantPersistent !== persistent && !localStorage.getItem(CLEAR_KEY)) {
        if (wantPersistent) {
          localStorage.setItem(CACHE_KEY, '1');
          location.reload();
        } else clearAndReload();
        return;
      }
      const orgId = (claims.orgId as string | undefined) ?? null;
      const staffId = (claims.staffId as string | undefined) ?? null;
      const base: Session = { user, role, orgId, staffId, org: null, terms: DEFAULT_TERMS.other };
      if (!orgId) {
        setState({ loading: false, session: base });
        return;
      }
      unsubOrg = onSnapshot(
        doc(db, 'orgs', orgId),
        (s) => {
          const org = (s.data() as Org | undefined) ?? null;
          setState({ loading: false, session: { ...base, org, terms: org?.terms ?? DEFAULT_TERMS.other } });
        },
        () => setState({ loading: false, session: base }),
      );
    });
    return () => {
      unsub();
      unsubOrg?.();
    };
  }, []);
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export const useSessionState = () => useContext(Ctx);

/** ログイン済みの画面でだけ使う */
export function useSession(): Session {
  const s = useContext(Ctx).session;
  if (!s) throw new Error('not signed in');
  return s;
}

/**
 * ログアウト。端末に保存したデータ（訪問先の住所など）も消す。
 * 送れていない記録があるときは、消えてよいか確かめる（false を返したらやめた）。
 */
export async function logout(): Promise<boolean> {
  const sent = await Promise.race([
    waitForPendingWrites(db).then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 3000)),
  ]);
  if (!sent && !confirm('未送信の記録があります。ログアウトすると消えます。ログアウトしますか？')) return false;
  // 端末のデータは onIdTokenChanged（ログインしていない状態になったとき）で消す
  await signOut(auth);
  return true;
}
