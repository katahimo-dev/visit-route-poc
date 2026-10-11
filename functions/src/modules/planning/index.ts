import {
  type Availability,
  type Client,
  type ClientPrivate,
  createPlanRunRequest,
  evaluatePlan,
  hhmmToMinutes,
  jstToMs,
  minutesToHhmm,
  type Org,
  routeViews,
  type Staff,
  type TravelMode,
} from '@vrp/shared';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { callerOf, col, orgDoc, parse, REGION, requireManager } from '../../lib/context';
import { manualPlanOf, routesOf, visitsOfDate } from '../../lib/schedule';
import { MAPS_SERVER_KEY, predictMatrix } from '../travel-time';
import { prepare, toEvalMatrix } from './domain/buildSolve';
import { OPTIMIZER_URL, solve } from './infrastructure/optimizerClient';

export { OPTIMIZER_URL };

/** 1事業所が1時間に作れるAI案の数（地図API・最適化の課金の天井。押し間違いの連打も止める） */
const RUNS_PER_HOUR = 20;

/**
 * 同じ requestId の二重実行を防ぐ鍵を作る（create は既にあると失敗するので原子的）。
 * 作れたら true、既にあれば false。1時間の上限を超えていたら RESOURCE_EXHAUSTED。
 */
async function acquireRun(orgId: string, runId: string, uid: string): Promise<boolean> {
  const locks = col(orgId, 'planRunLocks');
  const recent = await locks
    .where('createdAt', '>=', Date.now() - 3600000)
    .count()
    .get();
  if (recent.data().count >= RUNS_PER_HOUR)
    throw new HttpsError('resource-exhausted', 'AI案の作成回数が多すぎます。1時間ほど待ってから作成してください');
  try {
    await locks.doc(runId).create({ createdAt: Date.now(), createdBy: uid });
    return true;
  } catch (e) {
    // 6 = ALREADY_EXISTS（同じ requestId の再送・二重押し）
    if ((e as { code?: unknown }).code === 6) return false;
    throw e;
  }
}

/** 最も多い移動手段（α は1日1つの行列で計算する） */
function majorityMode(staff: Staff[]): TravelMode {
  const count = new Map<TravelMode, number>();
  for (const s of staff) count.set(s.travelMode, (count.get(s.travelMode) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'DRIVE';
}

/**
 * 指定日のAI案を作り、手作業案と同じ行列で比べた指標と一緒に planRuns に保存する。
 * AI案は予定を書き換えない（決定は改修版の decidePlan）。requestId が同じなら最初の結果を返す。
 */
export const createPlanRun = onCall(
  { region: REGION, timeoutSeconds: 120, memory: '512MiB', secrets: [MAPS_SERVER_KEY] },
  async (req) => {
    const c = callerOf(req);
    const { date, requestId, orgId: requestedOrgId } = parse(createPlanRunRequest, req.data);
    const orgId = requireManager(c, requestedOrgId);
    const runId = requestId.replace(/[^A-Za-z0-9_-]/g, '');
    if (runId.length < 8)
      throw new HttpsError('invalid-argument', '入力を確認してください', {
        fields: { requestId: '英数字で指定してください' },
      });
    const runRef = col(orgId, 'planRuns').doc(runId);
    if (!(await acquireRun(orgId, runId, c.uid))) return { runId };
    try {
      await run(orgId, runId, runRef, date, requestId, c.uid);
    } catch (e) {
      // 失敗したら鍵を外し、同じ requestId でやり直せるようにする
      await col(orgId, 'planRunLocks')
        .doc(runId)
        .delete()
        .catch(() => undefined);
      throw e;
    }
    return { runId };
  },
);

async function run(
  orgId: string,
  runId: string,
  runRef: FirebaseFirestore.DocumentReference,
  date: string,
  requestId: string,
  uid: string,
): Promise<void> {
  const [orgSnap, staffSnap, clientSnap, privateSnap, visits, manual, availSnap] = await Promise.all([
    orgDoc(orgId).get(),
    col(orgId, 'staff').get(),
    col(orgId, 'clients').get(),
    col(orgId, 'clientPrivate').get(),
    visitsOfDate(orgId, date),
    manualPlanOf(orgId, date),
    col(orgId, 'availability').where('date', '==', date).get(),
  ]);
  if (!orgSnap.exists) throw new HttpsError('not-found', '事業所がありません');
  if (visits.length === 0) throw new HttpsError('failed-precondition', 'この日の訪問がありません');
  const org = orgSnap.data() as Org;
  const staff = staffSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Staff) }));
  const privates = new Map(privateSnap.docs.map((d) => [d.id, d.data() as ClientPrivate]));
  const clients = new Map(
    clientSnap.docs.map((d) => [d.id, { ngStaffIds: [], ...(d.data() as Client), ...privates.get(d.id) }]),
  );
  const manualRoutes = routesOf(visits, manual);
  const availability = new Map(
    availSnap.docs.map((d) => [(d.data() as Availability).staffId, d.data() as Availability]),
  );

  const prepared = prepare({ org, staff, clients, visits, manualRoutes, availability }, date);
  if (prepared.staffIn.length === 0)
    throw new HttpsError('failed-precondition', '対象のスタッフがいません（自宅の位置・稼働時間帯を確認してください）');
  const firstStart = Math.min(...visits.map((v) => hhmmToMinutes(v.earliestStart)));
  const departAt = jstToMs(date, minutesToHhmm(Math.max(0, firstStart - 30)));
  const mode = majorityMode(staff.filter((s) => prepared.staffIn.some((x) => x.staffId === s.id)));
  const matrix = await predictMatrix(orgId, prepared.points, mode, date, departAt);

  const solveReq = {
    ...prepared.request,
    requestId: runId,
    // 解の数で打ち切る（同じ入力で同じ結果。8人×30件で約5秒）。時間は安全弁
    limits: { solutionLimit: 500, timeLimitSeconds: 25 },
    matrix: {
      points: prepared.points.map((p) => ({ id: p.id })),
      seconds: matrix.seconds,
      meters: matrix.meters,
      modelVersion: matrix.modelVersion,
    },
  };
  const started = Date.now();
  const result = await solve(solveReq);
  const elapsed = Date.now() - started;

  const evalM = toEvalMatrix(prepared.points, matrix.seconds, matrix.meters);
  const aiRoutes = Object.fromEntries(result.routes.map((r) => [r.staffId, r.stops.map((s) => s.visitId)]));
  // 地図APIを使ったときだけ、同じ順番を概算で計算した値を並べる（使わなければ同じ値なので出さない）
  const estM = matrix.mapsApi ? { seconds: matrix.estimateSeconds, measured: matrix.measured } : null;
  const views = {
    manual: routeViews(manualRoutes, prepared.staffIn, prepared.visitsIn, evalM, estM),
    ai: routeViews(aiRoutes, prepared.staffIn, prepared.visitsIn, evalM, estM),
  };
  const metrics = {
    manual: evaluatePlan(manualRoutes, prepared.staffIn, prepared.visitsIn, evalM, org.fareYenPerKm),
    ai: evaluatePlan(aiRoutes, prepared.staffIn, prepared.visitsIn, evalM, org.fareYenPerKm),
  };
  await runRef.set({
    date,
    requestId,
    mode: org.optimizeMode,
    travelMode: mode,
    createdBy: uid,
    createdAt: Date.now(),
    modelVersion: matrix.modelVersion,
    mapsApi: matrix.mapsApi,
    solverVersion: result.solverVersion,
    // Firestore は配列の配列を保存できないため、入力（行列を含む）は JSON 文字列で残す（再現用）
    inputJson: JSON.stringify(solveReq),
    baseSecondsJson: JSON.stringify(matrix.baseSeconds),
    manualRoutes,
    manualMinutesSpent: manual?.minutesSpent ?? null,
    result,
    metrics,
    views,
    skipped: prepared.skipped,
    computeMillis: elapsed,
  });
}
