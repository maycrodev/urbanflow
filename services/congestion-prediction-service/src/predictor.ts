import { CongestionPrediction } from '@urbanflow/shared';

/**
 * Modelo de predicción de congestión (heurístico, complejidad media).
 *
 * Combina dos señales:
 *  1) Baseline histórico por corredor y hora del día — surrogate de los 10 años
 *     de datos del data lake (AWS S3). En producción este baseline se entrena
 *     offline y se publica como feature store.
 *  2) Tendencia en vivo: pendiente de la velocidad en los últimos minutos.
 *
 * Extrapola la velocidad a un horizonte de 30 min y deriva un riesgo 0..1.
 */

// Baseline km/h esperado por corredor según la hora (surrogate del data lake).
const BASELINE_SPEED: Record<string, number[]> = {
  // index = hora local (0..23). Horas pico 7-9 y 17-19 más lentas.
  'B-101': hourly(34, { 7: 16, 8: 14, 9: 18, 17: 15, 18: 13, 19: 17 }),
  'B-202': hourly(30, { 7: 14, 8: 12, 9: 16, 17: 13, 18: 11, 19: 15 }),
  'B-303': hourly(36, { 7: 18, 8: 15, 9: 20, 17: 16, 18: 14, 19: 18 }),
  'B-404': hourly(32, { 7: 15, 8: 13, 9: 17, 17: 14, 18: 12, 19: 16 }),
};
const DEFAULT_BASELINE = hourly(30, { 7: 16, 8: 14, 17: 15, 18: 13 });

function hourly(base: number, peaks: Record<number, number>): number[] {
  return Array.from({ length: 24 }, (_, h) => peaks[h] ?? base);
}

export interface LiveSample {
  routeId: string;
  /** Velocidades recientes (km/h), de más antigua a más reciente. */
  recentSpeeds: number[];
  avgDelaySec: number;
}

/** Umbral: por debajo de esta velocidad un corredor se considera congestionado. */
export const CONGESTION_SPEED_KMH = 12;

export function predict(sample: LiveSample, hourOfDay: number, horizonMin = 30): CongestionPrediction {
  const series = (BASELINE_SPEED[sample.routeId] ?? DEFAULT_BASELINE);
  const baseline = series[hourOfDay % 24];
  const speeds = sample.recentSpeeds.length ? sample.recentSpeeds : [baseline];
  const current = speeds[speeds.length - 1];

  // Tendencia: pendiente media entre muestras consecutivas (km/h por muestra).
  let slope = 0;
  for (let i = 1; i < speeds.length; i++) slope += speeds[i] - speeds[i - 1];
  slope = speeds.length > 1 ? slope / (speeds.length - 1) : 0;

  // Extrapolación a 30 min (asumiendo 1 muestra/min) acotada entre baseline y current.
  const projected = clamp(current + slope * horizonMin, 2, Math.max(baseline, current));

  // Riesgo: cuán por debajo del baseline queda la proyección + penalización por retraso.
  const speedDeficit = clamp((baseline - projected) / baseline, 0, 1);
  const delayFactor = clamp(sample.avgDelaySec / 600, 0, 1); // 10 min => 1
  const congestionRisk = round(clamp(0.7 * speedDeficit + 0.3 * delayFactor, 0, 1));

  return {
    corridorId: sample.routeId,
    segmentId: `${sample.routeId}-main`,
    congestionRisk,
    predictedSpeedKmh: round(projected),
    horizonMin,
    affectedRoutes: [sample.routeId],
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function round(n: number): number {
  return Math.round(n * 100) / 100;
}
