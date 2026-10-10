import {
  type AttendanceDay,
  approveAttendanceRequest,
  confirmAttendanceRequest,
  correctAttendanceRequest,
  exportAttendanceCsvRequest,
  jstHhmm,
  type Staff,
  type VisitEvent,
} from '@vrp/shared';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { callerOf, col, db, parse, REGION, requireManager } from '../../lib/context';
import { manualPlanOf, routesOf, visitsOfDate } from '../../lib/schedule';
import { toCsv } from '../export/domain/csv';
import { buildAttendanceDay, computeTotals, effective, sameDay } from './domain/buildDay';

const dayId = (staffId: string, date: string) => `${staffId}_${date}`;

async function recompute(orgId: string, staffId: string, date: string): Promise<void> {
  const [visits, manual, evSnap] = await Promise.all([
    visitsOfDate(orgId, date),
    manualPlanOf(orgId, date),
    col(orgId, 'events').where('staffId', '==', staffId).where('date', '==', date).get(),
  ]);
  const order = routesOf(visits, manual)[staffId] ?? [];
  const byId = new Map(visits.map((v) => [v.id, v]));
  const events = evSnap.docs.map((d) => d.data() as VisitEvent);
  // 予定に無い訪問の記録（当日の差し替えなど）も候補に入れる
  for (const e of events) {
    if (e.visitId && !order.includes(e.visitId) && byId.has(e.visitId)) order.push(e.visitId);
  }
  const planned = order
    .map((id) => byId.get(id))
    .filter((v) => v !== undefined)
    .map((v) => ({ visitId: v.id, earliestStart: v.earliestStart, durationMinutes: v.durationMinutes }));
  const ref = col(orgId, 'attendanceDays').doc(dayId(staffId, date));
  await db.runTransaction(async (tx) => {
    const prev = await tx.get(ref);
    const prevDay = prev.exists ? (prev.data() as AttendanceDay) : null;
    const day = buildAttendanceDay(staffId, date, planned, events, prevDay);
    // 結果が変わらない記録（勤怠に関係しない記録など）では書かない。書くと onAttendanceDayWritten の連鎖が起きる
    if (prevDay && sameDay(prevDay, day)) return;
    tx.set(ref, day);
  });
}

/** 記録が届いたら、その日の勤怠候補を作り直す */
export const onEventCreated = onDocumentCreated(
  { document: 'orgs/{orgId}/events/{eventId}', region: REGION },
  async (e) => {
    const data = e.data?.data() as VisitEvent | undefined;
    if (!data) return;
    await recompute(e.params.orgId, data.staffId, data.date);
  },
);

async function updateDay(
  orgId: string,
  id: string,
  version: number,
  fn: (day: AttendanceDay) => AttendanceDay,
): Promise<number> {
  const ref = col(orgId, 'attendanceDays').doc(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', '勤怠の記録がありません');
    const day = snap.data() as AttendanceDay;
    if (day.version !== version) {
      throw new HttpsError('failed-precondition', 'ほかの人が先に更新しました。読み直してからやり直してください');
    }
    const next = fn(day);
    next.version = day.version + 1;
    tx.set(ref, next);
    return next.version;
  });
}

/** 本人（または管理者）が到着・開始・終了・退出の時刻を訂正する */
export const correctAttendance = onCall({ region: REGION }, async (req) => {
  const c = callerOf(req);
  const input = parse(correctAttendanceRequest, req.data);
  if (!c.orgId) throw new HttpsError('permission-denied', 'この操作はできません');
  const staffId = c.role === 'staff' ? c.staffId : input.staffId;
  if (!staffId) throw new HttpsError('invalid-argument', 'スタッフを指定してください');
  const version = await updateDay(c.orgId, dayId(staffId, input.date), input.version, (day) => {
    if (day.status === 'approved' && c.role === 'staff') {
      throw new HttpsError('failed-precondition', '承認済みのため訂正できません。事業所に連絡してください');
    }
    const visits = day.visits.map((v) =>
      v.visitId === input.visitId
        ? { ...v, corrections: { ...v.corrections, [input.field]: input.value }, correctionNote: input.note }
        : v,
    );
    if (!visits.some((v) => v.visitId === input.visitId)) throw new HttpsError('not-found', '訪問がありません');
    return {
      ...day,
      visits,
      totals: computeTotals(visits),
      status: day.status === 'approved' ? 'approved' : 'candidate',
    };
  });
  return { version };
});

/** 本人が「この内容で合っている」と確認する */
export const confirmAttendance = onCall({ region: REGION }, async (req) => {
  const c = callerOf(req);
  const input = parse(confirmAttendanceRequest, req.data);
  if (c.role !== 'staff' || !c.orgId || !c.staffId) throw new HttpsError('permission-denied', 'この操作はできません');
  const version = await updateDay(c.orgId, dayId(c.staffId, input.date), input.version, (day) => {
    if (day.status === 'approved') throw new HttpsError('failed-precondition', '承認済みです');
    return { ...day, status: 'confirmed_by_staff' };
  });
  return { version };
});

/** 管理者が承認する（自動確定はしない） */
export const approveAttendance = onCall({ region: REGION }, async (req) => {
  const c = callerOf(req);
  const input = parse(approveAttendanceRequest, req.data);
  const orgId = requireManager(c, input.orgId);
  const version = await updateDay(orgId, dayId(input.staffId, input.date), input.version, (day) => ({
    ...day,
    status: 'approved',
    approvedBy: c.uid,
  }));
  return { version };
});

/** 勤怠CSV（月）。予定と実績を並べる */
export const exportAttendanceCsv = onCall({ region: REGION }, async (req) => {
  const c = callerOf(req);
  const { month, orgId: requestedOrgId } = parse(exportAttendanceCsvRequest, req.data);
  const orgId = requireManager(c, requestedOrgId);
  const [days, staffSnap] = await Promise.all([
    col(orgId, 'attendanceDays').where('date', '>=', `${month}-01`).where('date', '<=', `${month}-31`).get(),
    col(orgId, 'staff').get(),
  ]);
  const names = new Map(staffSnap.docs.map((d) => [d.id, (d.data() as Staff).name]));
  const fmt = (ms: number | null) => (ms === null ? '' : jstHhmm(ms));
  const rows: (string | number)[][] = [
    [
      '日付',
      'スタッフ',
      '訪問ID',
      '予定開始',
      '予定終了',
      '到着',
      '開始',
      '終了',
      '退出',
      '到着を補完',
      '変更あり',
      '訂正理由',
      '状態',
    ],
  ];
  const totals: (string | number)[][] = [['日付', 'スタッフ', '実働(分)', '移動(分)', '休憩(分)', '拘束(分)', '状態']];
  const sorted = days.docs
    .map((d) => d.data() as AttendanceDay)
    .sort((a, b) => (a.date + a.staffId).localeCompare(b.date + b.staffId));
  for (const day of sorted) {
    const name = names.get(day.staffId) ?? day.staffId;
    for (const v of day.visits) {
      rows.push([
        day.date,
        name,
        v.visitId,
        v.planned.start,
        v.planned.end,
        fmt(effective(v, 'arrive')),
        fmt(effective(v, 'start')),
        fmt(effective(v, 'end')),
        fmt(effective(v, 'depart')),
        v.arriveFilled ? '1' : '',
        v.changed ? '1' : '',
        v.correctionNote,
        day.status,
      ]);
    }
    const t = day.totals;
    totals.push([day.date, name, t.workMinutes, t.travelMinutes, t.breakMinutes, t.boundMinutes, day.status]);
  }
  return {
    files: [
      { name: `勤怠_訪問別_${month}.csv`, csv: toCsv(rows) },
      { name: `勤怠_日別集計_${month}.csv`, csv: toCsv(totals) },
    ],
  };
});
