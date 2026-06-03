import { randomUUID } from 'node:crypto';
import { createService, Topics, MultimodalRoute } from '@urbanflow/shared';
import { RouteGraph } from './graph';

const PORT = Number(process.env.PORT ?? 3001);

/**
 * route-planning-service (MVP 1, inciso I)
 * - Planifica rutas multimodales (bus+metro+scooter+caminata) con tiempo,
 *   costo y huella de carbono, usando un grafo en Neo4j (polyglot persistence).
 * - Gestiona el ciclo de vida del viaje y emite trip.events (consumido por pago).
 */
async function main() {
  const graph = new RouteGraph();

  await createService({
    name: 'route-planning-service',
    port: PORT,
    setup: async ({ app, bus, log }) => {
      // Reintenta el seed hasta que Neo4j esté listo.
      await retry(() => graph.seed(), 10, 3000, log);
      log.info('Grafo de transporte listo en Neo4j');

      app.get('/stops', async (_req, res, next) => {
        try {
          res.json(await graph.listStops());
        } catch (err) {
          next(err);
        }
      });

      // Planificación de rutas óptimas multimodales.
      app.post('/plan', async (req, res, next) => {
        try {
          const { fromStopId, toStopId } = req.body ?? {};
          if (!fromStopId || !toStopId) {
            return res.status(400).json({ error: 'fromStopId y toStopId son requeridos' });
          }
          const options = await graph.plan(fromStopId, toStopId);
          if (!options.length) {
            return res.status(404).json({ error: 'No se encontró ruta entre las paradas' });
          }
          res.json({ fromStopId, toStopId, options });
        } catch (err) {
          next(err);
        }
      });

      // Inicia un viaje a partir de una opción de ruta elegida.
      app.post('/trips', async (req, res, next) => {
        try {
          const { citizenId, route } = req.body as { citizenId: string; route: MultimodalRoute };
          if (!citizenId || !route?.legs?.length) {
            return res.status(400).json({ error: 'citizenId y route (con legs) son requeridos' });
          }
          const tripId = randomUUID();
          const correlationId = tripId;
          await bus.publish(
            Topics.TRIP_EVENTS,
            { tripId, citizenId, action: 'STARTED', route },
            { key: tripId, correlationId, type: 'trip.started' },
          );
          log.info({ tripId, citizenId }, 'Viaje iniciado');
          res.status(201).json({ tripId, status: 'STARTED', correlationId });
        } catch (err) {
          next(err);
        }
      });

      // Finaliza el viaje -> dispara el cobro (payment-service consume este evento).
      app.post('/trips/:tripId/complete', async (req, res, next) => {
        try {
          const { tripId } = req.params;
          const { citizenId, route, method } = req.body as {
            citizenId: string;
            route: MultimodalRoute;
            method?: string;
          };
          if (!citizenId || !route?.legs?.length) {
            return res.status(400).json({ error: 'citizenId y route son requeridos' });
          }
          await bus.publish(
            Topics.TRIP_EVENTS,
            { tripId, citizenId, action: 'COMPLETED', route, method: method ?? 'MOBILE_APP' },
            { key: tripId, correlationId: tripId, type: 'trip.completed' },
          );
          log.info({ tripId }, 'Viaje completado -> cobro disparado');
          res.json({ tripId, status: 'COMPLETED' });
        } catch (err) {
          next(err);
        }
      });
    },
  });
}

async function retry(fn: () => Promise<void>, attempts: number, delayMs: number, log: { warn: (o: unknown, m: string) => void }) {
  for (let i = 0; i < attempts; i++) {
    try {
      await fn();
      return;
    } catch (err) {
      log.warn({ err: String(err), attempt: i + 1 }, 'reintentando dependencia...');
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('No se pudo inicializar la dependencia tras varios intentos');
}

main().catch((err) => {
  console.error('Fallo fatal route-planning-service', err);
  process.exit(1);
});
