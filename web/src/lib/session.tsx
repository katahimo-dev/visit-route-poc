import { DEFAULT_TERMS, type Org, type Role, type Terms } from '@vrp/shared';
import { onIdTokenChanged, signOut, type User } from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { auth, db } from './firebase';

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
        setState({ loading: false, session: null });
        return;
      }
      const { claims } = await user.getIdTokenResult();
      const role = (claims.role as Role | undefined) ?? null;
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

export const logout = () => signOut(auth);
