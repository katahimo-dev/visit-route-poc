import {
  type AttendanceDay,
  type Client,
  hhmmToMinutes,
  jstHhmm,
  type LatLng,
  type TravelMode,
  weekday,
} from '@vrp/shared';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { callerOf, col, db, REGION } from '../../lib/context';
import { effective } from '../attendance/domain/buildDay';
import {
  applyModel,
  dayTypeOf,
  factorKey,
  IDENTITY_MODEL,
  type TravelModel,
  timeBandOf,
  trainFactors,
} from './domain/predict';
import { baseMatrix, MAPS_SERVER_KEY } from './infrastructure/maps';

export { MAPS_SERVER_KEY };

/** 事業所の最新の補正モデル（無ければ倍率1.0） */
export async function currentModel(orgId: string): Promise<TravelModel> {
  const snap = await col(orgId, 'travelModels').orderBy('createdAt', 'desc').limit(1).get();
  const d = snap.docs[0]?.data() as (TravelModel & { createdAt: number }) | undefined;
  return d ? { version: d.version, factors: d.factors } : IDENTITY_MODEL;
}

export type PredictedMatrix = {
  seconds: number[][];
  meters: number[][];
  baseSeconds: number[][];
  modelVersion: string;
};

/**
 * 予測移動時間の行列（planning から呼ぶ入口）。
 * departAtMs は代表の出発時刻（時間帯の補正と、Routes API の出発時刻に使う）。
 */
export async function predictMatrix(
  orgId: string,
  points: LatLng[],
  mode: TravelMode,
  date: string,
  departAtMs: number,
  model?: TravelModel,
): Promise<PredictedMatrix> {
  const m = model ?? (await currentModel(orgId));
  const base = await baseMatrix(orgId, points, mode, departAtMs);
  const key = factorKey(mode, timeBandOf(hhmmToMinutes(jstHhmm(departAtMs))), dayTypeOf(weekday(date)));
  const usedFallback = base.some((row) => row.some((l) => l.source === 'fallback' && l.seconds > 0));
  return {
    baseSeconds: base.map((row) => row.map((l) => l.seconds)),
    seconds: base.map((row) => row.map((l) => applyModel(l.seconds, m, key))),
    meters: base.map((row) => row.map((l) => l.meters)),
    modelVersion: usedFallback ? `${m.version}+fallback` : m.version,
  };
}

/**
 * 勤怠候補が更新されたら、連続する訪問の実測区間（前の退出→次の到着）を予測値と並べて保存する。
 * 到着を補完した区間は学習に使わない印（filled）を付ける。
 */
export const onAttendanceDayWritten = onDocumentWritten(
  { document: 'orgs/{orgId}/attendanceDays/{id}', region: REGION, secrets: [MAPS_SERVER_KEY] },
  async (e) => {
    const day = e.data?.after.data() as AttendanceDay | undefined;
    if (!day) return;
    const orgId = e.params.orgId;
    const done = day.visits
      .map((v) => ({
        v,
        arrive: effective(v, 'arrive'),
        start: effective(v, 'start'),
        end: effective(v, 'end'),
        depart: effective(v, 'depart'),
      }))
      .filter((x) => x.arrive !== null && x.end !== null && x.start !== null)
      .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
    if (done.length < 2) return;
    const [visitSnaps, staffSnap] = await Promise.all([
      db.getAll(...done.map((d) => col(orgId, 'visits').doc(d.v.visitId))),
      col(orgId, 'staff').doc(day.staffId).get(),
    ]);
    const mode = (staffSnap.data()?.travelMode as TravelMode | undefined) ?? 'DRIVE';
    const clientIds = visitSnaps.map((s) => s.data()?.clientId as string | undefined);
    const clientSnaps = await db.getAll(...clientIds.map((id) => col(orgId, 'clients').doc(id ?? '_none')));
    const places = clientSnaps.map((s) => (s.data() as Client | undefined)?.place);
    const model = await currentModel(orgId);
    const batch = db.batch();
    for (let i = 1; i < done.length; i++) {
      const prev = done[i - 1]!;
      const cur = done[i]!;
      const a = places[i - 1];
      const b = places[i];
      if (!a?.lat || !a.lng || !b?.lat || !b.lng) continue;
      const departAt = prev.depart ?? prev.end!;
      const pm = await predictMatrix(
        orgId,
        [
          { lat: a.lat, lng: a.lng },
          { lat: b.lat, lng: b.lng },
        ],
        mode,
        day.date,
        departAt,
        model,
      );
      batch.set(col(orgId, 'legActuals').doc(`${day.staffId}_${day.date}_${i}`), {
        staffId: day.staffId,
        date: day.date,
        fromVisitId: prev.v.visitId,
        toVisitId: cur.v.visitId,
        mode,
        key: factorKey(mode, timeBandOf(hhmmToMinutes(jstHhmm(departAt))), dayTypeOf(weekday(day.date))),
        departAt,
        actualSeconds: Math.round((cur.arrive! - departAt) / 1000),
        predictedSeconds: pm.seconds[0]![1]!,
        baseSeconds: pm.baseSeconds[0]![1]!,
        modelVersion: pm.modelVersion,
        filled: cur.v.arriveFilled || prev.depart === null,
      });
    }
    await batch.commit();
  },
);

/** 実測区間から補正モデルの新しい版を作る（運営者のみ） */
export const trainModel = onCall({ region: REGION }, async (req) => {
  const c = callerOf(req);
  if (c.role !== 'operator') throw new HttpsError('permission-denied', 'この操作は運営者だけができます');
  const orgId =
    typeof (req.data as { orgId?: unknown })?.orgId === 'string' ? (req.data as { orgId: string }).orgId : null;
  if (!orgId) throw new HttpsError('invalid-argument', '事業所を指定してください');
  const snap = await col(orgId, 'legActuals').where('filled', '==', false).get();
  const samples = snap.docs.map((d) => d.data() as { key: string; baseSeconds: number; actualSeconds: number });
  const factors = trainFactors(samples);
  const version = `v${Date.now()}`;
  await col(orgId, 'travelModels')
    .doc(version)
    .set({ version, factors, sampleCount: samples.length, createdAt: Date.now() });
  return { version, factors, sampleCount: samples.length };
});
