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
import { useMemo, useState } from 'react';
import { useToast } from '../../components/Toast';
import { messageOf } from '../../lib/api';
import { useSession } from '../../lib/session';
import { useOrgCollection, useOrgDoc } from '../../lib/useCollection';
import { WEEKDAY_LABELS } from '../admin/common';
import { SlotEditor } from './SlotEditor';
import { resetAvailability, saveAvailability } from './store';

/** 見せる日数（きょうから4週間） */
const DAYS = 28;

/**
 * はたらく時間：きょうから4週間の、自分の働ける時間帯。日を押すと直せる（当日も可。承認なしですぐ反映。ADR-0008）
 */
export function MyAvailabilityPage() {
  const s = useSession();
  const toast = useToast();
  const today = jstDate(Date.now());
  const last = addDays(today, DAYS - 1);
  const me = useOrgDoc<Staff>(s.orgId, 'staff', s.staffId);
  const { rows } = useOrgCollection<Availability>(
    s.orgId,
    'availability',
    [where('staffId', '==', s.staffId ?? ''), where('date', '>=', today), where('date', '<=', last)],
    `${s.staffId}:${today}`,
  );
  const overrides = useMemo(() => new Map((rows ?? []).map((a) => [a.date, a])), [rows]);
  const dates = useMemo(() => Array.from({ length: DAYS }, (_, i) => addDays(today, i)), [today]);
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<Slot[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!me || rows === null) return <p className="sub">読み込み中…</p>;
  const staffId = s.staffId;
  if (!s.orgId || !staffId) return null;
  const orgId = s.orgId;

  const toggle = (date: string) => {
    setError(null);
    if (open === date) {
      setOpen(null);
      return;
    }
    setOpen(date);
    setDraft(availabilityOf(me, date, overrides.get(date)).slots);
  };
  const run = async (fn: () => Promise<void>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      toast(done);
      setOpen(null);
    } catch (e) {
      setError(e instanceof Error && 'issues' in e ? '時間帯を確認してください' : messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2>働ける時間</h2>
      <p className="sub">
        働ける時間を日ごとに変えられます（30分単位）。変更はすぐ事業所に伝わります。普段の曜日と時間は事業所が設定します。
      </p>
      <div className="card stack" style={{ gap: 0, padding: '4px 16px' }}>
        {dates.map((d) => {
          const o = overrides.get(d);
          const { slots } = availabilityOf(me, d, o);
          const dow = weekday(d);
          return (
            <div key={d} className="my-avail">
              <button type="button" className="my-avail-row" onClick={() => toggle(d)} aria-expanded={open === d}>
                <span className={`my-avail-date dow-${dow}`}>
                  {Number(d.slice(5, 7))}/{Number(d.slice(8))}（{WEEKDAY_LABELS[dow]}）
                  {d === today && <span className="chip chip-primary">今日</span>}
                </span>
                <span className={slots.length === 0 ? 'sub' : ''}>{slotsText(slots)}</span>
                {o && <span className="chip">{o.byStaff ? '変更' : '事業所が変更'}</span>}
              </button>
              {open === d && (
                <div className="stack" style={{ padding: '4px 0 16px' }}>
                  <SlotEditor value={draft} onChange={setDraft} />
                  {error && <p className="error">{error}</p>}
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() =>
                      run(
                        () =>
                          saveAvailability(orgId, { staffId, date: d, slots: draft, byStaff: true, uid: s.user.uid }),
                        draft.length === 0 ? '休みにしました' : '時間を変更しました',
                      )
                    }
                  >
                    この時間で保存
                  </button>
                  <div className="row" style={{ flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={busy}
                      onClick={() =>
                        run(
                          () =>
                            saveAvailability(orgId, { staffId, date: d, slots: [], byStaff: true, uid: s.user.uid }),
                          '休みにしました',
                        )
                      }
                    >
                      この日を休みにする
                    </button>
                    {o && (
                      <button
                        type="button"
                        className="btn btn-small"
                        disabled={busy}
                        onClick={() => run(() => resetAvailability(orgId, staffId, d), '普段の時間に戻しました')}
                      >
                        普段の時間に戻す
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
