/**
 * Catálogo central de topics de Kafka (event streaming backbone).
 *
 * Convención de nombres:  <dominio>.<evento>
 * Todos los eventos auditables se replican adicionalmente al topic `audit.log`
 * que consume el audit-service (MVP 4 - trazabilidad regulatoria).
 */
export const Topics = {
  /** Telemetría GPS cruda de buses y metros (alto volumen, >50k ev/s en pico). */
  GPS_TELEMETRY: 'gps.telemetry',

  /** Ciclo de vida de un viaje multimodal del ciudadano. */
  TRIP_EVENTS: 'trip.events',

  /** Resultado de cobros del sistema de pago unificado. */
  PAYMENT_EVENTS: 'payment.events',

  /** Cambios de tarifa (auditable). */
  TARIFF_CHANGES: 'tariff.changes',

  /** Predicciones de congestión 30 min hacia adelante. */
  CONGESTION_PREDICTIONS: 'congestion.predictions',

  /** Órdenes de re-enrutamiento de buses (auditable). */
  BUS_REROUTE: 'bus.reroute',

  /** Órdenes hacia semáforos (priorización). NTCIP, <=256 bytes. */
  SIGNAL_COMMANDS: 'signal.commands',

  /** Estado reportado por semáforos (canal bidireccional). */
  SIGNAL_STATUS: 'signal.status',

  /** Eventos de movilidad compartida (reserva, desbloqueo, daño). */
  SHARING_EVENTS: 'sharing.events',

  /** Notificaciones push personalizadas a ciudadanos. */
  NOTIFICATIONS: 'notifications',

  /** Log inmutable consumido por el audit-service. */
  AUDIT_LOG: 'audit.log',
} as const;

export type TopicName = (typeof Topics)[keyof typeof Topics];

/** Topics cuyos eventos exige trazabilidad el ente regulador. */
export const AUDITABLE_TOPICS: TopicName[] = [
  Topics.BUS_REROUTE,
  Topics.TARIFF_CHANGES,
  Topics.SIGNAL_COMMANDS,
  Topics.PAYMENT_EVENTS,
];
