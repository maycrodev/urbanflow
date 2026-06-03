# Diagrama de Secuencia — Flujo de Re-enrutamiento de Bus

Cumple los incisos VI (predicción + re-enrutamiento), VII (notificación al conductor)
y el inciso b) del Contexto Adicional (trazabilidad). NFR clave: el re-enrutamiento
debe ejecutarse en **menos de 10 segundos** desde la detección de la anomalía.

```mermaid
sequenceDiagram
    autonumber
    participant SIM as Vehículos/Simulator
    participant K as Kafka (Redpanda)
    participant TRK as tracking-service
    participant TS as TimescaleDB
    participant CP as congestion-prediction-service
    participant S3 as Data Lake (S3 baseline)
    participant NS as notification-service
    participant DRV as App Conductor
    participant AUD as audit-service
    participant PG as PostgreSQL (audit)

    SIM->>K: publish gps.telemetry (pos, speed, delay)
    K-->>TRK: gps.telemetry
    TRK->>TS: INSERT serie temporal (hypertable)

    loop cada 5 s (ventana de detección)
        CP->>TS: SELECT velocidad media por corredor (6 min)
        CP->>S3: baseline histórico por hora (feature)
        CP->>CP: predict() horizonte 30 min => riesgo, velocidad
        CP->>K: publish congestion.predictions
        alt riesgo >= umbral (anomalía)
            Note over CP: t0 = anomalyDetectedAt
            CP->>TS: buses activos en el corredor
            CP->>K: publish bus.reroute (from->to, SLA t0)
            CP->>K: publish notifications (desvío al conductor)
            Note over CP,K: elapsed < 10 s  ✅ (se registra y mide)
        end
    end

    K-->>NS: notifications
    NS->>DRV: push/SSE "Desvío B-202 -> B-101"

    Note over K,AUD: bus.reroute es AUDITABLE
    K-->>AUD: audit.log (espejo de bus.reroute)
    AUD->>PG: INSERT append-only + hash encadenado (prev_hash -> hash)
    AUD-->>AUD: GET /audit/verify => cadena íntegra
```

## Notas de cumplimiento

- **< 10 s**: la detección (consulta a TimescaleDB) y la emisión de `bus.reroute`
  ocurren en el mismo ciclo del `congestion-prediction-service`; se calcula
  `elapsedMs = now - anomalyDetectedAt` y se registra `withinSLA`.
- **Trazabilidad**: el `EventBus` espeja `bus.reroute` a `audit.log`; el
  `audit-service` lo persiste en una **cadena de hashes** append-only
  (tamper-evidence) verificable vía `GET /api/audit/audit/verify`.
- **Desacople**: ningún servicio llama a otro de forma síncrona en el camino
  crítico; todo fluye por eventos, lo que sostiene los >50.000 ev/s en hora pico.
