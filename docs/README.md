# Documentación de Arquitectura — UrbanFlow

Documentación requerida por la rúbrica del kata.

## Índice

### Diagramas C4
- [C4 Nivel 1 · Contexto](c4/c4-context.md)
- [C4 Nivel 2 · Contenedores](c4/c4-container.md)

### Diagramas de Secuencia
- [Re-enrutamiento de bus (requerido)](sequence/reroute-sequence.md)
- [Viaje multimodal + pago unificado](sequence/payment-sequence.md)

### ADRs (Architecture Decision Records)
- [ADR-001 · Microservicios + event streaming](adr/ADR-001-microservicios-event-streaming.md)
- [ADR-002 · Persistencia políglota](adr/ADR-002-persistencia-poliglota.md)
- [ADR-003 · Trazabilidad por cadena de hashes](adr/ADR-003-trazabilidad-cadena-hashes.md)
- [ADR-004 · Integración NTCIP semáforos](adr/ADR-004-integracion-ntcip-semaforos.md)
- [ADR-005 · Predicción de congestión + Data Lake](adr/ADR-005-prediccion-congestion-datalake.md)
- [ADR-006 · Privacidad / anonimización de ubicación](adr/ADR-006-privacidad-diferencial-ubicacion.md)

### Despliegue y Datos
- [Diagrama de despliegue en nube (AWS)](deployment/deployment.md)
- [Modelo de datos del Data Lake (S3)](data-lake/data-lake-model.md)

### Entregable
- [Carátula con asistentes](CARATULA.md)

## Trazabilidad requerimientos → implementación

| Req | Descripción | MVP | Servicio | Estado |
|---|---|---|---|---|
| I | Rutas multimodales (tiempo/costo/CO₂) | 1 | route-planning-service | ✅ |
| II | Tracking GPS en tiempo real, llegadas exactas | 1 | tracking-service | ✅ |
| III | Pago unificado NFC/App/QR | 1 | payment-service | ✅ |
| IV | Semáforos: prioridad bus retrasado/emergencia | 2 | traffic-signal-service | ✅ |
| V | Scooters/bicis: disponibilidad, reserva, desbloqueo, daños | 2 | sharing-service | ✅ |
| VI | Predicción congestión 30 min + re-ruteo <10 s | 3 | congestion-prediction-service | ✅ |
| VII | Notificaciones push personalizadas | 3 | notification-service | ✅ |
| VIII | Panel KPIs de movilidad | 3 | analytics-service + dashboard | ✅ |
| b) | Trazabilidad re-ruteos y cambios de tarifa | 4 | audit-service | ✅ |
| NFR | >50k ev/s, 99.95%, <10s reruteo, privacidad | — | Kafka + diseño | ✅ (diseño) |
