/** 業種。シッター専用の表示を出すかどうかに使う */
export const INDUSTRIES = ['sitter', 'care', 'nursing', 'other'] as const;
export type Industry = (typeof INDUSTRIES)[number];

/** ロール。operator は実証運営者（全事業所を読める） */
export const ROLES = ['operator', 'admin', 'staff'] as const;
export type Role = (typeof ROLES)[number];

/** 最適化モード。order_only は担当を変えず順番だけ */
export const OPTIMIZE_MODES = ['order_only', 'assign_and_order'] as const;
export type OptimizeMode = (typeof OPTIMIZE_MODES)[number];

export const GENDERS = ['female', 'male', 'unspecified'] as const;
export type Gender = (typeof GENDERS)[number];

/** 移動手段（Routes API の travelMode と同じ名前） */
export const TRAVEL_MODES = ['DRIVE', 'BICYCLE', 'WALK', 'TRANSIT'] as const;
export type TravelMode = (typeof TRAVEL_MODES)[number];

/** 時間の約束。fixed は開始時刻が決まっている、window は幅の中で開始 */
export const WINDOW_KINDS = ['fixed', 'window'] as const;

/**
 * スタッフの記録の種類。
 * T1/T2：client_open・route_open（顧客情報・経路を開いた）、T3：arrive（到着）、T4：service_start（はじめる）
 */
export const EVENT_TYPES = [
  'shift_start',
  'shift_end',
  'client_open',
  'client_close',
  'route_open',
  'route_close',
  'arrive',
  'depart',
  'service_start',
  'service_end',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** 記録の出どころ。geofence＝端末の距離判定、button＝本人の操作、filled＝はじめる時刻で補った */
export const EVENT_SOURCES = ['geofence', 'button', 'filled'] as const;

export const ATTENDANCE_STATUSES = ['candidate', 'confirmed_by_staff', 'approved'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

/** 守れなかった訪問の原因（optimizer の契約と同じ） */
export const UNASSIGNED_REASONS = ['time_window', 'shift', 'gender', 'ng_staff', 'unreachable'] as const;
export type UnassignedReason = (typeof UNASSIGNED_REASONS)[number];
