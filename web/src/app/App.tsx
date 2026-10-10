import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../components/Toast';
import { LoginPage } from '../features/auth/LoginPage';
import { logout, SessionProvider, useSessionState } from '../lib/session';

const StaffApp = lazy(() => import('../features/staff/StaffApp'));
const AdminApp = lazy(() => import('../features/admin/AdminApp'));

function Gate() {
  const { loading, session } = useSessionState();
  if (loading)
    return (
      <p className="sub" style={{ padding: 24 }}>
        読み込み中…
      </p>
    );
  if (!session) return <LoginPage />;
  if (!session.role) {
    return (
      <div className="staff-shell stack">
        <div className="card stack">
          <h2>まだ使えません</h2>
          <p>このメールアドレスは事業所に登録されていません。事業所の管理者に招待を頼んでください。</p>
          <button type="button" className="btn" onClick={() => logout()}>
            ログアウト
          </button>
        </div>
      </div>
    );
  }
  return (
    <Suspense
      fallback={
        <p className="sub" style={{ padding: 24 }}>
          読み込み中…
        </p>
      }
    >
      <Routes>
        <Route path="/staff/*" element={session.role === 'staff' ? <StaffApp /> : <Navigate to="/admin" replace />} />
        <Route path="/admin/*" element={session.role !== 'staff' ? <AdminApp /> : <Navigate to="/staff" replace />} />
        <Route path="*" element={<Navigate to={session.role === 'staff' ? '/staff' : '/admin'} replace />} />
      </Routes>
    </Suspense>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <ToastProvider>
          <Gate />
        </ToastProvider>
      </SessionProvider>
    </BrowserRouter>
  );
}
