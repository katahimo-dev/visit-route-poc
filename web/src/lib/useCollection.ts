import {
  collection,
  doc,
  type DocumentData,
  onSnapshot,
  type Query,
  query,
  type QueryConstraint,
} from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { db } from './firebase';

export type WithId<T> = T & { id: string };

/**
 * orgs/{orgId}/{name} のリアルタイム購読。
 * depKey は条件が変わったときに購読し直すためのキー（例：日付）
 */
export function useOrgCollection<T>(orgId: string | null, name: string, constraints: QueryConstraint[] = [], depKey = '') {
  const [rows, setRows] = useState<WithId<T>[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: constraints は depKey で比較する
  useEffect(() => {
    if (!orgId) return;
    setRows(null);
    const q: Query<DocumentData> = query(collection(db, 'orgs', orgId, name), ...constraints);
    return onSnapshot(
      q,
      (s) => setRows(s.docs.map((d) => ({ id: d.id, ...(d.data() as T) }))),
      () => setError('読み込めませんでした'),
    );
  }, [orgId, name, depKey]);
  return { rows, error };
}

/** orgs/{orgId}/{name}/{id} のリアルタイム購読 */
export function useOrgDoc<T>(orgId: string | null, name: string, id: string | null) {
  const [data, setData] = useState<T | null | undefined>(undefined);
  useEffect(() => {
    if (!orgId || !id) return;
    return onSnapshot(
      doc(db, 'orgs', orgId, name, id),
      (s) => setData(s.exists() ? (s.data() as T) : null),
      () => setData(null),
    );
  }, [orgId, name, id]);
  return data;
}
