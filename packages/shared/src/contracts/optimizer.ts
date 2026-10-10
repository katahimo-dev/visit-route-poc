import { z } from 'zod';
import { UNASSIGNED_REASONS } from './codes';

/** 最適化サービスの契約（docs/api/openapi.yaml と同じ形） */

const hhmm = z.string().regex(/^\d{2}:\d{2}$/);

export const solveRequestSchema = z.object({
  requestId: z.string(),
  mode: z.enum(['order_only', 'assign_and_order']),
  date: z.string(),
  staff: z.array(
    z.object({
      staffId: z.string(),
      gender: z.enum(['female', 'male', 'unspecified']).optional(),
      startPoint: z.number().int(),
      endPoint: z.number().int(),
      shiftStart: hhmm,
      shiftEnd: hhmm,
      maxVisits: z.number().int().optional(),
    }),
  ),
  visits: z.array(
    z.object({
      visitId: z.string(),
      point: z.number().int(),
      durationMinutes: z.number().int(),
      window: z.object({ kind: z.enum(['fixed', 'window']), earliestStart: hhmm, latestStart: hhmm }),
      currentStaffId: z.string().optional(),
      requiredGender: z.enum(['female', 'male']).optional(),
      ngStaffIds: z.array(z.string()).optional(),
      minGapBeforeMinutes: z.number().int().optional(),
    }),
  ),
  matrix: z.object({
    points: z.array(z.object({ id: z.string() })),
    seconds: z.array(z.array(z.number().int())),
    meters: z.array(z.array(z.number().int())).optional(),
    modelVersion: z.string(),
  }),
  weights: z
    .object({ travelSeconds: z.number(), waitSeconds: z.number(), softWindowSeconds: z.number() })
    .partial()
    .optional(),
  limits: z.object({ timeLimitSeconds: z.number().int(), solutionLimit: z.number().int() }).partial().optional(),
});
export type SolveRequest = z.infer<typeof solveRequestSchema>;

export const solveResponseSchema = z.object({
  requestId: z.string(),
  routes: z.array(
    z.object({
      staffId: z.string(),
      stops: z.array(
        z.object({
          visitId: z.string(),
          arrival: hhmm,
          start: hhmm,
          end: hhmm,
          waitMinutes: z.number().int().optional(),
        }),
      ),
    }),
  ),
  unassigned: z.array(z.object({ visitId: z.string(), reasons: z.array(z.enum(UNASSIGNED_REASONS)) })),
  partial: z.boolean(),
  stats: z
    .object({
      totalTravelSeconds: z.number(),
      totalWaitSeconds: z.number(),
      totalMeters: z.number(),
      computeMillis: z.number(),
    })
    .partial(),
  solverVersion: z.string(),
});
export type SolveResponse = z.infer<typeof solveResponseSchema>;
