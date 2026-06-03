# ADR-005 · Predicción de congestión y uso del Data Lake (S3)

- **Estado**: Aceptada
- **Fecha**: 2026-06-02
- **Contexto del kata**: predecir congestión con **30 min de anticipación** y
  re-enrutar buses en **<10 s**; usar el data lake (AWS S3) con **10 años** de
  histórico para los modelos.

## Decisión
- El `congestion-prediction-service` combina dos señales: **baseline histórico**
  por corredor y hora (surrogate del data lake S3) + **tendencia en vivo**
  (pendiente de velocidad de los últimos minutos desde TimescaleDB), y extrapola
  a un horizonte de 30 min para estimar `congestionRisk` y `predictedSpeedKmh`.
- Si el riesgo supera el umbral, emite `bus.reroute` y notifica al conductor
  **en el mismo ciclo de detección**, midiendo `elapsedMs` contra el SLA de 10 s.
- En producción, el baseline/modelo se entrena **offline** (SageMaker/EMR sobre
  S3) y se publica como *feature store*; el servicio online solo infiere.

## Alternativas consideradas
- **Modelo ML pesado online**: latencia y complejidad incompatibles con el SLA de
  10 s y con el tiempo del hackathon. Se separa entrenamiento (offline) de
  inferencia (online). Heurística primero, ML después.
- **Reglas fijas por horario**: no reacciona a anomalías en vivo. Rechazado;
  se combinan baseline + tendencia.

## Consecuencias
- (+) Cumple el SLA <10 s; arquitectura lista para sustituir la heurística por un
  modelo entrenado sin cambiar los contratos de eventos.
- (+) Reutiliza el histórico de S3 como baseline.
- (−) La heurística es aproximada; se itera con datos reales y validación.
