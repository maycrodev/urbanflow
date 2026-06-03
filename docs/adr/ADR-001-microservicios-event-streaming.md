# ADR-001 · Arquitectura de microservicios con event streaming (Kafka/Redpanda)

- **Estado**: Aceptada
- **Fecha**: 2026-06-02
- **Contexto del kata**: arquitectura obligatoria = microservicios + event
  streaming para procesar eventos en tiempo real.

## Contexto
El sistema debe procesar **>50.000 eventos/segundo** en hora pico, con
disponibilidad **99.95%** y baja latencia (re-enrutamiento <10 s). Hay múltiples
dominios heterogéneos (rutas, tracking, pago, semáforos, sharing, predicción,
notificación, analítica, auditoría) con ciclos de vida y escalado distintos.

## Decisión
Adoptar **microservicios** desacoplados que se comunican de forma **asíncrona**
mediante un *event streaming backbone* (Kafka, implementado con **Redpanda** en
local por su menor footprint y compatibilidad con el protocolo Kafka). Cada
servicio publica/consume eventos a través de un `EventBus` compartido.

## Alternativas consideradas
- **Monolito modular**: más simple de operar, pero no escala por dominio ni
  soporta el throughput requerido sin acoplar despliegues. Rechazado.
- **Microservicios con REST síncrono**: acoplamiento temporal; un servicio lento
  degrada toda la cadena crítica. Rechazado para el camino caliente.
- **RabbitMQ / colas**: buen fan-out, pero menor throughput y sin *replay*/log
  retentivo necesario para reprocesar y para auditoría. Rechazado.

## Consecuencias
- (+) Escalado horizontal independiente; tolerancia a fallos (replay desde el log).
- (+) El log de eventos habilita auditoría y reprocesamiento histórico.
- (−) Mayor complejidad operativa (observabilidad, *exactly/at-least once*).
- (−) Consistencia eventual: se diseña idempotencia y claves de correlación.
