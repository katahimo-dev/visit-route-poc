import { type Client, type Visit, visitSchema } from '@vrp/shared';
import { doc, setDoc } from 'firebase/firestore';
import { useState } from 'react';
import { useToast } from '../../../components/Toast';
import { db } from '../../../lib/firebase';
import type { WithId } from '../../../lib/useCollection';
import { formError, useAdmin } from '../common';

/** 訪問を足す・直す */

type Form = {
  clientId: string;
  windowKind: 'fixed' | 'window';
  earliestStart: string;
  latestStart: string;
  durationMinutes: string;
  note: string;
};

const formOf = (v: WithId<Visit> | null, clients: WithId<Client>[]): Form =>
  v
    ? {
        clientId: v.clientId,
        windowKind: v.windowKind,
        earliestStart: v.earliestStart,
        latestStart: v.latestStart,
        durationMinutes: String(v.durationMinutes),
        note: v.note,
      }
    : {
        clientId: clients.find((c) => c.active)?.id ?? '',
        windowKind: 'fixed',
        earliestStart: '09:00',
        latestStart: '09:00',
        durationMinutes: '60',
        note: '',
      };

export function VisitForm({
  date,
  visit,
  clients,
  onClose,
}: {
  date: string;
  /** 直すときの訪問。null なら足す */
  visit: WithId<Visit> | null;
  clients: WithId<Client>[];
  onClose: () => void;
}) {
  const { orgId, terms } = useAdmin();
  const toast = useToast();
  const [form, setForm] = useState(() => formOf(visit, clients));
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setError(null);
    try {
      const data = visitSchema.parse({
        date,
        clientId: form.clientId,
        windowKind: form.windowKind,
        earliestStart: form.earliestStart,
        latestStart: form.windowKind === 'fixed' ? form.earliestStart : form.latestStart,
        durationMinutes: Number(form.durationMinutes),
        staffId: visit?.staffId ?? null,
        cancelled: false,
        note: form.note,
      });
      if (data.latestStart < data.earliestStart) {
        setError('「いちばん遅い開始」は「いちばん早い開始」より後にしてください');
        return;
      }
      await setDoc(doc(db, 'orgs', orgId, 'visits', visit?.id ?? crypto.randomUUID()), data);
      toast('訪問を保存しました');
      onClose();
    } catch (e) {
      setError(formError(e));
    }
  };

  return (
    <div className="card stack">
      <h3>{visit ? '訪問を直す' : '訪問を足す'}</h3>
      <div className="form-grid">
        <label>
          {terms.client}
          <select value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })}>
            <option value="">選んでください</option>
            {clients
              .filter((c) => c.active || c.id === form.clientId)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                </option>
              ))}
          </select>
        </label>
        <label>
          時間の約束
          <select
            value={form.windowKind}
            onChange={(e) => setForm({ ...form, windowKind: e.target.value as 'fixed' | 'window' })}
          >
            <option value="fixed">開始時刻が決まっている</option>
            <option value="window">開始に幅がある</option>
          </select>
        </label>
        <label>
          {form.windowKind === 'fixed' ? '開始時刻' : 'いちばん早い開始'}
          <input
            type="time"
            value={form.earliestStart}
            onChange={(e) => setForm({ ...form, earliestStart: e.target.value })}
          />
        </label>
        {form.windowKind === 'window' && (
          <label>
            いちばん遅い開始
            <input
              type="time"
              value={form.latestStart}
              onChange={(e) => setForm({ ...form, latestStart: e.target.value })}
            />
          </label>
        )}
        <label>
          所要時間（分）
          <input
            type="number"
            min={5}
            max={720}
            value={form.durationMinutes}
            onChange={(e) => setForm({ ...form, durationMinutes: e.target.value })}
          />
        </label>
        <label>
          メモ
          <input value={form.note} maxLength={200} onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </label>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button type="button" className="btn btn-primary" onClick={save}>
          保存
        </button>
        <button type="button" className="btn" onClick={onClose}>
          やめる
        </button>
      </div>
    </div>
  );
}
