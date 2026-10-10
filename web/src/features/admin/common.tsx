import { addDays, jstDate, type Org, type Place, type Terms } from '@vrp/shared';
import { createContext, useContext, useState } from 'react';
import { RouteMap } from '../../components/RouteMap';
import { call, messageOf } from '../../lib/api';

/** 管理画面の共通部品（事業所の文脈・日付入力・住所入力） */

export type AdminCtx = { orgId: string; org: Org | null; terms: Terms; isOperator: boolean };
const Ctx = createContext<AdminCtx | null>(null);
export const AdminProvider = Ctx.Provider;
export function useAdmin(): AdminCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('AdminProvider がありません');
  return v;
}

/** 入力検査（zod）や通信の失敗を画面に出す文にする */
export function formError(e: unknown): string {
  if (e instanceof Error && 'issues' in e) {
    const issues = (e as unknown as { issues: { path: PropertyKey[]; message: string }[] }).issues;
    const i = issues[0];
    return i ? `${i.path.map(String).join('.')}：${i.message}` : '入力を確かめてください';
  }
  return messageOf(e);
}

/** 明日（日本時間） */
export const tomorrow = () => jstDate(Date.now() + 24 * 3600 * 1000);
export { addDays };

export function DateField({
  label = '日付',
  value,
  onChange,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label style={{ maxWidth: 200 }}>
      {label}
      <input type="date" value={value} onChange={(e) => e.target.value && onChange(e.target.value)} />
    </label>
  );
}

export const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'] as const;
export const GENDER_LABELS = { female: '女性', male: '男性', unspecified: '指定なし' } as const;
export const TRAVEL_MODE_LABELS = { DRIVE: '車', BICYCLE: '自転車', WALK: '徒歩', TRANSIT: '公共交通' } as const;

/** スタッフごとの線の色 */
export const STAFF_COLORS = [
  '#e8735f',
  '#4a7fc1',
  '#5aa57a',
  '#8e63b5',
  '#d99a2b',
  '#2f9ea0',
  '#b5546f',
  '#6b7a3a',
] as const;
export const staffColor = (i: number): string =>
  STAFF_COLORS[((i % STAFF_COLORS.length) + STAFF_COLORS.length) % STAFF_COLORS.length] ?? '#e8735f';

export const hasLocation = (p: Place): p is { address: string; lat: number; lng: number } =>
  p.lat !== null && p.lng !== null;

/** 住所＋位置の入力。「住所から位置を出す」で候補を選ぶか、地図をクリックして直す */
export function PlaceEditor({ value, onChange }: { value: Place; onChange: (p: Place) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<{ formattedAddress: string; lat: number; lng: number }[] | null>(null);

  const search = async () => {
    setBusy(true);
    setError(null);
    setCandidates(null);
    try {
      const r = await call('geocodeAddress', { address: value.address });
      setCandidates(r.candidates);
      if (r.candidates.length === 0) setError('候補が見つかりませんでした。地図をクリックして位置を決めてください');
    } catch (e) {
      setError(formError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <label>
        住所
        <input
          value={value.address}
          maxLength={200}
          onChange={(e) => onChange({ ...value, address: e.target.value })}
        />
      </label>
      <div className="row">
        <button type="button" className="btn btn-small" disabled={busy || !value.address.trim()} onClick={search}>
          {busy ? '探しています…' : '住所から位置を出す'}
        </button>
        {hasLocation(value) && (
          <button type="button" className="btn btn-small" onClick={() => onChange({ ...value, lat: null, lng: null })}>
            位置を消す
          </button>
        )}
        <span className="sub">
          {hasLocation(value) ? `位置：${value.lat.toFixed(5)}, ${value.lng.toFixed(5)}` : '位置は未登録です'}
        </span>
      </div>
      {error && <p className="error">{error}</p>}
      {candidates && candidates.length > 0 && (
        <div className="stack" style={{ gap: 4 }}>
          <span className="sub">候補を選んでください</span>
          {candidates.map((c) => (
            <button
              key={`${c.lat},${c.lng}`}
              type="button"
              className="btn btn-small"
              style={{ textAlign: 'left' }}
              onClick={() => {
                onChange({ address: c.formattedAddress, lat: c.lat, lng: c.lng });
                setCandidates(null);
              }}
            >
              {c.formattedAddress}
            </button>
          ))}
        </div>
      )}
      <span className="sub">地図をクリックすると、その位置にピンを置けます</span>
      <RouteMap
        height={220}
        points={hasLocation(value) ? [{ lat: value.lat, lng: value.lng, label: '●', color: '#e8735f' }] : []}
        onPick={(p) => onChange({ ...value, lat: p.lat, lng: p.lng })}
      />
    </div>
  );
}
