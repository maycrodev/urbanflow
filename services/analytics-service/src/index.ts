import { Pool } from 'pg';
import Redis from 'ioredis';
import { createService, Topics, MultimodalRoute, PaymentEvent } from '@urbanflow/shared';

const PORT = Number(process.env.PORT ?? 3008);
// Emisión de referencia de un auto privado (g CO2 por km) para "emisiones evitadas".
const CAR_BASELINE_G_PER_KM = 130;
const PUNCTUALITY_DELAY_THRESHOLD_SEC = 120;

/**
 * analytics-service (MVP 3, inciso VIII)
 * - Panel de KPIs de movilidad en tiempo real para la alcaldía:
 *     flujo por corredor, índice de puntualidad, emisiones evitadas, ocupación.
 * - Lee serie temporal de TimescaleDB y acumula contadores en Redis a partir
 *   del stream de eventos (trip/payment).
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
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

  await createService({
    name: 'analytics-service',
    port: PORT,
    setup: async ({ app, bus, log }) => {
      // Acumular emisiones evitadas y ridership a partir de viajes completados.
      await bus.subscribe<{ action: string; route: MultimodalRoute; citizenId: string }>(
        'analytics-trips',
        [Topics.TRIP_EVENTS],
        async (env) => {
          if (env.data.action !== 'COMPLETED') return;
          const route = env.data.route;
          const distanceKm = route.legs.reduce((s, l) => s + l.distanceM, 0) / 1000;
          const carBaseline = distanceKm * CAR_BASELINE_G_PER_KM;
          const avoided = Math.max(0, carBaseline - route.totalCarbonGrams);
          await redis.incrbyfloat('kpi:emissions_avoided_g', avoided);
          await redis.incr('kpi:trips_total');
          // Ocupación: incrementa pasajeros por corredor de cada tramo de transporte público.
          for (const leg of route.legs) {
            if (leg.lineId && (leg.mode === 'BUS' || leg.mode === 'METRO')) {
              await redis.hincrby('kpi:ridership_by_corridor', leg.lineId, 1);
            }
          }
        },
      );

      // Contador de transacciones liquidadas (para tasa de pago).
      await bus.subscribe<PaymentEvent>('analytics-payments', [Topics.PAYMENT_EVENTS], async (env) => {
        await redis.incr(env.data.status === 'SETTLED' ? 'kpi:payments_settled' : 'kpi:payments_declined');
        await redis.incrbyfloat('kpi:revenue_total', env.data.totalCharged);
      });

      // Flujo por corredor + puntualidad desde la serie temporal (últimos 10 min).
      async function corridorFlow() {
        const r = await pool.query(
          `SELECT route_id,
                  count(*)                                         AS samples,
                  count(DISTINCT vehicle_id)                       AS active_vehicles,
                  round(avg(speed_kmh)::numeric, 1)                AS avg_speed,
                  round(avg(delay_seconds)::numeric, 0)            AS avg_delay,
                  round(100.0 * sum(CASE WHEN delay_seconds <= $1 THEN 1 ELSE 0 END) / count(*), 1) AS punctuality_pct
           FROM gps_telemetry
           WHERE time > now() - interval '10 minutes'
           GROUP BY route_id ORDER BY route_id`,
          [PUNCTUALITY_DELAY_THRESHOLD_SEC],
        );
        return r.rows;
      }

      app.get('/kpis', async (_req, res, next) => {
        try {
          const flow = await corridorFlow().catch(() => []);
          const emissions = Number((await redis.get('kpi:emissions_avoided_g')) ?? 0);
          const trips = Number((await redis.get('kpi:trips_total')) ?? 0);
          const settled = Number((await redis.get('kpi:payments_settled')) ?? 0);
          const declined = Number((await redis.get('kpi:payments_declined')) ?? 0);
          const revenue = Number((await redis.get('kpi:revenue_total')) ?? 0);
          const ridership = await redis.hgetall('kpi:ridership_by_corridor');

          const overallPunctuality = flow.length
            ? round(flow.reduce((s: number, c) => s + Number(c.punctuality_pct), 0) / flow.length)
            : null;
          const totalActive = flow.reduce((s: number, c) => s + Number(c.active_vehicles), 0);
          const avgOccupancy = totalActive
            ? round(Object.values(ridership).reduce((s, v) => s + Number(v), 0) / totalActive)
            : 0;

          res.json({
            generatedAt: new Date().toISOString(),
            kpis: {
              flujo_por_corredor: flow,
              indice_puntualidad_pct: overallPunctuality,
              emisiones_evitadas_kg: round(emissions / 1000),
              ocupacion_promedio_pasajeros: avgOccupancy,
            },
            extras: {
              viajes_totales: trips,
              pagos_liquidados: settled,
              pagos_rechazados: declined,
              recaudacion_total: round(revenue),
              ridership_por_corredor: ridership,
            },
          });
        } catch (err) {
          next(err);
        }
      });

      app.get('/corridors', async (_req, res, next) => {
        try {
          res.json(await corridorFlow());
        } catch (err) {
          next(err);
        }
      });

      log.info('analytics-service activo');
    },
  });
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

main().catch((err) => {
  console.error('Fallo fatal analytics-service', err);
  process.exit(1);
});
