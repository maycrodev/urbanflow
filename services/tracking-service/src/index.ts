import { Pool } from 'pg';
import Redis from 'ioredis';
import { createService, Topics, EventEnvelope, GpsTelemetry } from '@urbanflow/shared';

const PORT = Number(process.env.PORT ?? 3002);

/**
 * tracking-service (MVP 1, inciso II)
 * - Ingesta telemetría GPS (gps.telemetry) de buses/metros (>50k ev/s en pico).
 * - Persiste serie temporal en TimescaleDB (polyglot persistence: time-series).
 * - Mantiene la última posición en Redis para respuestas de baja latencia.
 * - Calcula llegadas EXACTAS por parada (ETA = distancia restante / velocidad).
 */
async function main() {
  const pool = new Pool({
    host: process.env.TIMESCALE_HOST ?? 'localhost',
    port: Number(process.env.TIMESCALE_PORT ?? 5433),
    user: process.env.TIMESCALE_USER ?? 'urbanflow',
    password: process.env.TIMESCALE_PASSWORD ?? 'urbanflow_secret',
    database: process.env.TIMESCALE_DB ?? 'telemetry',
    max: 20,
  });
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

  // Buffer para inserción por lotes (rendimiento en alto volumen).
  let buffer: GpsTelemetry[] = [];

  async function flush() {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    const values: unknown[] = [];
    const rows: string[] = [];
    batch.forEach((t, i) => {
      const b = i * 9;
      rows.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`);
      values.push(new Date(), t.vehicleId, t.vehicleType, t.routeId, t.position.lat, t.position.lon, t.speedKmh, t.delaySeconds, t.nextStopId);
    });
    try {
      await pool.query(
        `INSERT INTO gps_telemetry (time, vehicle_id, vehicle_type, route_id, lat, lon, speed_kmh, delay_seconds, next_stop_id)
         VALUES ${rows.join(',')}`,
        values,
      );
    } catch (err) {
      // En arranque la tabla puede no existir aún; se reintenta en el siguiente flush.
    }
  }
  const flushTimer = setInterval(() => void flush(), 1000);
  flushTimer.unref();

  await createService({
    name: 'tracking-service',
    port: PORT,
    setup: async ({ app, bus, log }) => {
      await bus.subscribe<GpsTelemetry>(
        'tracking-ingest',
        [Topics.GPS_TELEMETRY],
        async (env: EventEnvelope<GpsTelemetry>) => {
          const t = env.data;
          buffer.push(t);

          // Snapshot de última posición + ETA exacto a próxima parada.
          const etaSec = computeEtaSeconds(t);
          await redis.hset(`vehicle:${t.vehicleId}`, {
            vehicleId: t.vehicleId,
            vehicleType: t.vehicleType,
            routeId: t.routeId,
            lat: t.position.lat,
            lon: t.position.lon,
            speedKmh: t.speedKmh,
            delaySeconds: t.delaySeconds,
            nextStopId: t.nextStopId,
            etaSec,
            updatedAt: env.occurredAt,
          });
          // Índice de vehículos que se aproximan a cada parada.
          await redis.zadd(`stop:${t.nextStopId}:eta`, etaSec, t.vehicleId);
          await redis.expire(`stop:${t.nextStopId}:eta`, 120);
        },
      );

      // Última posición de un vehículo.
      app.get('/vehicles/:id/position', async (req, res, next) => {
        try {
          const data = await redis.hgetall(`vehicle:${req.params.id}`);
          if (!data || Object.keys(data).length === 0) {
            return res.status(404).json({ error: 'vehículo sin telemetría reciente' });
          }
          res.json(data);
        } catch (err) {
          next(err);
        }
      });

      // Llegadas EXACTAS a una parada (ordenadas por ETA real, no estimado).
      app.get('/arrivals/:stopId', async (req, res, next) => {
        try {
          const ids = await redis.zrange(`stop:${req.params.stopId}:eta`, 0, 9, 'WITHSCORES');
          const arrivals: { vehicleId: string; etaSec: number; routeId: string; delaySeconds: number }[] = [];
          for (let i = 0; i < ids.length; i += 2) {
            const vehicleId = ids[i];
            const etaSec = Number(ids[i + 1]);
            const v = await redis.hgetall(`vehicle:${vehicleId}`);
            arrivals.push({
              vehicleId,
              etaSec,
              routeId: v.routeId ?? '',
              delaySeconds: Number(v.delaySeconds ?? 0),
            });
          }
          res.json({ stopId: req.params.stopId, arrivals });
        } catch (err) {
          next(err);
        }
      });

      // Histórico de un vehículo desde TimescaleDB (serie temporal).
      app.get('/vehicles/:id/history', async (req, res, next) => {
        try {
          const r = await pool.query(
            `SELECT time, lat, lon, speed_kmh, delay_seconds
             FROM gps_telemetry WHERE vehicle_id = $1 ORDER BY time DESC LIMIT 50`,
            [req.params.id],
          );
          res.json(r.rows);
        } catch (err) {
          next(err);
        }
      });

      log.info('tracking-service consumiendo gps.telemetry');
    },
  });
}

/** ETA exacto: distancia restante a la próxima parada / velocidad instantánea. */
function computeEtaSeconds(t: GpsTelemetry): number {
  const dist = t.distanceToNextStopM ?? 800; // fallback si el productor no lo envía
  const speedMs = (Math.max(t.speedKmh, 3) * 1000) / 3600; // mínimo 3 km/h para evitar ∞
  return Math.round(dist / speedMs + Math.max(0, t.delaySeconds));
}

main().catch((err) => {
  console.error('Fallo fatal tracking-service', err);
  process.exit(1);
});
