import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createService, Topics, RerouteCommand, PushNotification } from '@urbanflow/shared';
import { predict, LiveSample, CONGESTION_SPEED_KMH } from './predictor';

const PORT = Number(process.env.PORT ?? 3006);
const TICK_MS = Number(process.env.PREDICT_TICK_MS ?? 5000);
const RISK_THRESHOLD = Number(process.env.RISK_THRESHOLD ?? 0.6);

/** Corredor alterno sugerido al re-enrutar (en producción saldría del grafo). */
const ALTERNATE: Record<string, string> = {
  'B-101': 'B-303',
  'B-202': 'B-101',
  'B-303': 'B-404',
  'B-404': 'B-202',
};

/**
 * congestion-prediction-service (MVP 3, inciso VI)
 * - Predice puntos de congestión con 30 min de anticipación (modelo heurístico
 *   sobre baseline del data lake + tendencia en vivo de TimescaleDB).
 * - Re-enruta buses automáticamente y notifica a conductores.
 * - NFR: el re-enrutamiento se ejecuta en < 10 s desde la detección (se mide).
 * - bus.reroute es AUDITABLE (trazabilidad regulatoria - MVP 4).
 */
async function main() {
  const pool = new Pool({
    host: process.env.TIMESCALE_HOST ?? 'localhost',
    port: Number(process.env.TIMESCALE_PORT ?? 5433),
    user: process.env.TIMESCALE_USER ?? 'urbanflow',
    password: process.env.TIMESCALE_PASSWORD ?? 'urbanflow_secret',
    database: process.env.TIMESCALE_DB ?? 'telemetry',
    max: 10,
  });

  await createService({
    name: 'congestion-prediction-service',
    port: PORT,
    setup: async ({ app, bus, log }) => {
      const lastPredictions = new Map<string, ReturnType<typeof predict>>();
      const recentReroutes = new Map<string, number>(); // busId -> ts, throttle

      async function liveSamples(): Promise<LiveSample[]> {
        // Velocidad media por ruta en los últimos 6 minutos (1 muestra/min).
        const r = await pool.query(
          `SELECT route_id,
                  array_agg(avg_speed ORDER BY bucket) AS speeds,
                  avg(avg_delay) AS avg_delay
           FROM (
             SELECT time_bucket('1 minute', time) AS bucket, route_id,
                    avg(speed_kmh) AS avg_speed, avg(delay_seconds) AS avg_delay
             FROM gps_telemetry
             WHERE time > now() - interval '6 minutes'
             GROUP BY bucket, route_id
           ) s
           GROUP BY route_id`,
        );
        return r.rows.map((row) => ({
          routeId: row.route_id,
          recentSpeeds: (row.speeds as number[]).map(Number),
          avgDelaySec: Number(row.avg_delay ?? 0),
        }));
      }

      async function busesOnRoute(routeId: string): Promise<string[]> {
        const r = await pool.query(
          `SELECT DISTINCT vehicle_id FROM gps_telemetry
           WHERE route_id = $1 AND vehicle_type = 'BUS' AND time > now() - interval '2 minutes'`,
          [routeId],
        );
        return r.rows.map((x) => x.vehicle_id);
      }

      async function tick() {
        let samples: LiveSample[];
        try {
          samples = await liveSamples();
        } catch {
          return; // TimescaleDB aún no lista o sin datos
        }
        const hour = new Date().getHours();

        for (const s of samples) {
          const prediction = predict(s, hour);
          lastPredictions.set(s.routeId, prediction);
          await bus.publish(Topics.CONGESTION_PREDICTIONS, prediction, { key: s.routeId, type: 'congestion.predicted' });

          const congested = prediction.congestionRisk >= RISK_THRESHOLD || prediction.predictedSpeedKmh < CONGESTION_SPEED_KMH;
          if (!congested) continue;

          // ---- Anomalía detectada: re-enrutar buses afectados (SLA < 10 s) ----
          const anomalyDetectedAt = new Date().toISOString();
          const buses = await busesOnRoute(s.routeId);
          for (const busId of buses) {
            const last = recentReroutes.get(busId) ?? 0;
            if (Date.now() - last < 120_000) continue; // throttle 2 min por bus
            recentReroutes.set(busId, Date.now());

            const reroute: RerouteCommand = {
              rerouteId: randomUUID(),
              busId,
              routeId: s.routeId,
              fromCorridorId: s.routeId,
              toCorridorId: ALTERNATE[s.routeId] ?? s.routeId,
              reason: `Congestión prevista (riesgo ${prediction.congestionRisk}, v=${prediction.predictedSpeedKmh} km/h) a ${prediction.horizonMin} min`,
              predictedDelaySavedSec: Math.round((CONGESTION_SPEED_KMH - prediction.predictedSpeedKmh + 8) * 30),
              anomalyDetectedAt,
            };
            // bus.reroute es AUDITABLE -> replicado a audit.log por el EventBus.
            await bus.publish(Topics.BUS_REROUTE, reroute, { key: busId, correlationId: reroute.rerouteId, type: 'bus.reroute' });

            // Notificar al conductor.
            const notif: PushNotification = {
              notificationId: randomUUID(),
              citizenId: `driver:${busId}`,
              category: 'DETOUR',
              title: 'Re-enrutamiento automático',
              body: `Desvío ${reroute.fromCorridorId} -> ${reroute.toCorridorId}. ${reroute.reason}`,
              payload: { rerouteId: reroute.rerouteId },
            };
            await bus.publish(Topics.NOTIFICATIONS, notif, { key: notif.citizenId, correlationId: reroute.rerouteId, type: 'notification.detour' });

            const elapsedMs = Date.now() - new Date(anomalyDetectedAt).getTime();
            log.warn({ busId, route: s.routeId, elapsedMs, slaMs: 10000, withinSLA: elapsedMs < 10000 }, 'Bus re-enrutado');
          }
        }
      }

      const timer = setInterval(() => void tick().catch((e) => log.error({ err: e }, 'tick error')), TICK_MS);
      timer.unref();

      app.get('/predictions', (_req, res) => {
        res.json([...lastPredictions.values()]);
      });
      app.get('/predictions/:corridorId', (req, res) => {
        const p = lastPredictions.get(req.params.corridorId);
        if (!p) return res.status(404).json({ error: 'sin predicción para el corredor' });
        res.json(p);
      });

      log.info({ tickMs: TICK_MS, riskThreshold: RISK_THRESHOLD }, 'congestion-prediction-service activo');
    },
  });
}

main().catch((err) => {
  console.error('Fallo fatal congestion-prediction-service', err);
  process.exit(1);
});
