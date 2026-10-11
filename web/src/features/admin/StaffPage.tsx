import { GENDERS, type Gender, type Place, type Staff, staffSchema, TRAVEL_MODES, type TravelMode } from '@vrp/shared';
import { doc, setDoc } from 'firebase/firestore';
import { useMemo, useState } from 'react';
import { useToast } from '../../components/Toast';
import { call } from '../../lib/api';
import { db } from '../../lib/firebase';
import { useOrgCollection, type WithId } from '../../lib/useCollection';
import {
  formError,
  GENDER_LABELS,
  hasLocation,
  PlaceEditor,
  TRAVEL_MODE_LABELS,
  useAdmin,
  WEEKDAY_LABELS,
} from './common';

/** スタッフのマスタと招待 */

type Form = {
  id: string | null;
  name: string;
  email: string;
  gender: Gender;
  home: Place;
  travelMode: TravelMode;
  workDays: number[];
  shiftStart: string;
  shiftEnd: string;
  active: boolean;
  /** 既存のuid（rules：更新では同じ値を送る。新規は送らない） */
  uid: string | null | undefined;
};

const blank = (): Form => ({
  id: null,
  name: '',
  email: '',
  gender: 'unspecified',
  home: { address: '', lat: null, lng: null },
  travelMode: 'DRIVE',
  workDays: [1, 2, 3, 4, 5],
  shiftStart: '09:00',
  shiftEnd: '18:00',
  active: true,
  uid: undefined,
});

export default function StaffPage() {
  const { orgId, terms, isOperator } = useAdmin();
  const toast = useToast();
  const staffQ = useOrgCollection<Staff>(orgId, 'staff');
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adminEmail, setAdminEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const staff = useMemo(
    () => [...(staffQ.rows ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'ja')),
    [staffQ.rows],
  );
  const inviteOrg = isOperator ? orgId : null;

  const edit = (s: WithId<Staff>): void => {
    setError(null);
    setForm({ ...s, id: s.id, home: { ...s.home }, workDays: [...s.workDays], uid: s.uid });
  };

  const save = async () => {
    if (!form) return;
    setError(null);
    try {
      const { id, uid, ...rest } = form;
      const data = staffSchema.parse({ ...rest, uid: uid ?? null });
      // rules：新規は uid を書けない。更新は既存の値をそのまま送る
      const { uid: _u, ...withoutUid } = data;
      const payload = id !== null && uid !== undefined ? { ...withoutUid, uid } : withoutUid;
      const newId = id ?? crypto.randomUUID();
      await setDoc(doc(db, 'orgs', orgId, 'staff', newId), payload);
      setForm(id === null ? { ...form, id: newId } : form);
      toast('保存しました');
    } catch (e) {
      setError(formError(e));
    }
  };

  const invite = async (email: string, staffId: string) => {
    setBusy(true);
    setError(null);
    try {
      await call('inviteMember', { email, role: 'staff', staffId, orgId: inviteOrg });
      toast(`招待を準備しました。${terms.staff}にアプリを開いて、ログインコードを請求するよう伝えてください`);
    } catch (e) {
      setError(formError(e));
    } finally {
      setBusy(false);
    }
  };

  const inviteAdmin = async () => {
    setBusy(true);
    setError(null);
    try {
      await call('inviteMember', { email: adminEmail, role: 'admin', staffId: null, orgId: inviteOrg });
      toast('管理者の招待を準備しました。本人にアプリを開いて、ログインコードを請求するよう伝えてください');
      setAdminEmail('');
    } catch (e) {
      setError(formError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="spread">
        <h2>{terms.staff}</h2>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setError(null);
            setForm(blank());
          }}
        >
          {terms.staff}を追加
        </button>
      </div>
      {error && !form && <p className="error">{error}</p>}

      <div className="card">
        {staffQ.rows === null ? (
          <p className="sub">読み込み中…</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>名前</th>
                <th>メール</th>
                <th>勤務</th>
                <th>自宅の位置</th>
                <th>状態</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {staff.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>{s.email}</td>
                  <td>
                    {s.workDays.map((d) => WEEKDAY_LABELS[d]).join('')} {s.shiftStart}〜{s.shiftEnd}
                  </td>
                  <td>{hasLocation(s.home) ? 'あり' : <span className="chip chip-warn">未登録</span>}</td>
                  <td>
                    {!s.active && <span className="chip">休止中</span>}{' '}
                    {s.uid ? (
                      <span className="chip chip-ok">ログイン連携済み</span>
                    ) : (
                      <span className="chip">未連携</span>
                    )}
                  </td>
                  <td>
                    <button type="button" className="btn btn-small" onClick={() => edit(s)}>
                      編集
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {form && (
        <div className="card stack">
          <h3>{form.id && staff.some((s) => s.id === form.id) ? `${terms.staff}を編集` : `${terms.staff}を追加`}</h3>
          <div className="form-grid">
            <label>
              名前
              <input value={form.name} maxLength={50} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label>
              メールアドレス
              <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </label>
            <label>
              性別
              <select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value as Gender })}>
                {GENDERS.map((g) => (
                  <option key={g} value={g}>
                    {GENDER_LABELS[g]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              移動手段
              <select
                value={form.travelMode}
                onChange={(e) => setForm({ ...form, travelMode: e.target.value as TravelMode })}
              >
                {TRAVEL_MODES.map((t) => (
                  <option key={t} value={t}>
                    {TRAVEL_MODE_LABELS[t]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              勤務開始
              <input
                type="time"
                value={form.shiftStart}
                onChange={(e) => setForm({ ...form, shiftStart: e.target.value })}
              />
            </label>
            <label>
              勤務終了
              <input
                type="time"
                value={form.shiftEnd}
                onChange={(e) => setForm({ ...form, shiftEnd: e.target.value })}
              />
            </label>
          </div>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <span className="sub">勤務する曜日</span>
            {WEEKDAY_LABELS.map((w, d) => (
              <label key={w} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, width: 'auto' }}>
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={form.workDays.includes(d)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      workDays: e.target.checked ? [...form.workDays, d].sort() : form.workDays.filter((x) => x !== d),
                    })
                  }
                />
                {w}
              </label>
            ))}
            <label style={{ flexDirection: 'row', alignItems: 'center', gap: 4, width: 'auto', marginLeft: 16 }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={form.active}
                onChange={(e) => setForm({ ...form, active: e.target.checked })}
              />
              利用中（外すと休止）
            </label>
          </div>
          <h3>自宅</h3>
          <PlaceEditor value={form.home} onChange={(home) => setForm({ ...form, home })} />
          {error && <p className="error">{error}</p>}
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-primary" onClick={save}>
              保存
            </button>
            <button type="button" className="btn" onClick={() => setForm(null)}>
              閉じる
            </button>
            {form.id && staff.some((s) => s.id === form.id) && (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => invite(form.email, form.id as string)}
              >
                招待メールを送る準備
              </button>
            )}
          </div>
          <p className="sub">
            招待のあと、{terms.staff}
            本人にアプリを開いてもらい、メールに届くログインコードでログインしてもらってください（保存してから招待します）。
          </p>
        </div>
      )}

      <div className="card stack">
        <h3>管理者の招待</h3>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <label style={{ maxWidth: 320 }}>
            メールアドレス
            <input type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} />
          </label>
          <button type="button" className="btn" disabled={busy || !adminEmail} onClick={inviteAdmin}>
            招待の準備
          </button>
        </div>
      </div>
    </div>
  );
}
