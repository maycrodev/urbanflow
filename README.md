# UrbanFlow - Plataforma Inteligente de Movilidad Urbana

Sistema del kata arquitectónico (Quinta Hackatón). Microservicios + event
streaming (Kafka/Redpanda) + persistencia políglota (Neo4j, TimescaleDB,
PostgreSQL, Redis). Implementa los **4 MVPs** del enunciado.

> Documentación de arquitectura (C4, ADRs, secuencias, despliegue, data lake):
> ver [`docs/`](docs/README.md).

## Arquitectura en 30 segundos

```
Clientes --> api-gateway --> 10 microservicios --> (Neo4j | TimescaleDB | PostgreSQL | Redis)
                                |     ^
                                v     |
                           Kafka / Redpanda  <-- simulator (telemetria + viajes)
                                |
                                +--> audit.log --> audit-service (trazabilidad)
```

| MVP | Servicios | Puerto |
|---|---|---|
| 1 | route-planning (3001), tracking (3002), payment (3003) | |
| 2 | traffic-signal (3004), sharing (3005) | |
| 3 | congestion-prediction (3006), notification (3007), analytics (3008) | |
| 4 | audit (3009) | |
| - | api-gateway (8080), dashboard (8090) | |

## Requisitos
- Docker + Docker Compose
- (Opcional, para desarrollo sin Docker) Node.js >= 20

## Arranque rápido (todo con Docker)

```bash
cd urbanflow
cp .env.example .env          # Windows PowerShell:  Copy-Item .env.example .env
docker compose up -d --build  # levanta infra + 10 servicios + dashboard + simulador
docker compose logs -f        # ver el sistema en vivo
```

Esperar ~1-2 min a que la infraestructura quede *healthy*. Luego:

| Recurso | URL |
|---|---|
| Dashboard de la Alcaldía | http://localhost:8090 |
| API Gateway | http://localhost:8080/api |
| Redpanda Console (topics/eventos) | http://localhost:8085 |
| Neo4j Browser | http://localhost:7474 (neo4j / urbanflow_secret) |

El `simulator` ya está inyectando telemetría GPS y viajes: el dashboard se
puebla solo, los buses se atrasan (prioridad semafórica) y el corredor B-202 se
congestiona (predicción + re-enrutamiento + auditoría).

## Prueba de los flujos (vía gateway)

```bash
# MVP1 - Planificar ruta multimodal (tiempo, costo, CO2)
curl -X POST localhost:8080/api/routing/plan -H "Content-Type: application/json" \
  -d '{"fromStopId":"ST-SUR","toStopId":"ST-NORTE"}'

# MVP1 - Llegadas exactas a una parada
curl localhost:8080/api/tracking/arrivals/ST-CENTRO

# MVP2 - Prioridad para vehículo de emergencia (semáforo NTCIP)
curl -X POST localhost:8080/api/signals/emergency -H "Content-Type: application/json" \
  -d '{"vehicleId":"AMB-01","intersectionId":"INT-CENTRO","approach":"N"}'

# MVP2 - Reservar un scooter
curl -X POST localhost:8080/api/sharing/reservations -H "Content-Type: application/json" \
  -d '{"citizenId":"citizen-001","vehicleId":"SCO-1001"}'

# MVP3 - KPIs del panel de la alcaldía
curl localhost:8080/api/analytics/kpis

# MVP3 - Predicciones de congestión vigentes
curl localhost:8080/api/congestion/predictions

# MVP4 - Pista de auditoría + verificación de integridad de la cadena
curl localhost:8080/api/audit/audit?limit=10
curl localhost:8080/api/audit/audit/verify
```

## Desarrollo sin Docker (solo infra en contenedores)

```bash
npm install
docker compose up -d redpanda postgres timescaledb neo4j redis
npm run build
# en terminales separadas, p.ej.:
node services/route-planning-service/dist/index.js
node simulator/dist/index.js
```
> Para desarrollo local, exporta los hosts a `localhost` y los puertos
> publicados (Kafka `localhost:19092`, Timescale `localhost:5433`, etc.).

## Estructura
```
urbanflow/
├── shared/            # EventBus (Kafka), topics, tipos de eventos, bootstrap HTTP
├── services/          # 10 microservicios (uno por dominio)
├── dashboard/         # panel web de la alcaldía (+ proxy al gateway)
├── simulator/         # generador de telemetría GPS y viajes
├── infra/             # init SQL (Postgres, TimescaleDB) y seed Cypher (Neo4j)
├── docs/              # C4, ADRs, secuencias, despliegue, data lake, carátula
├── docker-compose.yml
└── Dockerfile         # imagen única para todos los servicios Node
```

## Comandos útiles
```bash
docker compose ps                 # estado de contenedores
docker compose logs -f uf-audit   # logs de un servicio
docker compose down               # detener
docker compose down -v            # detener + borrar volúmenes (reset total)
npm run build                     # compilar todo el monorepo (TypeScript)
```
