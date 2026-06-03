# C4 · Nivel 2 — Diagrama de Contenedores

Microservicios + event streaming (Kafka/Redpanda) + persistencia políglota.

```mermaid
flowchart TB
    subgraph clients[Clientes]
      app[App Ciudadano]
      driverapp[App Conductor]
      panel[Dashboard Alcaldía]
    end

    gw[["API Gateway<br/>(BFF / reverse proxy)"]]

    subgraph mvp1[MVP 1 - Rutas, Tracking, Pago]
      route[route-planning-service]
      track[tracking-service]
      pay[payment-service]
    end
    subgraph mvp2[MVP 2 - Semáforos, Sharing]
      signal[traffic-signal-service]
      share[sharing-service]
    end
    subgraph mvp3[MVP 3 - Predicción, Notificación, Analítica]
      congestion[congestion-prediction-service]
      notif[notification-service]
      analytics[analytics-service]
    end
    subgraph mvp4[MVP 4 - Auditoría]
      audit[audit-service]
    end

    kafka{{"Kafka / Redpanda<br/>event streaming"}}

    neo[(Neo4j<br/>grafo rutas)]
    ts[(TimescaleDB<br/>telemetría)]
    pg[(PostgreSQL<br/>pagos/sharing/audit)]
    redis[(Redis<br/>cache realtime)]
    s3[(AWS S3<br/>data lake histórico)]
    ntcip[/Semáforos NTCIP/]

    app --> gw
    driverapp --> gw
    panel --> gw
    gw --> route & track & pay & signal & share & congestion & notif & analytics & audit

    route --> neo
    track --> ts
    track --> redis
    pay --> pg
    share --> pg
    share --> redis
    signal --> redis
    signal <--> ntcip
    congestion --> ts
    congestion -. lee histórico .-> s3
    analytics --> ts
    analytics --> redis
    audit --> pg

    %% Event streaming (todos publican/consumen)
    route -- trip.events --> kafka
    track -- gps.telemetry --> kafka
    kafka -- gps.telemetry --> track
    kafka -- trip.events --> pay
    pay -- payment.events / tariff.changes --> kafka
    kafka -- gps.telemetry --> signal
    signal -- signal.commands/status --> kafka
    share -- sharing.events --> kafka
    kafka -- gps.telemetry --> congestion
    congestion -- bus.reroute / congestion.predictions --> kafka
    kafka -- notifications --> notif
    kafka -- "*.events" --> analytics
    kafka -- audit.log --> audit
```

## Responsabilidad y persistencia por servicio

| Servicio | MVP | Inciso | Base de datos | Topics que produce | Topics que consume |
|---|---|---|---|---|---|
| route-planning-service | 1 | I | Neo4j (grafo) | `trip.events` | — |
| tracking-service | 1 | II | TimescaleDB + Redis | `gps.telemetry`* | `gps.telemetry` |
| payment-service | 1 | III | PostgreSQL | `payment.events`, `tariff.changes` | `trip.events` |
| traffic-signal-service | 2 | IV | Redis | `signal.commands`, `signal.status` | `gps.telemetry`, `signal.*` |
| sharing-service | 2 | V | PostgreSQL + Redis | `sharing.events` | — |
| congestion-prediction-service | 3 | VI | TimescaleDB (+S3) | `congestion.predictions`, `bus.reroute`, `notifications` | `gps.telemetry` |
| notification-service | 3 | VII | Redis | `notifications` | `notifications`, `trip.events`, `bus.reroute` |
| analytics-service | 3 | VIII | TimescaleDB + Redis | — | `trip.events`, `payment.events` |
| audit-service | 4 | b) | PostgreSQL (append-only) | — | `audit.log` |

\* La telemetría la produce el `simulator` (o los vehículos reales); `tracking-service` la consume.

> El **EventBus** (en `shared/`) replica automáticamente todo evento de un topic
> auditable (`bus.reroute`, `tariff.changes`, `signal.commands`, `payment.events`)
> al topic `audit.log`, garantizando trazabilidad sin acoplar a cada servicio.
