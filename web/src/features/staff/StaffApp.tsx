import { useEffect, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { AttendancePage } from './AttendancePage';
import { HomePage } from './HomePage';
import { ShiftTracker } from './ShiftTracker';
import { TodayPage } from './TodayPage';
import { useStaffDay } from './useStaffDay';
import { VisitPage } from './VisitPage';

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    addEventListener('online', on);
    addEventListener('offline', off);
    return () => {
      removeEventListener('online', on);
      removeEventListener('offline', off);
    };
  }, []);
  return online;
}

/** スタッフのスマホ画面（ホーム／よてい／きんむ） */
export default function StaffApp() {
  const day = useStaffDay();
  const online = useOnline();
  return (
    <ShiftTracker onShift={day.onShift} stops={day.stops}>
      <div className="staff-shell stack">
        {!online && <div className="offline">電波がありません。記録はスマホに残り、つながったら送られます</div>}
        <Routes>
          <Route index element={<HomePage day={day} />} />
          <Route path="today" element={<TodayPage day={day} />} />
          <Route path="visit/:visitId" element={<VisitPage day={day} />} />
          <Route path="attendance" element={<AttendancePage date={day.date} />} />
        </Routes>
      </div>
      <nav className="tabbar">
        <NavLink to="/staff" end>
          <span className="icon">🏠</span>ホーム
        </NavLink>
        <NavLink to="/staff/today">
          <span className="icon">🗓</span>よてい
        </NavLink>
        <NavLink to="/staff/attendance">
          <span className="icon">🕘</span>きんむ
        </NavLink>
      </nav>
    </ShiftTracker>
  );
}
