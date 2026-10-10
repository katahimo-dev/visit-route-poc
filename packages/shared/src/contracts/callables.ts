import { z } from 'zod';
import { dateSchema } from './documents';

/** 業務関数（Callable）の入出力。design.md §5 */

export const inviteMemberRequest = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'staff']),
  /** role=staff のとき、紐づけるスタッフ */
  staffId: z.string().nullable(),
  /** operator だけ指定できる。admin は自分の事業所に固定 */
  orgId: z.string().nullable(),
});
export const inviteMemberResponse = z.object({ uid: z.string() });

export const geocodeAddressRequest = z.object({ address: z.string().min(1).max(200) });
export const geocodeAddressResponse = z.object({
  candidates: z.array(z.object({ formattedAddress: z.string(), lat: z.number(), lng: z.number() })),
});

/** operator だけが指定できる対象事業所。admin は自分の事業所に固定（指定は無視） */
const orgIdField = z.string().nullable().default(null);

export const createPlanRunRequest = z.object({
  date: dateSchema,
  requestId: z.string().min(8).max(64),
  orgId: orgIdField,
});
export const createPlanRunResponse = z.object({ runId: z.string() });

export const ATTENDANCE_FIELDS = ['arrive', 'start', 'end', 'depart'] as const;
export const correctAttendanceRequest = z.object({
  /** coordinator 用。staff は無視して本人 */
  staffId: z.string().nullable(),
  date: dateSchema,
  visitId: z.string(),
  field: z.enum(ATTENDANCE_FIELDS),
  value: z.number(),
  note: z.string().max(200),
  version: z.number().int(),
});
export const confirmAttendanceRequest = z.object({ date: dateSchema, version: z.number().int() });
export const approveAttendanceRequest = z.object({
  staffId: z.string(),
  date: dateSchema,
  version: z.number().int(),
  orgId: orgIdField,
});
export const attendanceVersionResponse = z.object({ version: z.number().int() });

export const exportAttendanceCsvRequest = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), orgId: orgIdField });
export const exportStudyDataRequest = z.object({ orgId: z.string().nullable(), from: dateSchema, to: dateSchema });
export const csvFilesResponse = z.object({
  files: z.array(z.object({ name: z.string(), csv: z.string() })),
});

/** Callable の名前と入出力の対応（web の呼び出しヘルパーが使う） */
export const CALLABLES = {
  inviteMember: { req: inviteMemberRequest, res: inviteMemberResponse },
  geocodeAddress: { req: geocodeAddressRequest, res: geocodeAddressResponse },
  createPlanRun: { req: createPlanRunRequest, res: createPlanRunResponse },
  correctAttendance: { req: correctAttendanceRequest, res: attendanceVersionResponse },
  confirmAttendance: { req: confirmAttendanceRequest, res: attendanceVersionResponse },
  approveAttendance: { req: approveAttendanceRequest, res: attendanceVersionResponse },
  exportAttendanceCsv: { req: exportAttendanceCsvRequest, res: csvFilesResponse },
  exportStudyData: { req: exportStudyDataRequest, res: csvFilesResponse },
} as const;
export type CallableName = keyof typeof CALLABLES;
