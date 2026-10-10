import type { ManualPlan, Visit } from '@vrp/shared';
import { col } from './context';

/** schedule の読み取り（持ち主は schedule。ここでは読むだけ） */

export type VisitWithId = Visit & { id: string };

export async function visitsOfDate(orgId: string, date: string): Promise<VisitWithId[]> {
  const snap = await col(orgId, 'visits').where('date', '==', date).get();
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Visit) })).filter((v) => !v.cancelled);
}

export async function manualPlanOf(orgId: string, date: string): Promise<ManualPlan | null> {
  const snap = await col(orgId, 'manualPlans').doc(date).get();
  return snap.exists ? (snap.data() as ManualPlan) : null;
}

/**
 * スタッフ別の順番。手作業案があればその順、無い訪問は担当（visits.staffId）の開始時刻順で後ろに足す。
 * 決定案（decidedPlans）は改修版で優先する。
 */
export function routesOf(visits: VisitWithId[], manual: ManualPlan | null): Record<string, string[]> {
  const routes: Record<string, string[]> = {};
  const placed = new Set<string>();
  const alive = new Set(visits.map((v) => v.id));
  for (const [staffId, ids] of Object.entries(manual?.routes ?? {})) {
    routes[staffId] = ids.filter((id) => alive.has(id) && !placed.has(id));
    for (const id of routes[staffId]) placed.add(id);
  }
  const rest = visits.filter((v) => !placed.has(v.id) && v.staffId).sort((a, b) => a.earliestStart.localeCompare(b.earliestStart));
  for (const v of rest) {
    const staffId = v.staffId as string;
    routes[staffId] ??= [];
    routes[staffId].push(v.id);
  }
  return routes;
}
