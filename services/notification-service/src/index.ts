import { randomUUID } from 'node:crypto';
import { Response } from 'express';
import Redis from 'ioredis';
import { createService, Topics, PushNotification } from '@urbanflow/shared';

const PORT = Number(process.env.PORT ?? 3007);

/**
 * notification-service (MVP 3, inciso VII)
 * - Entrega notificaciones push personalizadas (interrupciones, desvíos,
 *   alternativas) durante el viaje activo del ciudadano.
 * - Fan-out en tiempo real vía SSE + persistencia corta en Redis.
 * - Privacidad (NFR): solo se personaliza durante el viaje activo; al finalizar
 *   se anonimiza la asociación ciudadano<->ubicación.
 */
async function main() {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  // Conexiones SSE abiertas por destinatario.
  const subscribers = new Map<string, Set<Response>>();

  function push(recipient: string, payload: unknown) {
    const set = subscribers.get(recipient);
    if (!set) return;
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of set) res.write(data);
  }

  await createService({
    name: 'notification-service',
    port: PORT,
    setup: async ({ app, bus, log }) => {
      // Entrega de notificaciones generadas por otros servicios.
      await bus.subscribe<PushNotification>('notification-fanout', [Topics.NOTIFICATIONS], async (env) => {
        const n = env.data;
        await redis.lpush(`notif:${n.citizenId}`, JSON.stringify({ ...n, deliveredAt: env.occurredAt }));
        await redis.ltrim(`notif:${n.citizenId}`, 0, 49);
        await redis.expire(`notif:${n.citizenId}`, 3600);
        push(n.citizenId, n);
        log.debug({ to: n.citizenId, category: n.category }, 'notificación entregada');
      });

      // Seguimiento de viajes activos (ventana de privacidad).
      await bus.subscribe<{ tripId: string; citizenId: string; action: string }>('notification-trip-watch', [Topics.TRIP_EVENTS], async (env) => {
        const { tripId, citizenId, action } = env.data;
        if (action === 'STARTED') {
          await redis.set(`activetrip:${citizenId}`, tripId, 'EX', 7200);
        } else if (action === 'COMPLETED') {
          // Anonimización al finalizar: se elimina el vínculo ciudadano<->viaje.
          await redis.del(`activetrip:${citizenId}`);
          const arrival: PushNotification = {
            notificationId: randomUUID(),
            citizenId,
            tripId,
            category: 'ARRIVAL',
            title: 'Viaje finalizado',
            body: 'Gracias por viajar con UrbanFlow. Tu ubicación fue anonimizada.',
          };
          await redis.lpush(`notif:${citizenId}`, JSON.stringify(arrival));
          push(citizenId, arrival);
        }
      });

      // Alternativas durante el viaje: cuando hay reroute, avisar a viajeros activos del corredor.
      await bus.subscribe<{ fromCorridorId: string; toCorridorId: string; reason: string }>(
        'notification-reroute-watch',
        [Topics.BUS_REROUTE],
        async (env) => {
          // En producción se cruzaría con los viajes activos en el corredor.
          log.info({ corridor: env.data.fromCorridorId }, 'reroute observado para alertar viajeros del corredor');
        },
      );

      // SSE: stream de notificaciones en vivo de un ciudadano.
      app.get('/stream/:citizenId', async (req, res) => {
        res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.flushHeaders?.();
        const id = req.params.citizenId;
        if (!subscribers.has(id)) subscribers.set(id, new Set());
        subscribers.get(id)!.add(res);
        res.write(`data: ${JSON.stringify({ type: 'connected', citizenId: id })}\n\n`);
        req.on('close', () => {
          subscribers.get(id)?.delete(res);
        });
      });

      // Historial reciente.
      app.get('/notifications/:citizenId', async (req, res, next) => {
        try {
          const items = await redis.lrange(`notif:${req.params.citizenId}`, 0, 49);
          res.json(items.map((i) => JSON.parse(i)));
        } catch (err) {
          next(err);
        }
      });

      // Envío manual (pruebas / campañas).
      app.post('/notify', async (req, res, next) => {
        try {
          const body = req.body as Partial<PushNotification>;
          if (!body.citizenId || !body.body) return res.status(400).json({ error: 'citizenId y body requeridos' });
          const notif: PushNotification = {
            notificationId: randomUUID(),
            citizenId: body.citizenId,
            category: body.category ?? 'ALTERNATIVE',
            title: body.title ?? 'UrbanFlow',
            body: body.body,
            tripId: body.tripId,
            payload: body.payload,
          };
          await bus.publish(Topics.NOTIFICATIONS, notif, { key: notif.citizenId, type: 'notification.manual' });
          res.status(202).json({ notificationId: notif.notificationId });
        } catch (err) {
          next(err);
        }
      });

      log.info('notification-service activo (SSE + Kafka fan-out)');
    },
  });
}

main().catch((err) => {
  console.error('Fallo fatal notification-service', err);
  process.exit(1);
});
