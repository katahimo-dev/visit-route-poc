import {
  type Availability,
  addDays,
  availabilityOf,
  jstDate,
  type Slot,
  type Staff,
  slotsText,
  weekday,
} from '@vrp/shared';
import { where } from 'firebase/firestore';
import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../../components/Toast';
import { useSession } from '../../lib/session';
import { useOrgCollection } from '../../lib/useCollection';
import { formError, useAdmin, WEEKDAY_LABELS } from '../admin/common';
import { SlotEditor } from './SlotEditor';
import { resetAvailability, saveAvailability } from './store';

/**
 * 稼働時間帯のカレンダー（スタッフ×日、ADR-0008）。
 * 基本の曜日と時間が薄い字、日ごとに変えた日は色付き、本人がアプリで変えた日は ● 印。セルを押すと下で直せる
 */

const monthOf = (date: string) => date.slice(0, 7);
const daysOf = (month: string): string[] => {
  const out: string[] = [];
  for (let d = `${month}-01`; d.startsWith(month); d = addDays(d, 1)) out.push(d);
  return out;
};
const shiftMonth = (month: string, n: number) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};
/** セルの短い表示：「9-18」「9:30-12」。休みは「休」 */
const short = (slots: Slot[]) =>
  slots.length === 0
    ? '休'
    : slots.map(
        (s) => `${s.start.replace(/^0/, '').replace(/:00$/, '')}-${s.end.replace(/^0/, '').replace(/:00$/, '')}`,
      );

export default function AvailabilityPage() {
  const { orgId, terms } = useAdmin();
  const session = useSession();
  const toast = useToast();
  const today = jstDate(Date.now());
  const [month, setMonth] = useState(monthOf(today));
  const days = useMemo(() => daysOf(month), [month]);
  const staffQ = useOrgCollection<Staff>(orgId, 'staff');
  const availQ = useOrgCollection<Availability>(
    orgId,
    'availability',
    [where('date', '>=', days[0] ?? ''), where('date', '<=', days[days.length - 1] ?? '')],
    month,
  );
  const staff = useMemo(
    () => (staffQ.rows ?? []).filter((s) => s.active).sort((a, b) => a.name.localeCompare(b.name, 'ja')),
    [staffQ.rows],
  );
  const overrides = useMemo(
    () => new Map((availQ.rows ?? []).map((a) => [`${a.staffId}_${a.date}`, a])),
    [availQ.rows],
  );

  const [picked, setPicked] = useState<{ staffId: string; date: string } | null>(null);
  const [draft, setDraft] = useState<Slot[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pickedStaff = picked ? staff.find((s) => s.id === picked.staffId) : undefined;
  const pickedOverride = picked ? overrides.get(`${picked.staffId}_${picked.date}`) : undefined;

  // biome-ignore lint/correctness/useExhaustiveDependencies: 選んだセルが変わったときだけ下書きを作り直す
  useEffect(() => {
    setError(null);
    if (picked && pickedStaff) setDraft(availabilityOf(pickedStaff, picked.date, pickedOverride).slots);
  }, [picked?.staffId, picked?.date]);

  const run = async (fn: () => Promise<void>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      toast(done);
    } catch (e) {
      setError(formError(e));
    } finally {
      setBusy(false);
    }
  };
  const save = (slots: Slot[]) =>
    picked &&
    run(
      () => saveAvailability(orgId, { ...picked, slots, byStaff: false, uid: session.user.uid }),
      slots.length === 0 ? '休みにしました' : '時間帯を保存しました',
    );
  const reset = () =>
    picked && run(() => resetAvailability(orgId, picked.staffId, picked.date), '基本の時間に戻しました');

  return (
    <div className="stack">
      <h2>稼働時間</h2>
      <div className="card stack">
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-small" onClick={() => setMonth(shiftMonth(month, -1))}>
            ◀ 前の月
          </button>
          <strong style={{ fontSize: '1.2rem' }}>{month.replace('-', '年')}月</strong>
          <button type="button" className="btn btn-small" onClick={() => setMonth(shiftMonth(month, 1))}>
            次の月 ▶
          </button>
          {month !== monthOf(today) && (
            <button type="button" className="btn btn-small" onClick={() => setMonth(monthOf(today))}>
              今月
            </button>
          )}
        </div>
        <p className="sub">
          薄い字は基本の曜日と時間（{terms.staff}の設定）。色の付いた日は、その日だけ変えた時間です。
          <span className="avail-mark">●</span>は本人がアプリで変えた日。セルを押すと下で変更できます。
        </p>
        <div className="table-scroll">
          <table className="avail-table">
            <thead>
              <tr>
                <th className="avail-name">{terms.staff}</th>
                {days.map((d) => (
                  <th key={d} className={`avail-day dow-${weekday(d)} ${d === today ? 'is-today' : ''}`}>
                    {Number(d.slice(8))}
                    <br />
                    {WEEKDAY_LABELS[weekday(d)]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {staff.map((s) => (
                <tr key={s.id}>
                  <th className="avail-name">{s.name}</th>
                  {days.map((d) => {
                    const o = overrides.get(`${s.id}_${d}`);
                    const { slots } = availabilityOf(s, d, o);
                    const isPicked = picked?.staffId === s.id && picked.date === d;
                    const text = short(slots);
                    return (
                      <td key={d} className="avail-cell">
                        <button
                          type="button"
                          className={[
                            'avail-btn',
                            o ? 'is-override' : '',
                            slots.length === 0 ? 'is-off' : '',
                            isPicked ? 'is-picked' : '',
                            d < today ? 'is-past' : '',
                          ].join(' ')}
                          title={`${s.name} ${d}：${slotsText(slots)}${o?.byStaff ? '（本人が変更）' : ''}`}
                          onClick={() => setPicked({ staffId: s.id, date: d })}
                        >
                          {o?.byStaff && <span className="avail-mark">●</span>}
                          {Array.isArray(text) ? text.map((t) => <span key={t}>{t}</span>) : text}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {staffQ.rows && staff.length === 0 && <p className="sub">在籍中の{terms.staff}がいません。</p>}
      </div>

      {picked && pickedStaff && (
        <div className="card stack" style={{ maxWidth: 560 }}>
          <div className="spread">
            <h3>
              {pickedStaff.name}・{picked.date.slice(5).replace('-', '/')}（{WEEKDAY_LABELS[weekday(picked.date)]}）
            </h3>
            <button type="button" className="btn btn-small" onClick={() => setPicked(null)}>
              閉じる
            </button>
          </div>
          <p className="sub">
            基本：{slotsText(availabilityOf(pickedStaff, picked.date, null).slots)}
            {pickedOverride &&
              `／この日は${pickedOverride.byStaff ? '本人' : '管理者'}が変更（${new Date(pickedOverride.updatedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}）`}
          </p>
          <SlotEditor value={draft} onChange={setDraft} />
          {error && <p className="error">{error}</p>}
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => save(draft)}>
              この時間で保存
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => save([])}>
              休みにする
            </button>
            {pickedOverride && (
              <button type="button" className="btn" disabled={busy} onClick={reset}>
                基本の時間に戻す
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
