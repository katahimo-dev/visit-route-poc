import { randomBytes } from 'node:crypto';
import { type AttendanceDay, exportStudyDataRequest, jstHhmm, type VisitEvent } from '@vrp/shared';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { callerOf, col, db, parse, REGION } from '../../lib/context';
import { effective } from '../attendance/domain/buildDay';
import { toCsv } from './domain/csv';
import { pseudonym } from './domain/pseudonym';

/** 事業所ごとの仮名化の鍵（初回に作る。運営者だけが使う） */
async function pseudonymKey(orgId: string): Promise<string> {
  const ref = db.doc(`orgs/${orgId}/analysisIds/key`);
  return db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const k = s.data()?.key as string | undefined;
    if (k) return k;
    const key = randomBytes(32).toString('hex');
    tx.set(ref, { key, createdAt: Date.now() });
    return key;
  });
}

type PlanRunDoc = {
  date: string;
  mode: string;
  modelVersion: string;
  solverVersion: string;
  computeMillis: number;
  manualMinutesSpent: number | null;
  metrics: {
    manual: { travelSeconds: number; meters: number; waitSeconds: number; violations: number; fareYen: number };
    ai: { travelSeconds: number; meters: number; waitSeconds: number; violations: number; fareYen: number };
  };
  result: { unassigned: unknown[]; partial: boolean };
};

/**
 * 実証データCSV（運営者のみ）。氏名・住所・電話は含めず、仮名IDだけを出す。
 * 1) 計画値比較（日ごと）2) 予測と実測（区間）3) TTS・勤怠（訪問ごと）
 */
export const exportStudyData = onCall({ region: REGION, timeoutSeconds: 120 }, async (req) => {
  const c = callerOf(req);
  if (c.role !== 'operator') throw new HttpsError('permission-denied', 'この操作は運営者だけができます');
  const input = parse(exportStudyDataRequest, req.data);
  const orgIds = input.orgId ? [input.orgId] : (await db.collection('orgs').get()).docs.map((d) => d.id);
  const plans: (string | number | null)[][] = [
    [
      '事業所',
      '日付',
      'モード',
      'モデル版',
      'ソルバー版',
      '計算ms',
      'ルート作成(分)',
      '手作業_移動秒',
      'AI_移動秒',
      '削減率',
      '手作業_距離m',
      'AI_距離m',
      '手作業_待ち秒',
      'AI_待ち秒',
      '手作業_交通費',
      'AI_交通費',
      '手作業_違反',
      'AI_違反',
      'AI_未割当',
      '時間切れ',
    ],
  ];
  const legs: (string | number | null)[][] = [
    ['事業所', '日付', 'スタッフ', '移動手段', '区分', 'モデル版', '基準秒', '予測秒', '実測秒', '誤差秒', '補完あり'],
  ];
  const visits: (string | number | null)[][] = [
    [
      '事業所',
      '日付',
      'スタッフ',
      '訪問',
      'T1顧客情報',
      'T2経路',
      'T3到着',
      'T4開始',
      '終了',
      '退出',
      '到着を補完',
      '予定開始',
      '予定終了',
      '変更あり',
      '勤怠状態',
    ],
  ];
  const range = <T>(q: FirebaseFirestore.Query) =>
    q.where('date', '>=', input.from).where('date', '<=', input.to).get() as Promise<
      FirebaseFirestore.QuerySnapshot<T>
    >;
  const fmt = (ms: number | null | undefined) => (ms ? jstHhmm(ms) : '');
  for (const orgId of orgIds) {
    const key = await pseudonymKey(orgId);
    const org = pseudonym(key, 'client', `org:${orgId}`).replace(/^c_/, 'o_');
    const [runs, actuals, days, events] = await Promise.all([
      range<PlanRunDoc>(col(orgId, 'planRuns')),
      range<Record<string, unknown>>(col(orgId, 'legActuals')),
      range<AttendanceDay>(col(orgId, 'attendanceDays')),
      range<VisitEvent>(col(orgId, 'events')),
    ]);
    // 同じ日に複数回作ったときは最後の実行を使う
    const lastRun = new Map<string, PlanRunDoc & { createdAt?: number }>();
    for (const d of runs.docs) {
      const r = d.data() as PlanRunDoc & { createdAt?: number };
      const prev = lastRun.get(r.date);
      if (!prev || (r.createdAt ?? 0) > (prev.createdAt ?? 0)) lastRun.set(r.date, r);
    }
    for (const r of [...lastRun.values()].sort((a, b) => a.date.localeCompare(b.date))) {
      const m = r.metrics;
      const rate = m.manual.travelSeconds > 0 ? 1 - m.ai.travelSeconds / m.manual.travelSeconds : null;
      plans.push([
        org,
        r.date,
        r.mode,
        r.modelVersion,
        r.solverVersion,
        r.computeMillis,
        r.manualMinutesSpent,
        m.manual.travelSeconds,
        m.ai.travelSeconds,
        rate === null ? null : Math.round(rate * 1000) / 1000,
        m.manual.meters,
        m.ai.meters,
        m.manual.waitSeconds,
        m.ai.waitSeconds,
        m.manual.fareYen,
        m.ai.fareYen,
        m.manual.violations,
        m.ai.violations,
        r.result.unassigned.length,
        r.result.partial ? 1 : 0,
      ]);
    }
    for (const d of actuals.docs) {
      const a = d.data();
      const actual = a.actualSeconds as number;
      const pred = a.predictedSeconds as number;
      legs.push([
        org,
        a.date as string,
        pseudonym(key, 'staff', a.staffId as string),
        a.mode as string,
        a.key as string,
        a.modelVersion as string,
        a.baseSeconds as number,
        pred,
        actual,
        pred - actual,
        a.filled ? 1 : 0,
      ]);
    }
    // T1/T2：その訪問について最初に開いた時刻
    const firstOpen = new Map<string, number>();
    for (const d of events.docs) {
      const e = d.data();
      if (!e.visitId || (e.type !== 'client_open' && e.type !== 'route_open')) continue;
      const k = `${e.type}:${e.visitId}`;
      firstOpen.set(k, Math.min(firstOpen.get(k) ?? Number.POSITIVE_INFINITY, e.clientTime));
    }
    for (const d of days.docs) {
      const day = d.data();
      for (const v of day.visits) {
        visits.push([
          org,
          day.date,
          pseudonym(key, 'staff', day.staffId),
          pseudonym(key, 'visit', v.visitId),
          fmt(firstOpen.get(`client_open:${v.visitId}`)),
          fmt(firstOpen.get(`route_open:${v.visitId}`)),
          fmt(effective(v, 'arrive')),
          fmt(effective(v, 'start')),
          fmt(effective(v, 'end')),
          fmt(effective(v, 'depart')),
          v.arriveFilled ? 1 : 0,
          v.planned.start,
          v.planned.end,
          v.changed ? 1 : 0,
          day.status,
        ]);
      }
    }
  }
  const suffix = `${input.from}_${input.to}`;
  return {
    files: [
      { name: `計画値比較_${suffix}.csv`, csv: toCsv(plans) },
      { name: `移動時間_予測と実測_${suffix}.csv`, csv: toCsv(legs) },
      { name: `訪問_TTS_勤怠_${suffix}.csv`, csv: toCsv(visits) },
    ],
  };
});
