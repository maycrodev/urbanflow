import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createService, Topics, EventEnvelope, MultimodalRoute, PaymentEvent } from '@urbanflow/shared';
import { computeFare, TariffRules } from './fare';

const PORT = Number(process.env.PORT ?? 3003);

/**
 * payment-service (MVP 1, inciso III)
 * - Sistema de pago unificado (NFC / app móvil / QR).
 * - Descuenta automáticamente el costo según la combinación de modos del viaje.
 * - Aplica versionado de tarifa; cada cambio de tarifa es AUDITABLE (MVP 4).
 * - Persistencia relacional/ACID en PostgreSQL (polyglot persistence).
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

  async function currentTariff(): Promise<TariffRules> {
    const r = await pool.query(
      `SELECT version, base_fares, transfer_rules FROM payment.tariff_version
       ORDER BY effective_from DESC LIMIT 1`,
    );
    const row = r.rows[0];
    return { version: row.version, baseFares: row.base_fares, transferRules: row.transfer_rules };
  }

  await createService({
    name: 'payment-service',
    port: PORT,
    setup: async ({ app, bus, log }) => {
      // Cobro automático al completar un viaje.
      await bus.subscribe<{ tripId: string; citizenId: string; action: string; route: MultimodalRoute; method?: string }>(
        'payment-charger',
        [Topics.TRIP_EVENTS],
        async (env) => {
          if (env.data.action !== 'COMPLETED') return;
          const { tripId, citizenId, route, method } = env.data;
          const tariff = await currentTariff();
          const fare = computeFare(route, tariff);

          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            const acc = await client.query('SELECT balance FROM payment.account WHERE citizen_id=$1 FOR UPDATE', [citizenId]);
            const status: PaymentEvent['status'] =
              acc.rowCount && Number(acc.rows[0].balance) >= fare.total ? 'SETTLED' : 'DECLINED';

            const paymentId = randomUUID();
            if (status === 'SETTLED') {
              await client.query('UPDATE payment.account SET balance = balance - $1, updated_at=now() WHERE citizen_id=$2', [fare.total, citizenId]);
            }
            await client.query(
              `INSERT INTO payment.transaction (payment_id, citizen_id, trip_id, method, legs, total_charged, tariff_version, status)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [paymentId, citizenId, tripId, method ?? 'MOBILE_APP', JSON.stringify(fare.legs), fare.total, tariff.version, status],
            );
            await client.query('COMMIT');

            const payload: PaymentEvent = {
              paymentId,
              citizenId,
              tripId,
              method: (method as PaymentEvent['method']) ?? 'MOBILE_APP',
              legs: fare.legs,
              totalCharged: fare.total,
              appliedTariffVersion: tariff.version,
              status,
            };
            // payment.events es AUDITABLE -> el EventBus lo replica a audit.log.
            await bus.publish(Topics.PAYMENT_EVENTS, payload, { key: tripId, correlationId: tripId, type: 'payment.settled' });
            log.info({ tripId, total: fare.total, status }, 'Cobro procesado');
          } catch (err) {
            await client.query('ROLLBACK');
            log.error({ err, tripId }, 'Error en cobro');
          } finally {
            client.release();
          }
        },
      );

      app.get('/accounts/:id', async (req, res, next) => {
        try {
          const r = await pool.query('SELECT citizen_id, display_name, balance FROM payment.account WHERE citizen_id=$1', [req.params.id]);
          if (!r.rowCount) return res.status(404).json({ error: 'cuenta no encontrada' });
          res.json(r.rows[0]);
        } catch (err) {
          next(err);
        }
      });

      app.get('/transactions/:tripId', async (req, res, next) => {
        try {
          const r = await pool.query('SELECT * FROM payment.transaction WHERE trip_id=$1', [req.params.tripId]);
          res.json(r.rows);
        } catch (err) {
          next(err);
        }
      });

      // Cobro directo (NFC/QR en torniquete) sin pasar por trip completo.
      app.post('/charge', async (req, res, next) => {
        try {
          const { citizenId, tripId, route, method } = req.body as { citizenId: string; tripId?: string; route: MultimodalRoute; method?: string };
          const tariff = await currentTariff();
          const fare = computeFare(route, tariff);
          const tid = tripId ?? randomUUID();
          await bus.publish(Topics.TRIP_EVENTS, { tripId: tid, citizenId, action: 'COMPLETED', route, method }, { key: tid, correlationId: tid, type: 'trip.completed' });
          res.status(202).json({ tripId: tid, estimatedFare: fare });
        } catch (err) {
          next(err);
        }
      });

      // Cambio de tarifa -> AUDITABLE (trazabilidad regulatoria MVP 4).
      app.post('/tariff', async (req, res, next) => {
        try {
          const { version, baseFares, transferRules, actor } = req.body;
          if (!version || !baseFares || !transferRules) {
            return res.status(400).json({ error: 'version, baseFares y transferRules requeridos' });
          }
          await pool.query(
            `INSERT INTO payment.tariff_version (version, effective_from, base_fares, transfer_rules, created_by)
             VALUES ($1, now(), $2, $3, $4)`,
            [version, JSON.stringify(baseFares), JSON.stringify(transferRules), actor ?? 'operator'],
          );
          const prev = await currentTariff();
          await bus.publish(
            Topics.TARIFF_CHANGES,
            { version, baseFares, transferRules, actor: actor ?? 'operator', previousVersion: prev.version },
            { key: version, type: 'tariff.changed' },
          );
          log.warn({ version }, 'Cambio de tarifa publicado (auditable)');
          res.status(201).json({ version, status: 'ACTIVE' });
        } catch (err) {
          next(err);
        }
      });
    },
  });
}

main().catch((err) => {
  console.error('Fallo fatal payment-service', err);
  process.exit(1);
});
