import type { Org } from '@vrp/shared';
import { doc, onSnapshot } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { db } from '../../lib/firebase';
import { logout, useSession } from '../../lib/session';
import AvailabilityPage from '../availability/AvailabilityPage';
import AttendancePage from './AttendancePage';
import ClientsPage from './ClientsPage';
import { AdminProvider } from './common';
import ExportPage from './ExportPage';
import PlanPage from './PlanPage';
import StaffPage from './StaffPage';
import SchedulePage from './schedule/SchedulePage';

const ORG_KEY = 'admin.orgId';

/** 管理者のPC画面。左のメニューと各画面（/admin/*） */
export default function AdminApp() {
  const session = useSession();
  const isOperator = session.role === 'operator';
  const [manualOrg, setManualOrg] = useState(() => localStorage.getItem(ORG_KEY) ?? '');
  const [orgInput, setOrgInput] = useState(manualOrg);
  // 運営者は orgId のクレームが無いことがある。その場合は入力した事業所を使う
  const orgId = session.orgId ?? (isOperator && manualOrg.trim() ? manualOrg.trim() : null);
  const [org, setOrg] = useState<Org | null>(null);

  useEffect(() => {
    setOrg(null);
    if (!orgId) return;
    return onSnapshot(
      doc(db, 'orgs', orgId),
      (s) => setOrg((s.data() as Org | undefined) ?? null),
      () => setOrg(null),
    );
  }, [orgId]);

  const needsOrgInput = isOperator && !session.orgId;
  const orgForm = needsOrgInput && (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        const v = orgInput.trim();
        setManualOrg(v);
        localStorage.setItem(ORG_KEY, v);
      }}
    >
      <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        事業所ID
        <input value={orgInput} onChange={(e) => setOrgInput(e.target.value)} style={{ width: 220 }} />
      </label>
      <button type="submit" className="btn btn-small">
        開く
      </button>
    </form>
  );

  const header = (
    <div className="spread">
      <strong>{org?.name ?? (orgId ? '事業所' : '事業所が選ばれていません')}</strong>
      <div className="row">
        {orgForm}
        <button type="button" className="btn btn-small" onClick={() => logout()}>
          ログアウト
        </button>
      </div>
    </div>
  );

  const terms = org?.terms ?? session.terms;

  return (
    <div className="admin-shell">
      <nav className="admin-nav">
        <NavLink to="/admin" end>
          予定
        </NavLink>
        <NavLink to="/admin/plan">AI案</NavLink>
        <NavLink to="/admin/availability">稼働時間</NavLink>
        <NavLink to="/admin/staff">{terms.staff}</NavLink>
        <NavLink to="/admin/clients">{terms.client}</NavLink>
        <NavLink to="/admin/attendance">勤怠</NavLink>
        {isOperator && <NavLink to="/admin/export">実証データ</NavLink>}
      </nav>
      <main className="admin-main">
        {header}
        {!orgId ? (
          <p className="sub">
            {isOperator ? '事業所IDを入力して「開く」を押してください。' : '事業所が見つかりません。'}
          </p>
        ) : (
          <AdminProvider key={orgId} value={{ orgId, org, terms, isOperator }}>
            <Routes>
              <Route index element={<SchedulePage />} />
              <Route path="plan" element={<PlanPage />} />
              <Route path="availability" element={<AvailabilityPage />} />
              <Route path="staff" element={<StaffPage />} />
              <Route path="clients" element={<ClientsPage />} />
              <Route path="attendance" element={<AttendancePage />} />
              <Route path="export" element={isOperator ? <ExportPage /> : <Navigate to="/admin" replace />} />
              <Route path="*" element={<Navigate to="/admin" replace />} />
            </Routes>
          </AdminProvider>
        )}
      </main>
    </div>
  );
}
