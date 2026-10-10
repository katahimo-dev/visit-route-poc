import { CALLABLES, type CallableName } from '@vrp/shared';
import { FirebaseError } from 'firebase/app';
import { httpsCallable } from 'firebase/functions';
import type { z } from 'zod';
import { functions } from './firebase';

type Req<N extends CallableName> = z.input<(typeof CALLABLES)[N]['req']>;
type Res<N extends CallableName> = z.infer<(typeof CALLABLES)[N]['res']>;

/** 業務関数の呼び出し。入出力は packages/shared の契約で検査する */
export async function call<N extends CallableName>(name: N, data: Req<N>): Promise<Res<N>> {
  const def = CALLABLES[name];
  const req = def.req.parse(data);
  const res = await httpsCallable(functions, name)(req);
  return def.res.parse(res.data) as Res<N>;
}

/** 利用者に見せるメッセージ（業務関数は日本語の message を返す） */
export function messageOf(e: unknown): string {
  if (e instanceof FirebaseError) {
    if (e.code === 'functions/unavailable' || e.code === 'unavailable') return e.message || '一時的に使えません。時間をおいて再度お試しください';
    return e.message || 'うまくいきませんでした';
  }
  return 'うまくいきませんでした。電波のよい場所でもう一度お試しください';
}

/** CSV をファイルとして保存する */
export function saveCsv(name: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
