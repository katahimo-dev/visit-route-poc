import {
  type Client,
  type ClientPrivate,
  clientPrivateSchema,
  clientSchema,
  type Place,
  type Staff,
} from '@vrp/shared';
import { doc, writeBatch } from 'firebase/firestore';
import { useMemo, useState } from 'react';
import { useToast } from '../../components/Toast';
import { CLIENT_COLORS, colorOf, initialOf } from '../../lib/colors';
import { db } from '../../lib/firebase';
import { useOrgCollection, type WithId } from '../../lib/useCollection';
import { formError, hasLocation, PlaceEditor, useAdmin } from './common';

/** お客様／利用者さんのマスタ */

type Form = {
  id: string | null;
  displayName: string;
  place: Place;
  requiredGender: 'female' | 'male' | null;
  ngStaffIds: string[];
  note: string;
  color: number;
  active: boolean;
};

const blank = (nextColor: number): Form => ({
  id: null,
  displayName: '',
  place: { address: '', lat: null, lng: null },
  requiredGender: null,
  ngStaffIds: [],
  note: '',
  color: nextColor % CLIENT_COLORS.length,
  active: true,
});

export default function ClientsPage() {
  const { orgId, terms } = useAdmin();
  const toast = useToast();
  const clientsQ = useOrgCollection<Client>(orgId, 'clients');
  const staffQ = useOrgCollection<Staff>(orgId, 'staff');
  // NG スタッフはスタッフに見せないので、管理者だけが読める clientPrivate に分けて持つ
  const privateQ = useOrgCollection<ClientPrivate>(orgId, 'clientPrivate');
  const ngOf = (id: string) => privateQ.rows?.find((p) => p.id === id)?.ngStaffIds ?? [];
  const [form, setForm] = useState<Form | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clients = useMemo(
    () => [...(clientsQ.rows ?? [])].sort((a, b) => a.displayName.localeCompare(b.displayName, 'ja')),
    [clientsQ.rows],
  );
  const staff = useMemo(
    () => [...(staffQ.rows ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'ja')),
    [staffQ.rows],
  );
  const staffName = (id: string) => staff.find((s) => s.id === id)?.name ?? '（不明）';

  const edit = (c: WithId<Client>) => {
    setError(null);
    setIsNew(false);
    setForm({ ...c, id: c.id, place: { ...c.place }, ngStaffIds: [...ngOf(c.id)] });
  };

  const save = async () => {
    if (!form) return;
    setError(null);
    try {
      const { id, ngStaffIds, ...rest } = form;
      const data = clientSchema.parse(rest);
      const priv = clientPrivateSchema.parse({ ngStaffIds });
      const newId = id ?? crypto.randomUUID();
      const batch = writeBatch(db);
      batch.set(doc(db, 'orgs', orgId, 'clients', newId), data);
      batch.set(doc(db, 'orgs', orgId, 'clientPrivate', newId), priv);
      await batch.commit();
      setForm({ ...form, id: newId });
      setIsNew(false);
      toast('保存しました');
    } catch (e) {
      setError(formError(e));
    }
  };

  return (
    <div className="stack">
      <div className="spread">
        <h2>{terms.client}</h2>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setError(null);
            setIsNew(true);
            setForm(blank(clients.length));
          }}
        >
          {terms.client}を足す
        </button>
      </div>

      <div className="card">
        {clientsQ.rows === null ? (
          <p className="sub">読み込み中…</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>名前</th>
                <th>住所</th>
                <th>位置</th>
                <th>希望・NG</th>
                <th>状態</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.id}>
                  <td>
                    <span className="row">
                      <span className="dot dot-sm" style={{ background: colorOf(c.color) }}>
                        {initialOf(c.displayName)}
                      </span>
                      {c.displayName}
                    </span>
                  </td>
                  <td>{c.place.address}</td>
                  <td>{hasLocation(c.place) ? 'あり' : <span className="chip chip-warn">未登録</span>}</td>
                  <td>
                    {c.requiredGender && (
                      <span className="chip">{c.requiredGender === 'female' ? '女性希望' : '男性希望'}</span>
                    )}{' '}
                    {ngOf(c.id).length > 0 && <span className="chip">NG：{ngOf(c.id).map(staffName).join('、')}</span>}
                  </td>
                  <td>{c.active ? '' : <span className="chip">休止中</span>}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-small"
                      // NG スタッフを読み込む前に保存すると空で上書きするので、読み込むまで押せない
                      disabled={privateQ.rows === null}
                      onClick={() => edit(c)}
                    >
                      直す
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
          <h3>{isNew ? `${terms.client}を足す` : `${terms.client}を直す`}</h3>
          <div className="form-grid">
            <label>
              表示名
              <input
                value={form.displayName}
                maxLength={50}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
              />
            </label>
            <label>
              {terms.staff}の性別の希望
              <select
                value={form.requiredGender ?? ''}
                onChange={(e) =>
                  setForm({
                    ...form,
                    requiredGender: e.target.value === '' ? null : (e.target.value as 'female' | 'male'),
                  })
                }
              >
                <option value="">指定なし</option>
                <option value="female">女性</option>
                <option value="male">男性</option>
              </select>
            </label>
            <label>
              メモ
              <input value={form.note} maxLength={500} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </label>
          </div>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <span className="sub">色</span>
            {CLIENT_COLORS.map((col, i) => (
              <button
                key={col}
                type="button"
                className="dot dot-sm"
                aria-label={`色${i + 1}`}
                aria-pressed={form.color === i}
                onClick={() => setForm({ ...form, color: i })}
                style={{
                  background: col,
                  border: form.color === i ? '3px solid var(--ink)' : '3px solid transparent',
                  cursor: 'pointer',
                }}
              >
                {form.color === i ? '✓' : ''}
              </button>
            ))}
            <label style={{ flexDirection: 'row', alignItems: 'center', gap: 4, width: 'auto', marginLeft: 16 }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={form.active}
                onChange={(e) => setForm({ ...form, active: e.target.checked })}
              />
              使っている（外すと休止）
            </label>
          </div>
          <div className="stack" style={{ gap: 4 }}>
            <span className="sub">NGの{terms.staff}（組み合わせない）</span>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {staff.map((s) => (
                <label key={s.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, width: 'auto' }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={form.ngStaffIds.includes(s.id)}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        ngStaffIds: e.target.checked
                          ? [...form.ngStaffIds, s.id]
                          : form.ngStaffIds.filter((x) => x !== s.id),
                      })
                    }
                  />
                  {s.name}
                </label>
              ))}
              {staff.length === 0 && <span className="sub">{terms.staff}が未登録です</span>}
            </div>
          </div>
          <h3>住所</h3>
          <PlaceEditor value={form.place} onChange={(place) => setForm({ ...form, place })} />
          {error && <p className="error">{error}</p>}
          <div className="row">
            <button type="button" className="btn btn-primary" onClick={save}>
              保存
            </button>
            <button type="button" className="btn" onClick={() => setForm(null)}>
              閉じる
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
