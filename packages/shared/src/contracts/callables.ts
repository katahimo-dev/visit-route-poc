import { z } from 'zod';
import { dateSchema } from './documents';
import { DEFAULT_PLAN_PARAMS, planParamsSchema } from './planParams';

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

/** ログイン：メールに6桁のコードを送る（招待済みのアドレスだけ。結果は送ったかどうかによらず同じ） */
export const requestLoginCodeRequest = z.object({ email: z.string().trim().toLowerCase().email().max(254) });
export const requestLoginCodeResponse = z.object({ sent: z.literal(true) });
/** ログイン：コードを確かめ、ログイン用のトークンを返す */
export const verifyLoginCodeRequest = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  code: z.string().regex(/^\d{6}$/, '6桁の数字で入力してください'),
});
export const signInTokenResponse = z.object({ token: z.string() });
/** デモ用のログイン（デモの事業所が設定された環境だけ）。staffId は as=staff のとき誰として入るか（null なら最初の人） */
/** デモの簡易パスワード（不特定多数をはじくだけ） */
const demoPassword = z.string().min(1, 'パスワードを入力してください').max(100);
export const demoSignInRequest = z.object({
  password: demoPassword,
  as: z.enum(['admin', 'staff']),
  staffId: z
    .string()
    .regex(/^[\w-]{1,64}$/)
    .nullable()
    .default(null),
});
/** デモ用：ログインする人を選ぶための、デモの事業所のスタッフ（架空の人物だけ）。date の訪問件数つき */
export const demoStaffListRequest = z.object({ password: demoPassword, date: dateSchema });
export const demoStaffListResponse = z.object({
  staff: z.array(z.object({ id: z.string(), name: z.string(), visits: z.number().int() })),
});

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
  /** AI案のパラメータ（省略は第1プリセット。ADR-0009） */
  params: planParamsSchema.default(DEFAULT_PLAN_PARAMS),
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
  requestLoginCode: { req: requestLoginCodeRequest, res: requestLoginCodeResponse },
  verifyLoginCode: { req: verifyLoginCodeRequest, res: signInTokenResponse },
  demoSignIn: { req: demoSignInRequest, res: signInTokenResponse },
  demoStaffList: { req: demoStaffListRequest, res: demoStaffListResponse },
  geocodeAddress: { req: geocodeAddressRequest, res: geocodeAddressResponse },
  createPlanRun: { req: createPlanRunRequest, res: createPlanRunResponse },
  correctAttendance: { req: correctAttendanceRequest, res: attendanceVersionResponse },
  confirmAttendance: { req: confirmAttendanceRequest, res: attendanceVersionResponse },
  approveAttendance: { req: approveAttendanceRequest, res: attendanceVersionResponse },
  exportAttendanceCsv: { req: exportAttendanceCsvRequest, res: csvFilesResponse },
  exportStudyData: { req: exportStudyDataRequest, res: csvFilesResponse },
} as const;
export type CallableName = keyof typeof CALLABLES;
