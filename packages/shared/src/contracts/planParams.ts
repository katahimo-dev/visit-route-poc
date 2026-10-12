import { z } from 'zod';

/**
 * AI案のパラメータ（ADR-0009）。作るたびに planRuns に残し、AI案どうしを比べる。
 * 最適化サービスの契約（weights・maxVisits・minGapBeforeMinutes）と移動時間の求め方に対応させる
 */
export const planParamsSchema = z.object({
  /** 待ち時間の重み（移動時間を1としたとき）。0 なら待ちを気にせず移動だけを減らす */
  waitWeight: z.number().min(0).max(5),
  /** 訪問と訪問のあいだに空ける余裕（分） */
  minGapMinutes: z.number().int().min(0).max(60),
  /** 1人1日の訪問件数の上限。null は上限なし */
  maxVisitsPerStaff: z.number().int().min(1).max(30).nullable(),
  /** 移動時間に Google の地図APIを使う（false は直線距離からの概算） */
  mapsApi: z.boolean(),
});
export type PlanParams = z.infer<typeof planParamsSchema>;

export const PLAN_PRESET_IDS = ['standard', 'shortest', 'relaxed'] as const;
export type PlanPresetId = (typeof PLAN_PRESET_IDS)[number];

/** プリセットは最適化の重みと制約だけを決める。移動時間の求め方（mapsApi）は別に選ぶ */
export type PlanPreset = {
  id: PlanPresetId;
  label: string;
  description: string;
  params: Omit<PlanParams, 'mapsApi'>;
};

/** パラメータのプリセット。先頭が既定（その日のAI案が無いとき自動で作る） */
export const PLAN_PRESETS: readonly PlanPreset[] = [
  {
    id: 'standard',
    label: '標準',
    description: '移動時間を減らしつつ、待ち時間も少しおさえる',
    params: { waitWeight: 0.3, minGapMinutes: 0, maxVisitsPerStaff: null },
  },
  {
    id: 'shortest',
    label: '移動最短',
    description: '待ち時間は気にせず、移動時間だけを最も短くする',
    params: { waitWeight: 0, minGapMinutes: 0, maxVisitsPerStaff: null },
  },
  {
    id: 'relaxed',
    label: 'ゆとり・件数ならし',
    description: '訪問のあいだに10分の余裕をとり、1人3件までにして負担をならす',
    params: { waitWeight: 0.3, minGapMinutes: 10, maxVisitsPerStaff: 3 },
  },
];

/** 既定は第1プリセット・直線距離からの概算（地図APIの費用をかけない） */
export const DEFAULT_PLAN_PARAMS: PlanParams = { ...PLAN_PRESETS[0]!.params, mapsApi: false };

/** 重みと制約がどれかのプリセットと同じなら、その ID（手で変えたら null。mapsApi は見ない） */
export function presetIdOf(p: PlanParams): PlanPresetId | null {
  return (
    PLAN_PRESETS.find(
      (x) =>
        x.params.waitWeight === p.waitWeight &&
        x.params.minGapMinutes === p.minGapMinutes &&
        x.params.maxVisitsPerStaff === p.maxVisitsPerStaff,
    )?.id ?? null
  );
}
