# ADR-003 · Trazabilidad auditable por cadena de hashes append-only

- **Estado**: Aceptada
- **Fecha**: 2026-06-02
- **Contexto del kata**: el ente regulador audita trimestralmente y exige
  **trazabilidad completa** de todos los eventos de re-enrutamiento y cambios de
  tarifa (MVP 4, 100%).

## Decisión
1. El `EventBus` compartido **replica automáticamente** todo evento de un topic
   marcado como auditable (`bus.reroute`, `tariff.changes`, `signal.commands`,
   `payment.events`) al topic `audit.log`. Los servicios de negocio no necesitan
   recordar emitir auditoría → imposible "olvidarla".
2. El `audit-service` consume `audit.log` y persiste cada registro en una tabla
   **append-only** de PostgreSQL (`audit.event_log`), con `UPDATE`/`DELETE`
   bloqueados por trigger.
3. Cada registro encadena un **hash SHA-256** del anterior
   (`hash = sha256(prev_hash || audit_id || occurred_at || payload)`),
   creando una estructura *tamper-evident* tipo blockchain ligero.
4. `GET /audit/verify` recalcula la cadena y detecta cualquier manipulación.

## Alternativas consideradas
- **Confiar en logs de aplicación**: no inmutables, sin integridad verificable.
  Rechazado.
- **Que cada servicio escriba su propia auditoría**: acoplamiento y riesgo de
  omisión/inconsistencia. Rechazado a favor de la replicación centralizada.
- **QLDB / blockchain gestionada**: válido en producción, pero sobredimensionado
  para el hackathon; la cadena de hashes en Postgres aporta la misma propiedad
  verificable con menor coste.

## Consecuencias
- (+) Trazabilidad completa y verificable; export sencillo para el regulador.
- (+) Desacople total respecto a los servicios de negocio.
- (−) El encadenado exige orden: el `audit-service` serializa la escritura
  (cola en proceso) para preservar la integridad de la cadena.
