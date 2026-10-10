import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import {
  connectFirestoreEmulator,
  initializeFirestore,
  memoryLocalCache,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';

/** SDK の初期化はここだけで行う（AGENTS.md） */
const env = import.meta.env;
export const app = initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY || 'demo-key',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || 'localhost',
  projectId: env.VITE_FIREBASE_PROJECT_ID || 'demo-visit-route',
  appId: env.VITE_FIREBASE_APP_ID || 'demo-app',
});

export const auth = getAuth(app);

/**
 * 端末にデータを保存するか（ADR-0007）。スタッフのスマホだけ保存する（電波が無いときの記録は端末に残り、
 * つながったら送られる。R9）。管理者の PC は保存しない（閉じれば消える）。
 * 役割はログインして初めて分かるので、前回の役割を覚えておき、違っていたら読み込み直す（session.tsx）。
 */
export const CACHE_KEY = 'vrp.persistentCache';
export const persistent = localStorage.getItem(CACHE_KEY) === '1';
export const db = initializeFirestore(app, {
  localCache: persistent
    ? persistentLocalCache({ tabManager: persistentMultipleTabManager() })
    : memoryLocalCache(),
});
export const functions = getFunctions(app, 'asia-northeast1');

if (env.VITE_USE_EMULATORS === 'true') {
  const host = location.hostname;
  connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, host, 8080);
  connectFunctionsEmulator(functions, host, 5001);
}
