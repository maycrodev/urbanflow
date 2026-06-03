# Diagrama de Secuencia — Viaje Multimodal + Pago Unificado

Cubre incisos I (planificación), III (pago unificado NFC/App/QR con descuento
por combinación de modos) y la trazabilidad de cambios/cobros de tarifa.

```mermaid
sequenceDiagram
    autonumber
    participant C as Ciudadano (App)
    participant GW as API Gateway
    participant RP as route-planning-service
    participant NEO as Neo4j
    participant K as Kafka
    participant PAY as payment-service
    participant PG as PostgreSQL
    participant AN as analytics-service
    participant AUD as audit-service

    C->>GW: POST /api/routing/plan {from, to}
    GW->>RP: /plan
    RP->>NEO: cargar aristas (CONNECTS)
    RP->>RP: Dijkstra x3 (FASTEST/CHEAPEST/GREENEST)
    RP-->>C: opciones [tiempo, costo, CO2]

    C->>GW: POST /api/routing/trips {citizen, route}
    RP->>K: trip.events (STARTED)
    C->>GW: POST /api/routing/trips/:id/complete
    RP->>K: trip.events (COMPLETED, modos usados)

    K-->>PAY: trip.events (COMPLETED)
    PAY->>PG: tarifa vigente (tariff_version)
    PAY->>PAY: computeFare(modos, reglas transbordo, dailyCap)
    PAY->>PG: BEGIN; debitar saldo; INSERT transaction; COMMIT
    PAY->>K: payment.events (SETTLED)  %% AUDITABLE

    K-->>AN: trip.events / payment.events
    AN->>AN: acumular emisiones evitadas, recaudación, ridership
    K-->>AUD: audit.log (espejo de payment.events)
    AUD->>PG: INSERT append-only + hash encadenado
```
