import {
  type Client,
  createPlanRunRequest,
  evaluatePlan,
  hhmmToMinutes,
  jstToMs,
  minutesToHhmm,
  type Org,
  type Staff,
  type TravelMode,
  weekday,
} from '@vrp/shared';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { callerOf, col, orgDoc, parse, REGION, requireManager } from '../../lib/context';
import { manualPlanOf, routesOf, visitsOfDate } from '../../lib/schedule';
import { MAPS_SERVER_KEY, predictMatrix } from '../travel-time';
import { prepare, toEvalMatrix } from './domain/buildSolve';
import { OPTIMIZER_URL, solve } from './infrastructure/optimizerClient';

export { OPTIMIZER_URL };

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
    const runRef = col(orgId, 'planRuns').doc(runId);
    if ((await runRef.get()).exists) return { runId };

    const [orgSnap, staffSnap, clientSnap, visits, manual] = await Promise.all([
      orgDoc(orgId).get(),
      col(orgId, 'staff').get(),
      col(orgId, 'clients').get(),
      visitsOfDate(orgId, date),
      manualPlanOf(orgId, date),
    ]);
    if (!orgSnap.exists) throw new HttpsError('not-found', '事業所がありません');
    if (visits.length === 0) throw new HttpsError('failed-precondition', 'この日の訪問がありません');
    const org = orgSnap.data() as Org;
    const staff = staffSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Staff) }));
    const clients = new Map(clientSnap.docs.map((d) => [d.id, d.data() as Client]));
    const manualRoutes = routesOf(visits, manual);

    const prepared = prepare({ org, staff, clients, visits, manualRoutes, weekday: weekday(date) }, date);
    if (prepared.staffIn.length === 0)
      throw new HttpsError('failed-precondition', '対象のスタッフがいません（自宅の位置・勤務曜日を確認してください）');
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
    const metrics = {
      manual: evaluatePlan(manualRoutes, prepared.staffIn, prepared.visitsIn, evalM, org.fareYenPerKm),
      ai: evaluatePlan(aiRoutes, prepared.staffIn, prepared.visitsIn, evalM, org.fareYenPerKm),
    };
    await runRef.set({
      date,
      requestId,
      mode: org.optimizeMode,
      travelMode: mode,
      createdBy: c.uid,
      createdAt: Date.now(),
      modelVersion: matrix.modelVersion,
      solverVersion: result.solverVersion,
      // Firestore は配列の配列を保存できないため、入力（行列を含む）は JSON 文字列で残す（再現用）
      inputJson: JSON.stringify(solveReq),
      baseSecondsJson: JSON.stringify(matrix.baseSeconds),
      manualRoutes,
      manualMinutesSpent: manual?.minutesSpent ?? null,
      result,
      metrics,
      skipped: prepared.skipped,
      computeMillis: elapsed,
    });
    return { runId };
  },
);
