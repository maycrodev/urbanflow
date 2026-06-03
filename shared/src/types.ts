/**
 * Tipos de dominio y contratos de eventos (event schemas) compartidos.
 * Cada evento lleva metadata estándar para trazabilidad de extremo a extremo.
 */

export type TransportMode = 'BUS' | 'METRO' | 'SCOOTER' | 'BIKE' | 'WALK' | 'CARPOOL';

export interface GeoPoint {
  lat: number;
  lon: number;
}

/** Sobre estándar de todo evento publicado en Kafka. */
export interface EventEnvelope<T> {
  /** UUID del evento. */
  eventId: string;
  /** Tipo de evento, ej. 'gps.telemetry'. */
  type: string;
  /** ISO-8601. */
  occurredAt: string;
  /** Servicio productor. */
  source: string;
  /** Id de correlación para rastrear un flujo (ej. un viaje o un re-enrutamiento). */
  correlationId: string;
  /** Payload tipado del evento. */
  data: T;
}

// ---------------------------------------------------------------------------
// MVP 1 — Rutas multimodales, tracking, pago
// ---------------------------------------------------------------------------

/** Telemetría GPS de un vehículo (bus/metro). */
export interface GpsTelemetry {
  vehicleId: string;
  vehicleType: 'BUS' | 'METRO';
  routeId: string;
  position: GeoPoint;
  speedKmh: number;
  bearing: number;
  /** Retraso actual respecto al horario, en segundos (puede ser negativo). */
  delaySeconds: number;
  nextStopId: string;
  /** Distancia restante a la próxima parada (m). Permite ETA exacto, no estimado. */
  distanceToNextStopM?: number;
}

export interface RouteLeg {
  mode: TransportMode;
  fromStopId: string;
  toStopId: string;
  lineId?: string;
  /** minutos */
  durationMin: number;
  /** unidad monetaria local */
  cost: number;
  /** gramos de CO2 */
  carbonGrams: number;
  /** metros */
  distanceM: number;
}

export interface MultimodalRoute {
  routeOptionId: string;
  legs: RouteLeg[];
  totalDurationMin: number;
  totalCost: number;
  totalCarbonGrams: number;
  /** Etiqueta de optimización: 'FASTEST' | 'CHEAPEST' | 'GREENEST'. */
  optimizedFor: 'FASTEST' | 'CHEAPEST' | 'GREENEST';
}

export type PaymentMethod = 'NFC_CARD' | 'MOBILE_APP' | 'QR';

export interface PaymentEvent {
  paymentId: string;
  citizenId: string;
  tripId: string;
  method: PaymentMethod;
  legs: { mode: TransportMode; lineId?: string; fare: number }[];
  /** Tarifa total después de aplicar reglas de transbordo. */
  totalCharged: number;
  appliedTariffVersion: string;
  status: 'AUTHORIZED' | 'SETTLED' | 'DECLINED';
}

// ---------------------------------------------------------------------------
// MVP 2 — Semáforos inteligentes, movilidad compartida
// ---------------------------------------------------------------------------

export interface SignalCommand {
  intersectionId: string;
  /** Petición de prioridad para un actor. */
  priorityFor: 'DELAYED_BUS' | 'EMERGENCY_VEHICLE';
  vehicleId: string;
  /** Aproximación cardinal del vehículo: N|S|E|W. */
  approach: 'N' | 'S' | 'E' | 'W';
  /** Segundos de extensión de verde solicitados. */
  greenExtensionSec: number;
  reason: string;
}

export interface SignalStatus {
  intersectionId: string;
  phase: 'GREEN' | 'YELLOW' | 'RED';
  approach: 'N' | 'S' | 'E' | 'W';
  /** ACK del comando NTCIP, si aplica. */
  ackCommandId?: string;
  healthy: boolean;
}

export type ShareableType = 'SCOOTER' | 'BIKE';

export interface SharingEvent {
  vehicleId: string;
  type: ShareableType;
  action: 'RESERVED' | 'UNLOCKED' | 'TRIP_ENDED' | 'DAMAGE_REPORTED' | 'AVAILABLE';
  citizenId?: string;
  stationId?: string;
  position?: GeoPoint;
  batteryPct?: number;
  damageNote?: string;
}

// ---------------------------------------------------------------------------
// MVP 3 — Predicción de congestión, notificaciones, analítica
// ---------------------------------------------------------------------------

export interface CongestionPrediction {
  corridorId: string;
  segmentId: string;
  /** Probabilidad 0..1 de congestión severa. */
  congestionRisk: number;
  /** Velocidad promedio estimada (km/h) en la ventana predicha. */
  predictedSpeedKmh: number;
  /** Minutos hacia el futuro de la predicción (objetivo: 30). */
  horizonMin: number;
  affectedRoutes: string[];
}

export interface RerouteCommand {
  rerouteId: string;
  busId: string;
  routeId: string;
  fromCorridorId: string;
  toCorridorId: string;
  reason: string;
  predictedDelaySavedSec: number;
  /** Tiempo (ISO) en que se detectó la anomalía (para medir SLA < 10s). */
  anomalyDetectedAt: string;
}

export interface PushNotification {
  notificationId: string;
  citizenId: string;
  tripId?: string;
  category: 'INTERRUPTION' | 'DETOUR' | 'ALTERNATIVE' | 'ARRIVAL';
  title: string;
  body: string;
  /** Datos para deep-link en la app. */
  payload?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// MVP 4 — Trazabilidad / auditoría regulatoria
// ---------------------------------------------------------------------------

export interface AuditRecord {
  auditId: string;
  category: 'REROUTE' | 'TARIFF_CHANGE' | 'SIGNAL_PRIORITY' | 'PAYMENT';
  correlationId: string;
  actor: string;
  /** Hash encadenado del registro anterior (integridad tipo cadena). */
  prevHash: string;
  hash: string;
  occurredAt: string;
  recordedAt: string;
  payload: Record<string, unknown>;
}
