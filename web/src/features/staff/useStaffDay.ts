import {
  type Client,
  hhmmToMinutes,
  jstDate,
  type ManualPlan,
  type Staff,
  type Visit,
  type VisitEvent,
} from '@vrp/shared';
import { where } from 'firebase/firestore';
import { useMemo } from 'react';
import { useSession } from '../../lib/session';
import { useOrgCollection, useOrgDoc, type WithId } from '../../lib/useCollection';

export type StaffStop = {
  visit: WithId<Visit>;
  client: WithId<Client> | null;
  /** その訪問の自分の記録 */
  events: VisitEvent[];
  status: 'todo' | 'arrived' | 'in_service' | 'done';
};

/** 自分のきょう（または指定日）の順番と記録 */
export function useStaffDay(date: string = jstDate(Date.now())) {
  const s = useSession();
  const staffId = s.staffId;
  const { rows: visits } = useOrgCollection<Visit>(s.orgId, 'visits', [where('date', '==', date)], date);
  const { rows: clients } = useOrgCollection<Client>(s.orgId, 'clients');
  const { rows: events } = useOrgCollection<VisitEvent>(
    s.orgId,
    'events',
    [where('staffId', '==', staffId ?? ''), where('date', '==', date)],
    `${staffId}:${date}`,
  );
  const manual = useOrgDoc<ManualPlan>(s.orgId, 'manualPlans', date);
  const me = useOrgDoc<Staff>(s.orgId, 'staff', staffId);

  return useMemo(() => {
    const loading = visits === null || clients === null || events === null || manual === undefined || me === undefined;
    const alive = (visits ?? []).filter((v) => !v.cancelled);
    const byId = new Map(alive.map((v) => [v.id, v]));
    // 手作業案の順番。無ければ担当の訪問を開始時刻順（決定案は改修版で優先）
    let order = (manual?.routes[staffId ?? ''] ?? []).filter((id) => byId.has(id));
    if (order.length === 0) {
      order = alive
        .filter((v) => v.staffId === staffId)
        .sort((a, b) => hhmmToMinutes(a.earliestStart) - hhmmToMinutes(b.earliestStart))
        .map((v) => v.id);
    }
    const clientById = new Map((clients ?? []).map((c) => [c.id, c]));
    const evs = (events ?? []).slice().sort((a, b) => a.clientTime - b.clientTime);
    const stops: StaffStop[] = order.map((id) => {
      const visit = byId.get(id) as WithId<Visit>;
      const mine = evs.filter((e) => e.visitId === id);
      const has = (t: VisitEvent['type']) => mine.some((e) => e.type === t);
      const status = has('service_end')
        ? 'done'
        : has('service_start')
          ? 'in_service'
          : has('arrive')
            ? 'arrived'
            : 'todo';
      return { visit, client: clientById.get(visit.clientId) ?? null, events: mine, status };
    });
    const lastShift = [...evs].reverse().find((e) => e.type === 'shift_start' || e.type === 'shift_end');
    return {
      loading,
      date,
      me: me ?? null,
      stops,
      events: evs,
      onShift: lastShift?.type === 'shift_start',
    };
  }, [visits, clients, events, manual, me, staffId, date]);
}
