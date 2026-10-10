import { addDays, jstDate } from '@vrp/shared';
import { useState } from 'react';
import { call, saveCsv } from '../../lib/api';
import { DateField, formError, useAdmin } from './common';

/** 実証データの書き出し（運営者だけ） */
export default function ExportPage() {
  const { orgId, org } = useAdmin();
  const today = jstDate(Date.now());
  const [from, setFrom] = useState(() => addDays(today, -30));
  const [to, setTo] = useState(today);
  const [orgInput, setOrgInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string[]>([]);

  const run = async () => {
    setBusy(true);
    setError(null);
    setSaved([]);
    try {
      const r = await call('exportStudyData', { orgId: orgInput.trim() || null, from, to });
      if (r.files.length === 0) setError('書き出すデータがありません');
      for (const f of r.files) saveCsv(f.name, f.csv);
      setSaved(r.files.map((f) => f.name));
    } catch (e) {
      setError(formError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <h2>実証データ</h2>
      <div className="card stack">
        <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <DateField label="はじめ" value={from} onChange={setFrom} />
          <DateField label="おわり" value={to} onChange={setTo} />
          <label style={{ maxWidth: 260 }}>
            事業所ID（空なら自分の事業所）
            <input value={orgInput} onChange={(e) => setOrgInput(e.target.value)} placeholder={orgId} />
          </label>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={run}>
            {busy ? '書き出しています…' : 'CSVを保存'}
          </button>
        </div>
        {error && <p className="error">{error}</p>}
        {saved.length > 0 && (
          <div className="stack" style={{ gap: 2 }}>
            <span className="sub">保存したファイル</span>
            {saved.map((n) => (
              <span key={n}>{n}</span>
            ))}
          </div>
        )}
      </div>
      <div className="card stack">
        <h3>事業所の設定（見るだけ）</h3>
        {org ? (
          <table>
            <tbody>
              <tr>
                <th>名前</th>
                <td>{org.name}</td>
              </tr>
              <tr>
                <th>業種</th>
                <td>{org.industry}</td>
              </tr>
              <tr>
                <th>最適化モード</th>
                <td>{org.optimizeMode}</td>
              </tr>
              <tr>
                <th>AI案をスタッフに見せる</th>
                <td>{org.showAiToStaff ? 'はい' : 'いいえ'}</td>
              </tr>
            </tbody>
          </table>
        ) : (
          <p className="sub">読み込めませんでした。</p>
        )}
      </div>
    </div>
  );
}
