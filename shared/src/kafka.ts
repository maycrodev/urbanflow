import { randomUUID } from 'node:crypto';
import { Kafka, logLevel, Producer, Consumer, EachMessagePayload } from 'kafkajs';
import { EventEnvelope } from './types';
import { TopicName, AUDITABLE_TOPICS, Topics } from './topics';
import { createLogger, Logger } from './logger';

export interface BusOptions {
  service: string;
  brokers?: string[];
  clientId?: string;
}

/**
 * EventBus: wrapper delgado sobre KafkaJS con:
 *  - publish() que envuelve el payload en un EventEnvelope estándar
 *  - replicación automática de eventos auditables al topic `audit.log`
 *  - subscribe() con deserialización y manejo de errores
 *
 * Esto centraliza la trazabilidad exigida por el regulador (MVP 4): cualquier
 * evento de un topic auditable queda espejado en `audit.log` sin que cada
 * servicio tenga que recordar hacerlo.
 */
export class EventBus {
  private kafka: Kafka;
  private producer: Producer;
  private consumers: Consumer[] = [];
  private connected = false;
  readonly log: Logger;
  readonly service: string;

  constructor(opts: BusOptions) {
    this.service = opts.service;
    this.log = createLogger(opts.service);
    const brokers = opts.brokers ?? (process.env.KAFKA_BROKERS ?? 'localhost:19092').split(',');
    this.kafka = new Kafka({
      clientId: opts.clientId ?? `${process.env.KAFKA_CLIENT_ID ?? 'urbanflow'}-${opts.service}`,
      brokers,
      logLevel: logLevel.ERROR,
      retry: { initialRetryTime: 300, retries: 12 },
    });
    this.producer = this.kafka.producer({ allowAutoTopicCreation: true });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.producer.connect();
    this.connected = true;
    this.log.info({ brokers: 'kafka' }, 'EventBus conectado al broker');
  }

  /** Publica un evento envuelto. Replica a audit.log si el topic es auditable. */
  async publish<T>(
    topic: TopicName,
    data: T,
    opts: { key?: string; correlationId?: string; type?: string } = {},
  ): Promise<EventEnvelope<T>> {
    const envelope: EventEnvelope<T> = {
      eventId: randomUUID(),
      type: opts.type ?? topic,
      occurredAt: new Date().toISOString(),
      source: this.service,
      correlationId: opts.correlationId ?? randomUUID(),
      data,
    };
    const value = JSON.stringify(envelope);
    const messages = [{ key: opts.key ?? envelope.eventId, value }];

    await this.producer.send({ topic, messages });

    if (AUDITABLE_TOPICS.includes(topic) && topic !== Topics.AUDIT_LOG) {
      // Espejo para auditoría: conserva el envelope original + topic de origen.
      await this.producer.send({
        topic: Topics.AUDIT_LOG,
        messages: [{ key: envelope.correlationId, value: JSON.stringify({ ...envelope, _sourceTopic: topic }) }],
      });
    }
    return envelope;
  }

  /**
   * Suscribe un handler a uno o varios topics dentro de un consumer group.
   * El handler recibe el EventEnvelope ya deserializado.
   */
  async subscribe<T = unknown>(
    groupId: string,
    topics: TopicName[],
    handler: (envelope: EventEnvelope<T>, raw: EachMessagePayload) => Promise<void>,
    opts: { fromBeginning?: boolean } = {},
  ): Promise<void> {
    const consumer = this.kafka.consumer({ groupId, sessionTimeout: 30000 });
    await consumer.connect();
    for (const t of topics) {
      await consumer.subscribe({ topic: t, fromBeginning: opts.fromBeginning ?? false });
    }
    this.consumers.push(consumer);
    await consumer.run({
      eachMessage: async (payload) => {
        if (!payload.message.value) return;
        try {
          const envelope = JSON.parse(payload.message.value.toString()) as EventEnvelope<T>;
          await handler(envelope, payload);
        } catch (err) {
          this.log.error({ err, topic: payload.topic }, 'Error procesando mensaje');
        }
      },
    });
    this.log.info({ groupId, topics }, 'Consumer suscrito');
  }

  async disconnect(): Promise<void> {
    await Promise.allSettled(this.consumers.map((c) => c.disconnect()));
    if (this.connected) await this.producer.disconnect();
    this.connected = false;
  }
}

export { Logger, createLogger };
