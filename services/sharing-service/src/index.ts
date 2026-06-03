import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { createService, Topics, SharingEvent } from '@urbanflow/shared';

const PORT = Number(process.env.PORT ?? 3005);
const RESERVATION_TTL_MIN = 10;

/**
 * sharing-service (MVP 2, inciso V)
 * - Gestiona disponibilidad, reservas, desbloqueo remoto y reportes de daños
 *   de scooters y bicicletas compartidas, en tiempo real.
 * - Persistencia relacional en PostgreSQL + cache de disponibilidad en Redis.
 * - Publica sharing.events para analítica y notificaciones.
 */
async function main() {
  const pool = new Pool({
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    user: process.env.POSTGRES_USER ?? 'urbanflow',
    password: process.env.POSTGRES_PASSWORD ?? 'urbanflow_secret',
    database: process.env.POSTGRES_DB ?? 'urbanflow',
    max: 20,
  });
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

  await createService({
    name: 'sharing-service',
    port: PORT,
    setup: async ({ app, bus, log }) => {
      const emit = (data: SharingEvent, correlationId: string) =>
        bus.publish(Topics.SHARING_EVENTS, data, { key: data.vehicleId, correlationId, type: `sharing.${data.action.toLowerCase()}` });

      // Disponibilidad por estación/tipo.
      app.get('/vehicles', async (req, res, next) => {
        try {
          const { station, type, status } = req.query as Record<string, string>;
          const where: string[] = [];
          const params: unknown[] = [];
          if (station) { params.push(station); where.push(`station_id = $${params.length}`); }
          if (type) { params.push(type); where.push(`type = $${params.length}`); }
          where.push(`status = $${params.push(status ?? 'AVAILABLE')}`);
          const r = await pool.query(
            `SELECT vehicle_id, type, status, station_id, lat, lon, battery_pct FROM sharing.vehicle
             ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY battery_pct DESC`,
            params,
          );
          res.json(r.rows);
        } catch (err) {
          next(err);
        }
      });

      // Reservar un vehículo (transición AVAILABLE -> RESERVED).
      app.post('/reservations', async (req, res, next) => {
        const client = await pool.connect();
        try {
          const { citizenId, vehicleId } = req.body ?? {};
          if (!citizenId || !vehicleId) return res.status(400).json({ error: 'citizenId y vehicleId requeridos' });
          await client.query('BEGIN');
          const v = await client.query('SELECT status, type, station_id FROM sharing.vehicle WHERE vehicle_id=$1 FOR UPDATE', [vehicleId]);
          if (!v.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'vehículo no existe' }); }
          if (v.rows[0].status !== 'AVAILABLE') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'vehículo no disponible' }); }

          const reservationId = randomUUID();
          const expires = new Date(Date.now() + RESERVATION_TTL_MIN * 60_000);
          await client.query('UPDATE sharing.vehicle SET status=$1, updated_at=now() WHERE vehicle_id=$2', ['RESERVED', vehicleId]);
          await client.query(
            'INSERT INTO sharing.reservation (reservation_id, vehicle_id, citizen_id, status, expires_at) VALUES ($1,$2,$3,$4,$5)',
            [reservationId, vehicleId, citizenId, 'ACTIVE', expires],
          );
          await client.query('COMMIT');
          await redis.srem(`station:${v.rows[0].station_id}:available`, vehicleId);
          await emit({ vehicleId, type: v.rows[0].type, action: 'RESERVED', citizenId, stationId: v.rows[0].station_id }, reservationId);
          log.info({ reservationId, vehicleId, citizenId }, 'Reserva creada');
          res.status(201).json({ reservationId, vehicleId, status: 'RESERVED', expiresAt: expires.toISOString() });
        } catch (err) {
          await client.query('ROLLBACK');
          next(err);
        } finally {
          client.release();
        }
      });

      // Desbloqueo remoto (RESERVED -> IN_USE).
      app.post('/reservations/:id/unlock', async (req, res, next) => {
        try {
          const r = await pool.query('SELECT vehicle_id, citizen_id, status FROM sharing.reservation WHERE reservation_id=$1', [req.params.id]);
          if (!r.rowCount) return res.status(404).json({ error: 'reserva no encontrada' });
          if (r.rows[0].status !== 'ACTIVE') return res.status(409).json({ error: 'reserva no activa' });
          const vehicleId = r.rows[0].vehicle_id;
          await pool.query('UPDATE sharing.reservation SET status=$1 WHERE reservation_id=$2', ['UNLOCKED', req.params.id]);
          await pool.query('UPDATE sharing.vehicle SET status=$1, updated_at=now() WHERE vehicle_id=$2', ['IN_USE', vehicleId]);
          const v = await pool.query('SELECT type FROM sharing.vehicle WHERE vehicle_id=$1', [vehicleId]);
          await emit({ vehicleId, type: v.rows[0].type, action: 'UNLOCKED', citizenId: r.rows[0].citizen_id }, req.params.id);
          log.info({ reservationId: req.params.id, vehicleId }, 'Desbloqueo remoto ejecutado');
          res.json({ reservationId: req.params.id, vehicleId, status: 'UNLOCKED' });
        } catch (err) {
          next(err);
        }
      });

      // Fin del viaje (IN_USE -> AVAILABLE) en una estación destino.
      app.post('/reservations/:id/end', async (req, res, next) => {
        try {
          const { stationId, lat, lon } = req.body ?? {};
          const r = await pool.query('SELECT vehicle_id FROM sharing.reservation WHERE reservation_id=$1', [req.params.id]);
          if (!r.rowCount) return res.status(404).json({ error: 'reserva no encontrada' });
          const vehicleId = r.rows[0].vehicle_id;
          await pool.query('UPDATE sharing.reservation SET status=$1, ended_at=now() WHERE reservation_id=$2', ['COMPLETED', req.params.id]);
          await pool.query(
            'UPDATE sharing.vehicle SET status=$1, station_id=COALESCE($2, station_id), lat=COALESCE($3,lat), lon=COALESCE($4,lon), updated_at=now() WHERE vehicle_id=$5',
            ['AVAILABLE', stationId ?? null, lat ?? null, lon ?? null, vehicleId],
          );
          const v = await pool.query('SELECT type, station_id FROM sharing.vehicle WHERE vehicle_id=$1', [vehicleId]);
          if (v.rows[0].station_id) await redis.sadd(`station:${v.rows[0].station_id}:available`, vehicleId);
          await emit({ vehicleId, type: v.rows[0].type, action: 'TRIP_ENDED', stationId: v.rows[0].station_id }, req.params.id);
          res.json({ reservationId: req.params.id, vehicleId, status: 'COMPLETED' });
        } catch (err) {
          next(err);
        }
      });

      // Reporte de daño (-> MAINTENANCE/DAMAGED, sale de disponibilidad).
      app.post('/vehicles/:id/damage', async (req, res, next) => {
        try {
          const { note, citizenId } = req.body ?? {};
          if (!note) return res.status(400).json({ error: 'note requerido' });
          const v = await pool.query('SELECT type, station_id FROM sharing.vehicle WHERE vehicle_id=$1', [req.params.id]);
          if (!v.rowCount) return res.status(404).json({ error: 'vehículo no existe' });
          const reportId = randomUUID();
          await pool.query('INSERT INTO sharing.damage_report (report_id, vehicle_id, citizen_id, note) VALUES ($1,$2,$3,$4)', [reportId, req.params.id, citizenId ?? null, note]);
          await pool.query('UPDATE sharing.vehicle SET status=$1, updated_at=now() WHERE vehicle_id=$2', ['DAMAGED', req.params.id]);
          if (v.rows[0].station_id) await redis.srem(`station:${v.rows[0].station_id}:available`, req.params.id);
          await emit({ vehicleId: req.params.id, type: v.rows[0].type, action: 'DAMAGE_REPORTED', citizenId, damageNote: note }, reportId);
          log.warn({ vehicleId: req.params.id, reportId }, 'Daño reportado');
          res.status(201).json({ reportId, vehicleId: req.params.id, status: 'DAMAGED' });
        } catch (err) {
          next(err);
        }
      });

      // Liberación de reservas vencidas (housekeeping cada 30s).
      const sweeper = setInterval(async () => {
        try {
          const exp = await pool.query(
            `UPDATE sharing.reservation SET status='CANCELLED'
             WHERE status='ACTIVE' AND expires_at < now() RETURNING vehicle_id`,
          );
          for (const row of exp.rows) {
            await pool.query("UPDATE sharing.vehicle SET status='AVAILABLE' WHERE vehicle_id=$1 AND status='RESERVED'", [row.vehicle_id]);
          }
          if (exp.rowCount) log.info({ liberadas: exp.rowCount }, 'Reservas vencidas liberadas');
        } catch (err) {
          log.error({ err }, 'error en sweeper de reservas');
        }
      }, 30_000);
      sweeper.unref();

      log.info('sharing-service activo');
    },
  });
}

main().catch((err) => {
  console.error('Fallo fatal sharing-service', err);
  process.exit(1);
});
