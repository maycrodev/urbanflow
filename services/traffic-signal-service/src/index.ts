import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { createService, Topics, GpsTelemetry, SignalCommand, SignalStatus } from '@urbanflow/shared';
import { encodeNtcip, decodeNtcip, NTCIP_MAX_BYTES } from './ntcip';

const PORT = Number(process.env.PORT ?? 3004);
const DELAY_THRESHOLD_SEC = 300; // 5 minutos (inciso IV)
const EMULATE_CONTROLLERS = (process.env.EMULATE_CONTROLLERS ?? 'true') === 'true';

/** Mapeo determinístico parada->intersección (en producción vendría del GIS). */
function intersectionForStop(stopId: string): string {
  return `INT-${stopId.replace('ST-', '').replace('M-', 'M')}`;
}
function approachFromBearing(bearing: number): SignalCommand['approach'] {
  const b = ((bearing % 360) + 360) % 360;
  if (b >= 315 || b < 45) return 'N';
  if (b < 135) return 'E';
  if (b < 225) return 'S';
  return 'W';
}

/**
 * traffic-signal-service (MVP 2, inciso IV)
 * - Da prioridad a buses con retraso > 5 min o vehículos de emergencia.
 * - Integra el sistema legado por NTCIP (mensajes <= 256 bytes, bidireccional).
 * - signal.commands es AUDITABLE (cada priorización queda trazada - MVP 4).
 */
async function main() {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

  await createService({
    name: 'traffic-signal-service',
    port: PORT,
    setup: async ({ app, bus, log }) => {
      async function requestPriority(cmd: SignalCommand, correlationId: string) {
        const frame = encodeNtcip(cmd); // valida límite de 256 bytes
        const env = await bus.publish(Topics.SIGNAL_COMMANDS, cmd, { key: cmd.intersectionId, correlationId, type: 'signal.priority.request' });
        await redis.hset(`intersection:${cmd.intersectionId}`, {
          lastCommandId: env.eventId,
          priorityFor: cmd.priorityFor,
          vehicleId: cmd.vehicleId,
          ntcipBytes: frame.length,
          ntcipHex: frame.toString('hex'),
          at: env.occurredAt,
        });
        log.info({ intersection: cmd.intersectionId, bytes: frame.length, max: NTCIP_MAX_BYTES, priorityFor: cmd.priorityFor }, 'Comando NTCIP enviado');
        return env;
      }

      // 1) Detección automática: bus retrasado > 5 min => prioridad semafórica.
      await bus.subscribe<GpsTelemetry>('signal-delay-detector', [Topics.GPS_TELEMETRY], async (env) => {
        const t = env.data;
        if (t.vehicleType !== 'BUS' || t.delaySeconds <= DELAY_THRESHOLD_SEC) return;
        const intersectionId = intersectionForStop(t.nextStopId);
        // Throttle: 1 petición por (bus,intersección) cada 60s.
        const throttleKey = `prio:${t.vehicleId}:${intersectionId}`;
        const set = await redis.set(throttleKey, '1', 'EX', 60, 'NX');
        if (set !== 'OK') return;

        await requestPriority(
          {
            intersectionId,
            priorityFor: 'DELAYED_BUS',
            vehicleId: t.vehicleId,
            approach: approachFromBearing(t.bearing),
            greenExtensionSec: Math.min(20, Math.round(t.delaySeconds / 60) * 3),
            reason: `Bus ${t.vehicleId} con retraso de ${Math.round(t.delaySeconds / 60)} min`,
          },
          env.correlationId,
        );
      });

      // 2) Emulador del controlador legado: responde con ACK (canal bidireccional).
      if (EMULATE_CONTROLLERS) {
        await bus.subscribe<SignalCommand>('signal-controller-emulator', [Topics.SIGNAL_COMMANDS], async (env) => {
          const cmd = env.data;
          const status: SignalStatus = {
            intersectionId: cmd.intersectionId,
            phase: 'GREEN',
            approach: cmd.approach,
            ackCommandId: env.eventId,
            healthy: true,
          };
          await bus.publish(Topics.SIGNAL_STATUS, status, { key: cmd.intersectionId, correlationId: env.correlationId, type: 'signal.status.ack' });
        });
      }

      // 3) Estado reportado por los semáforos (entrante, bidireccional).
      await bus.subscribe<SignalStatus>('signal-status-collector', [Topics.SIGNAL_STATUS], async (env) => {
        const s = env.data;
        await redis.hset(`intersection:${s.intersectionId}:status`, {
          phase: s.phase,
          approach: s.approach,
          healthy: String(s.healthy),
          ackCommandId: s.ackCommandId ?? '',
          at: env.occurredAt,
        });
      });

      // Endpoint para vehículos de emergencia (prioridad inmediata).
      app.post('/emergency', async (req, res, next) => {
        try {
          const { vehicleId, intersectionId, approach } = req.body ?? {};
          if (!vehicleId || !intersectionId) {
            return res.status(400).json({ error: 'vehicleId e intersectionId requeridos' });
          }
          const cmd: SignalCommand = {
            intersectionId,
            priorityFor: 'EMERGENCY_VEHICLE',
            vehicleId,
            approach: approach ?? 'N',
            greenExtensionSec: 30,
            reason: 'Vehículo de emergencia detectado',
          };
          const env = await requestPriority(cmd, randomUUID());
          res.status(202).json({ commandId: env.eventId, status: 'PRIORITY_REQUESTED' });
        } catch (err) {
          next(err);
        }
      });

      app.get('/intersections/:id', async (req, res, next) => {
        try {
          const cmd = await redis.hgetall(`intersection:${req.params.id}`);
          const status = await redis.hgetall(`intersection:${req.params.id}:status`);
          res.json({ intersectionId: req.params.id, lastCommand: cmd, status });
        } catch (err) {
          next(err);
        }
      });

      // Decodifica una trama NTCIP (utilidad de depuración).
      app.post('/ntcip/decode', (req, res) => {
        try {
          const frame = Buffer.from(String(req.body?.hex ?? ''), 'hex');
          res.json({ bytes: frame.length, decoded: decodeNtcip(frame) });
        } catch (err) {
          res.status(400).json({ error: String(err) });
        }
      });

      log.info({ threshold: DELAY_THRESHOLD_SEC, emulateControllers: EMULATE_CONTROLLERS }, 'traffic-signal-service activo');
    },
  });
}

main().catch((err) => {
  console.error('Fallo fatal traffic-signal-service', err);
  process.exit(1);
});
