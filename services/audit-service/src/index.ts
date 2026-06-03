import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { createService, Topics, EventEnvelope, AuditRecord } from '@urbanflow/shared';

const PORT = Number(process.env.PORT ?? 3009);

/** Mapea el topic de origen del evento a la categoría regulatoria. */
function categoryFor(sourceTopic: string): AuditRecord['category'] | null {
  switch (sourceTopic) {
    case Topics.BUS_REROUTE: return 'REROUTE';
    case Topics.TARIFF_CHANGES: return 'TARIFF_CHANGE';
    case Topics.SIGNAL_COMMANDS: return 'SIGNAL_PRIORITY';
    case Topics.PAYMENT_EVENTS: return 'PAYMENT';
    default: return null;
  }
}

/**
 * Serialización canónica: claves ordenadas recursivamente. Necesaria porque
 * PostgreSQL JSONB no preserva el orden de claves; sin esto, el hash calculado
 * al insertar no coincidiría con el recalculado al leer desde JSONB.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

/** Hash encadenado tipo blockchain ligero (tamper-evidence). */
function chainHash(prevHash: string, record: { auditId: string; occurredAt: string; payload: unknown }): string {
  return createHash('sha256')
    .update(prevHash)
    .update(record.auditId)
    .update(record.occurredAt)
    .update(canonical(record.payload))
    .digest('hex');
}

/**
 * audit-service (MVP 4 - inciso b del Contexto Adicional)
 * - Trazabilidad COMPLETA de re-enrutamientos y cambios de tarifa (y prioridad
 *   semafórica / pagos) para la auditoría trimestral del ente regulador.
 * - Consume audit.log (espejo de todos los topics auditables).
 * - Append-only en PostgreSQL con cadena de hashes para detectar manipulación.
 * - Procesamiento serializado para mantener la integridad de la cadena.
 */
async function main() {
  const pool = new Pool({
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    user: process.env.POSTGRES_USER ?? 'urbanflow',
    password: process.env.POSTGRES_PASSWORD ?? 'urbanflow_secret',
    database: process.env.POSTGRES_DB ?? 'urbanflow',
    max: 10,
  });

  // Cola en proceso para serializar el encadenado (evita carreras entre particiones).
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (task: () => Promise<void>) => {
    queue = queue.then(task).catch(() => {});
    return queue;
  };

  async function lastHash(): Promise<string> {
    const r = await pool.query('SELECT hash FROM audit.event_log ORDER BY seq DESC LIMIT 1');
    return r.rowCount ? r.rows[0].hash : 'GENESIS';
  }

  await createService({
    name: 'audit-service',
    port: PORT,
    setup: async ({ app, bus, log }) => {
      await bus.subscribe<unknown>(
        'audit-recorder',
        [Topics.AUDIT_LOG],
        async (env: EventEnvelope<unknown> & { _sourceTopic?: string }) => {
          await enqueue(async () => {
            const sourceTopic = (env as { _sourceTopic?: string })._sourceTopic ?? env.type;
            const category = categoryFor(sourceTopic);
            if (!category) return;

            const prevHash = await lastHash();
            const recordedAt = new Date().toISOString();
            const base = { auditId: env.eventId, occurredAt: env.occurredAt, payload: env.data as Record<string, unknown> };
            const hash = chainHash(prevHash, base);

            await pool.query(
              `INSERT INTO audit.event_log (audit_id, category, correlation_id, actor, prev_hash, hash, occurred_at, recorded_at, payload)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
               ON CONFLICT (audit_id) DO NOTHING`,
              [env.eventId, category, env.correlationId, env.source, prevHash, hash, env.occurredAt, recordedAt, JSON.stringify(env.data)],
            );
            log.debug({ category, correlationId: env.correlationId }, 'registro de auditoría encadenado');
          });
        },
      );

      // Consulta de la pista de auditoría (con filtros para el regulador).
      app.get('/audit', async (req, res, next) => {
        try {
          const { category, correlationId, from, to, limit } = req.query as Record<string, string>;
          const where: string[] = ["category <> 'TARIFF_CHANGE' OR correlation_id <> 'genesis'"];
          const params: unknown[] = [];
          if (category) { params.push(category); where.push(`category = $${params.length}`); }
          if (correlationId) { params.push(correlationId); where.push(`correlation_id = $${params.length}`); }
          if (from) { params.push(from); where.push(`occurred_at >= $${params.length}`); }
          if (to) { params.push(to); where.push(`occurred_at <= $${params.length}`); }
          params.push(Math.min(Number(limit ?? 100), 500));
          const r = await pool.query(
            `SELECT audit_id, category, correlation_id, actor, occurred_at, recorded_at, payload, hash, prev_hash
             FROM audit.event_log WHERE ${where.join(' AND ')}
             ORDER BY recorded_at DESC LIMIT $${params.length}`,
            params,
          );
          res.json(r.rows);
        } catch (err) {
          next(err);
        }
      });

      app.get('/audit/verify', async (_req, res, next) => {
        try {
          const r = await pool.query(
            `SELECT audit_id, occurred_at, payload, prev_hash, hash
             FROM audit.event_log WHERE audit_id <> '00000000-0000-0000-0000-000000000000'
             ORDER BY seq ASC`,
          );
          let prev = 'GENESIS';
          let broken: { auditId: string; expected: string; stored: string } | null = null;
          for (const row of r.rows) {
            const expected = chainHash(prev, { auditId: row.audit_id, occurredAt: new Date(row.occurred_at).toISOString(), payload: row.payload });
            if (row.prev_hash !== prev || row.hash !== expected) {
              broken = { auditId: row.audit_id, expected, stored: row.hash };
              break;
            }
            prev = row.hash;
          }
          res.json({ records: r.rowCount, intact: broken === null, firstBrokenAt: broken });
        } catch (err) {
          next(err);
        }
      });

      app.get('/audit/trace/:correlationId', async (req, res, next) => {
        try {
          const r = await pool.query(
            `SELECT category, actor, occurred_at, payload FROM audit.event_log
             WHERE correlation_id = $1 ORDER BY occurred_at ASC`,
            [req.params.correlationId],
          );
          res.json({ correlationId: req.params.correlationId, events: r.rows });
        } catch (err) {
          next(err);
        }
      });

      app.get('/stats', async (_req, res, next) => {
        try {
          const r = await pool.query('SELECT category, count(*) AS n FROM audit.event_log GROUP BY category');
          res.json(r.rows);
        } catch (err) {
          next(err);
        }
      });

      log.info('audit-service activo (cadena de trazabilidad regulatoria)');
    },
  });
}

main().catch((err) => {
  console.error('Fallo fatal audit-service', err);
  process.exit(1);
});
