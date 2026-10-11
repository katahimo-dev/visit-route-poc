import { z } from 'zod';
import { MAX_SLOTS, slotsError } from '../domain/availability';
import {
  ATTENDANCE_STATUSES,
  EVENT_SOURCES,
  EVENT_TYPES,
  GENDERS,
  INDUSTRIES,
  OPTIMIZE_MODES,
  TRAVEL_MODES,
  WINDOW_KINDS,
} from './codes';

/** Firestore の文書の形。パスは orgs/{orgId}/{collection}/{id}（design.md §4） */

export const hhmmSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '時刻は HH:mm で入力してください');
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付は YYYY-MM-DD です');

export const latLngSchema = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
export type LatLng = z.infer<typeof latLngSchema>;

export const placeSchema = z.object({
  address: z.string().max(200),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
});
export type Place = z.infer<typeof placeSchema>;

export const termsSchema = z.object({
  client: z.string().max(10),
  staff: z.string().max(10),
});
export type Terms = z.infer<typeof termsSchema>;

/** orgs/{orgId} */
export const orgSchema = z.object({
  name: z.string().min(1).max(100),
  industry: z.enum(INDUSTRIES),
  terms: termsSchema,
  optimizeMode: z.enum(OPTIMIZE_MODES),
  geofenceMeters: z.number().int().min(30).max(500),
  showAiToStaff: z.boolean(),
  fareYenPerKm: z.number().min(0).max(1000),
  /** 移動時間に Google の地図API（Routes API）を使う。省略は true。false なら直線距離からの概算（管理者が切り替える） */
  useMapsApi: z.boolean().optional(),
  /** デモ用の架空の事業所（seedDemo だけが付ける）。デモ用ログインはこの印のある事業所にしか入れない */
  demo: z.boolean().optional(),
});
export type Org = z.infer<typeof orgSchema>;

/** orgs/{orgId}/staff/{staffId} */
export const staffSchema = z.object({
  name: z.string().min(1).max(50),
  email: z.string().email().max(200),
  gender: z.enum(GENDERS),
  home: placeSchema,
  travelMode: z.enum(TRAVEL_MODES),
  /** 0=日〜6=土 */
  workDays: z.array(z.number().int().min(0).max(6)).max(7),
  shiftStart: hhmmSchema,
  shiftEnd: hhmmSchema,
  active: z.boolean(),
  uid: z.string().nullable(),
});
export type Staff = z.infer<typeof staffSchema>;

/** orgs/{orgId}/clients/{clientId} */
export const clientSchema = z.object({
  displayName: z.string().min(1).max(50),
  place: placeSchema,
  requiredGender: z.enum(['female', 'male']).nullable(),
  note: z.string().max(500),
  /** 色の丸の番号（0〜7） */
  color: z.number().int().min(0).max(7),
  active: z.boolean(),
});
export type Client = z.infer<typeof clientSchema>;

/** orgs/{orgId}/clientPrivate/{clientId}。管理者だけが読む訪問先の情報（スタッフに見せない） */
export const clientPrivateSchema = z.object({
  ngStaffIds: z.array(z.string()).max(50),
});
export type ClientPrivate = z.infer<typeof clientPrivateSchema>;

/** orgs/{orgId}/visits/{visitId}。staffId は手作業の担当（予定の「予」） */
export const visitSchema = z.object({
  date: dateSchema,
  clientId: z.string().min(1),
  windowKind: z.enum(WINDOW_KINDS),
  earliestStart: hhmmSchema,
  latestStart: hhmmSchema,
  durationMinutes: z.number().int().min(5).max(720),
  staffId: z.string().nullable(),
  cancelled: z.boolean(),
  note: z.string().max(200),
});
export type Visit = z.infer<typeof visitSchema>;

/** orgs/{orgId}/manualPlans/{date}。スタッフごとの訪問の順番（手作業案） */
export const manualPlanSchema = z.object({
  date: dateSchema,
  routes: z.record(z.string(), z.array(z.string())),
  /** ルート作成にかかった分数（管理者の申告。KPI） */
  minutesSpent: z.number().int().min(0).max(1440).nullable(),
  updatedBy: z.string(),
  updatedAt: z.number(),
});
export type ManualPlan = z.infer<typeof manualPlanSchema>;

/** orgs/{orgId}/events/{eventId}。eventId は端末で作った UUID（再送しても同じ文書） */
export const eventSchema = z.object({
  staffId: z.string(),
  date: dateSchema,
  type: z.enum(EVENT_TYPES),
  visitId: z.string().nullable(),
  source: z.enum(EVENT_SOURCES),
  /** 端末の時刻（ms） */
  clientTime: z.number(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  accuracy: z.number().nullable(),
});
export type VisitEvent = z.infer<typeof eventSchema>;

/** orgs/{orgId}/locationSamples/{id}。勤務中だけ、間引き済み */
export const locationSampleSchema = z.object({
  staffId: z.string(),
  date: dateSchema,
  clientTime: z.number(),
  lat: z.number(),
  lng: z.number(),
  accuracy: z.number(),
});

/** 訪問1件の勤怠候補（ms。null は未記録） */
export const attendanceVisitSchema = z.object({
  visitId: z.string(),
  planned: z.object({ start: hhmmSchema, end: hhmmSchema }),
  arrive: z.number().nullable(),
  start: z.number().nullable(),
  end: z.number().nullable(),
  depart: z.number().nullable(),
  /** はじめる時刻で到着を補った */
  arriveFilled: z.boolean(),
  /** 本人の訂正（項目→ms） */
  corrections: z.record(z.string(), z.number()),
  correctionNote: z.string().max(200),
  /** 予定と実績が15分以上ずれた */
  changed: z.boolean(),
});
export type AttendanceVisit = z.infer<typeof attendanceVisitSchema>;

/** orgs/{orgId}/attendanceDays/{staffId}_{date}（業務関数だけが書く） */
export const attendanceDaySchema = z.object({
  staffId: z.string(),
  date: dateSchema,
  shiftStart: z.number().nullable(),
  shiftEnd: z.number().nullable(),
  visits: z.array(attendanceVisitSchema),
  /** 分 */
  totals: z.object({
    workMinutes: z.number(),
    travelMinutes: z.number(),
    breakMinutes: z.number(),
    boundMinutes: z.number(),
  }),
  status: z.enum(ATTENDANCE_STATUSES),
  version: z.number().int(),
  approvedBy: z.string().nullable(),
});
export type AttendanceDay = z.infer<typeof attendanceDaySchema>;

/** 時間帯（30分単位、HH:mm） */
export const slotSchema = z.object({
  start: hhmmSchema.regex(/:[03]0$/, '時間は30分単位で選んでください'),
  end: hhmmSchema.regex(/:[03]0$/, '時間は30分単位で選んでください'),
});

/**
 * orgs/{orgId}/availability/{staffId}_{date}。その日の稼働時間帯の上書き（ADR-0008）。
 * 文書が無ければ基本の曜日と時間、slots が空ならその日は休み
 */
export const availabilitySchema = z
  .object({
    staffId: z.string().min(1),
    date: dateSchema,
    slots: z.array(slotSchema).max(MAX_SLOTS),
    /** 本人がアプリで変えた（管理者のカレンダーに印を出す） */
    byStaff: z.boolean(),
    updatedBy: z.string(),
    updatedAt: z.number(),
  })
  .superRefine((a, ctx) => {
    const e = slotsError(a.slots);
    if (e) ctx.addIssue({ code: 'custom', path: ['slots'], message: e });
  });
export type Availability = z.infer<typeof availabilitySchema>;
