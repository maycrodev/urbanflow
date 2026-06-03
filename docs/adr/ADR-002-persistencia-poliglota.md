# ADR-002 · Persistencia políglota (una base de datos por servicio)

- **Estado**: Aceptada
- **Fecha**: 2026-06-02
- **Contexto del kata**: cada microservicio debe tener su propia base de datos
  (time-series para telemetría, relacional para pagos, grafo para rutas).

## Decisión
Cada servicio es dueño exclusivo de su almacén, elegido según la forma del dato:

| Dato | Motor | Por qué |
|---|---|---|
| Grafo de rutas multimodales | **Neo4j** | Cálculo de caminos óptimos (Dijkstra) sobre relaciones modo/línea. |
| Telemetría GPS (alto volumen) | **TimescaleDB** | Hypertables, compresión, *continuous aggregates*, retención. |
| Pagos, sharing, auditoría | **PostgreSQL** | Transacciones ACID, restricciones, JSONB, triggers append-only. |
| Cache realtime / disponibilidad | **Redis** | Última posición, ETAs, índices por parada, contadores de KPIs. |

Ningún servicio accede a la base de otro: la integración es **solo por eventos**.

## Alternativas consideradas
- **Una sola base relacional para todo**: simple, pero la telemetría time-series
  y el grafo de rutas tienen patrones de acceso incompatibles con un único motor.
  Rechazado.
- **Solo NoSQL**: perdería las garantías ACID críticas para pagos y la integridad
  de la pista de auditoría. Rechazado.

## Consecuencias
- (+) Cada motor se escala y optimiza para su carga.
- (+) Aislamiento de fallos y despliegues por dominio.
- (−) No hay *joins* entre dominios: se resuelve con eventos y claves de
  correlación, y con el **data lake (S3)** para la analítica integrada histórica.
- (−) Más tecnologías que operar (mitigado con servicios gestionados en AWS).
