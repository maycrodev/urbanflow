import { EventBus, Topics, GpsTelemetry, MultimodalRoute } from '@urbanflow/shared';

/**
 * simulator
 * Genera tráfico realista para demostrar el sistema end-to-end:
 *  - Telemetría GPS de buses y metros (gps.telemetry).
 *  - Escenario de congestión en el corredor B-202 (dispara predicción + reroute).
 *  - Buses con retraso > 5 min (dispara prioridad semafórica NTCIP).
 *  - Viajes de ciudadanos completados (dispara pago + analítica + notificación).
 */
const BUS_ROUTES = ['B-101', 'B-202', 'B-303', 'B-404'];
const METRO_ROUTE = 'L-ROJA';
const STOPS_BY_ROUTE: Record<string, string[]> = {
  'B-101': ['ST-CENTRO', 'ST-NORTE'],
  'B-202': ['ST-CENTRO', 'ST-SUR'],
  'B-303': ['ST-CENTRO', 'ST-ESTE'],
  'B-404': ['ST-CENTRO', 'ST-OESTE'],
  'L-ROJA': ['ST-CENTRO', 'M-1', 'M-2', 'ST-NORTE'],
};
const CONGESTED_ROUTE = 'B-202'; // se irá frenando para generar congestión

const CITIZENS = ['citizen-001', 'citizen-002', 'citizen-003'];
const SAMPLE_ROUTE: MultimodalRoute = {
  routeOptionId: 'greenest-1',
  optimizedFor: 'GREENEST',
  legs: [
    { mode: 'METRO', fromStopId: 'ST-CENTRO', toStopId: 'M-1', lineId: 'L-ROJA', durationMin: 6, cost: 3, carbonGrams: 35, distanceM: 2500 },
    { mode: 'BUS', fromStopId: 'M-1', toStopId: 'ST-NORTE', lineId: 'B-101', durationMin: 12, cost: 1.25, carbonGrams: 217, distanceM: 3200 },
    { mode: 'WALK', fromStopId: 'ST-NORTE', toStopId: 'ST-NORTE', lineId: 'walk', durationMin: 4, cost: 0, carbonGrams: 0, distanceM: 300 },
  ],
  totalDurationMin: 22,
  totalCost: 4.25,
  totalCarbonGrams: 252,
  totalDistanceM: 6000,
} as MultimodalRoute & { totalDistanceM: number };

interface Vehicle {
  id: string;
  type: 'BUS' | 'METRO';
  routeId: string;
  lat: number;
  lon: number;
  bearing: number;
  speedKmh: number;
  delaySeconds: number;
  stopIdx: number;
  distanceToNextStopM: number;
  delayed: boolean; // acumula retraso para prioridad semafórica
}

function buildFleet(n: number): Vehicle[] {
  const fleet: Vehicle[] = [];
  for (let i = 0; i < n; i++) {
    const isMetro = i % 5 === 0;
    const routeId = isMetro ? METRO_ROUTE : BUS_ROUTES[i % BUS_ROUTES.length];
    fleet.push({
      id: isMetro ? `METRO-${String(i).padStart(3, '0')}` : `BUS-${String(i).padStart(3, '0')}`,
      type: isMetro ? 'METRO' : 'BUS',
      routeId,
      lat: -16.5 + (i % 7) * 0.002,
      lon: -68.15 + (i % 5) * 0.002,
      bearing: (i * 37) % 360,
      speedKmh: 30,
      delaySeconds: 0,
      stopIdx: 0,
      distanceToNextStopM: 600 + (i % 5) * 100,
      delayed: !isMetro && i % 9 === 0, // ~1 de cada 9 buses se atrasa
    });
  }
  return fleet;
}

async function main() {
  const n = Number(process.env.SIM_VEHICLES ?? 40);
  const intervalMs = Number(process.env.SIM_INTERVAL_MS ?? 1000);
  const bus = new EventBus({ service: 'simulator' });
  await bus.connect();
  const fleet = buildFleet(n);
  bus.log.info({ vehicles: n, intervalMs }, 'simulator iniciado');

  let tick = 0;
  setInterval(() => {
    tick++;
    const congestionFactor = Math.max(0.2, 1 - tick / 60); // B-202 se frena con el tiempo

    for (const v of fleet) {
      // Velocidad: metro estable; buses con ruido; corredor congestionado se frena.
      let speed = v.type === 'METRO' ? 38 : 26 + Math.sin(tick / 5 + v.lat) * 6;
      if (v.routeId === CONGESTED_ROUTE && v.type === 'BUS') speed *= congestionFactor;
      v.speedKmh = Math.max(3, Math.round(speed));

      // Retraso: los marcados acumulan hasta superar 5 min (300 s).
      if (v.delayed) v.delaySeconds = Math.min(600, v.delaySeconds + 12);
      else v.delaySeconds = Math.max(-30, Math.round(Math.sin(tick / 7) * 20));
      if (v.routeId === CONGESTED_ROUTE) v.delaySeconds += Math.round((1 - congestionFactor) * 200);

      // Avance hacia la próxima parada.
      const stops = STOPS_BY_ROUTE[v.routeId];
      const stepM = (v.speedKmh * 1000 / 3600) * (intervalMs / 1000);
      v.distanceToNextStopM -= stepM;
      if (v.distanceToNextStopM <= 0) {
        v.stopIdx = (v.stopIdx + 1) % stops.length;
        v.distanceToNextStopM = 600 + Math.random() * 400;
      }
      v.lat += Math.cos((v.bearing * Math.PI) / 180) * 0.0001;
      v.lon += Math.sin((v.bearing * Math.PI) / 180) * 0.0001;

      const telemetry: GpsTelemetry = {
        vehicleId: v.id,
        vehicleType: v.type,
        routeId: v.routeId,
        position: { lat: round(v.lat), lon: round(v.lon) },
        speedKmh: v.speedKmh,
        bearing: v.bearing,
        delaySeconds: v.delaySeconds,
        nextStopId: stops[v.stopIdx],
        distanceToNextStopM: Math.round(v.distanceToNextStopM),
      };
      void bus.publish(Topics.GPS_TELEMETRY, telemetry, { key: v.id, type: 'gps.telemetry' });
    }

    // Cada ~8 s, un ciudadano completa un viaje (pago + analítica + notificación).
    if (tick % Math.max(1, Math.round(8000 / intervalMs)) === 0) {
      const citizenId = CITIZENS[tick % CITIZENS.length];
      const tripId = `sim-trip-${tick}`;
      void bus.publish(Topics.TRIP_EVENTS, { tripId, citizenId, action: 'STARTED', route: SAMPLE_ROUTE }, { key: tripId, correlationId: tripId, type: 'trip.started' });
      void bus.publish(Topics.TRIP_EVENTS, { tripId, citizenId, action: 'COMPLETED', route: SAMPLE_ROUTE, method: 'NFC_CARD' }, { key: tripId, correlationId: tripId, type: 'trip.completed' });
    }

    if (tick % 30 === 0) bus.log.info({ tick, congestionFactor: round(congestionFactor) }, 'simulación en curso');
  }, intervalMs);
}

function round(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}

main().catch((err) => {
  console.error('Fallo fatal simulator', err);
  process.exit(1);
});
