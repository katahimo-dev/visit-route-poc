import { HALF_HOURS, hhmmToMinutes, MAX_SLOTS, minutesToHhmm, type Slot, slotsError } from '@vrp/shared';

/** 選べるいちばん遅い時刻（23:30） */
const LAST = 23 * 60 + 30;

/** 働ける時間帯の入力（30分単位・最大4つ）。管理者のカレンダーとスタッフのアプリで共通 */
export function SlotEditor({ value, onChange }: { value: Slot[]; onChange: (v: Slot[]) => void }) {
  const set = (i: number, patch: Partial<Slot>) => onChange(value.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  // 足す時間帯の初期値：前の時間帯の1時間後から3時間（なければ 9:00〜18:00）
  const add = () => {
    const last = value[value.length - 1];
    const cap = (m: number) => minutesToHhmm(Math.min(m, LAST));
    const start = last ? cap(hhmmToMinutes(last.end) + 60) : '09:00';
    const end = last ? cap(hhmmToMinutes(start) + 180) : '18:00';
    onChange([...value, { start, end }]);
  };
  const error = slotsError(value);
  return (
    <div className="stack" style={{ gap: 8 }}>
      {value.length === 0 && <p className="sub">この日は休み（働ける時間帯なし）</p>}
      {value.map((s, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 時間帯に ID は無く、行の位置がそのまま意味を持つ（入力中は開始が重なることもある）
        <div key={i} className="slot-row">
          <select value={s.start} onChange={(e) => set(i, { start: e.target.value })} aria-label="開始">
            {HALF_HOURS.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
          <span>〜</span>
          <select value={s.end} onChange={(e) => set(i, { end: e.target.value })} aria-label="終了">
            {HALF_HOURS.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
            aria-label="この時間帯を削除"
          >
            削除
          </button>
        </div>
      ))}
      {value.length < MAX_SLOTS && (
        <button type="button" className="btn btn-small" style={{ alignSelf: 'flex-start' }} onClick={add}>
          ＋ 時間帯を追加
        </button>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
