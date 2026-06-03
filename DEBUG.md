# 🐞 Lista de Depuración — UrbanFlow

Checklist para levantar, verificar y depurar el sistema, MVP por MVP.

## 0. Pre-vuelo
- [ ] Docker Desktop corriendo (`docker version`).
- [ ] Estás en `urbanflow/` (`cd urbanflow`).
- [ ] Existe `.env` → `Copy-Item .env.example .env` (PowerShell) / `cp .env.example .env`.
- [ ] Compila sin errores → `npm install && npm run build`.

## 1. Infraestructura (Kafka + bases políglotas)
- [ ] `docker compose up -d redpanda postgres timescaledb neo4j redis redpanda-console`
- [ ] Esperar a *healthy*: `docker compose ps` (todas las deps deben verse `healthy`).
- [ ] Redpanda Console abre en http://localhost:8085 (se ven los topics al fluir eventos).
- [ ] Neo4j Browser en http://localhost:7474 (usuario `neo4j`, pass `urbanflow_secret`).
- [ ] Postgres vivo: `docker exec uf-postgres pg_isready -U urbanflow`.
- [ ] TimescaleDB vivo: `docker exec uf-timescaledb pg_isready -U urbanflow -d telemetry`.
- [ ] Redis vivo: `docker exec uf-redis redis-cli ping` → `PONG`.

## 2. Levantar todo
- [ ] `docker compose up -d --build` (primera vez tarda: descarga imágenes + build Node).
- [ ] `docker compose ps` → 10 servicios + gateway + dashboard + simulator `Up`.
- [ ] Logs sanos: `docker compose logs -f uf-route-planning uf-tracking uf-audit`.
- [ ] Gateway responde: `curl localhost:8080/api` → lista de rutas.
- [ ] Health de un servicio: `curl localhost:8080/api/audit/health`.

## 3. MVP 1 — Rutas, Tracking, Pago
- [ ] **Rutas (Neo4j)**: `curl -X POST localhost:8080/api/routing/plan -H "Content-Type: application/json" -d '{"fromStopId":"ST-SUR","toStopId":"ST-NORTE"}'`
      → devuelve opciones FASTEST/CHEAPEST/GREENEST con tiempo, costo y CO₂.
- [ ] Si da 404 "No se encontró ruta": revisar que el seed de Neo4j corrió
      (log `Grafo de transporte listo en Neo4j`). Reintenta si Neo4j tardó en arrancar.
- [ ] **Tracking (TimescaleDB)**: con el simulador activo,
      `curl localhost:8080/api/tracking/arrivals/ST-CENTRO` → llegadas con ETA.
- [ ] `curl localhost:8080/api/tracking/vehicles/BUS-001/position` → última posición (Redis).
- [ ] **Pago (Postgres)**: `curl localhost:8080/api/payment/accounts/citizen-001` → saldo.
      Tras unos segundos del simulador, el saldo baja (cobros de viajes).

## 4. MVP 2 — Semáforos, Sharing
- [ ] **Semáforo emergencia (NTCIP)**: `curl -X POST localhost:8080/api/signals/emergency -H "Content-Type: application/json" -d '{"vehicleId":"AMB-01","intersectionId":"INT-CENTRO","approach":"N"}'`
      → `PRIORITY_REQUESTED`. Log muestra `bytes <= 256`.
- [ ] **Prioridad por retraso**: en logs de `uf-traffic-signal` aparecen comandos
      NTCIP para buses con retraso > 5 min (el simulador atrasa ~1/9 buses).
- [ ] `curl localhost:8080/api/signals/intersections/INT-CENTRO` → último comando + estado (ACK).
- [ ] **Sharing**: `curl localhost:8080/api/sharing/vehicles?station=ST-CENTRO` → disponibles.
- [ ] Reservar: `curl -X POST localhost:8080/api/sharing/reservations -H "Content-Type: application/json" -d '{"citizenId":"citizen-001","vehicleId":"SCO-1001"}'` → `reservationId`.
- [ ] Desbloquear: `curl -X POST localhost:8080/api/sharing/reservations/<id>/unlock`.

## 5. MVP 3 — Predicción, Notificaciones, Analítica
- [ ] **Predicción**: `curl localhost:8080/api/congestion/predictions` → riesgo por corredor.
      El corredor **B-202** debe subir de riesgo con el tiempo (el simulador lo congestiona).
- [ ] **Re-ruteo <10 s**: en logs de `uf-congestion` busca `Bus re-enrutado` con
      `withinSLA: true` y `elapsedMs`.
- [ ] **Notificaciones**: `curl localhost:8080/api/notifications/notifications/driver:BUS-002`
      (los conductores re-enrutados reciben aviso de desvío).
- [ ] SSE en vivo: `curl localhost:8080/api/notifications/stream/citizen-001`.
- [ ] **Analítica/KPIs**: `curl localhost:8080/api/analytics/kpis` → puntualidad,
      emisiones evitadas, ocupación, recaudación. El **dashboard** (http://localhost:8090)
      muestra todo y se refresca cada 4 s.

## 6. MVP 4 — Auditoría / Trazabilidad
- [ ] Pista de auditoría: `curl "localhost:8080/api/audit/audit?limit=10"`
      → registros REROUTE / TARIFF_CHANGE / SIGNAL_PRIORITY / PAYMENT.
- [ ] **Integridad de la cadena**: `curl localhost:8080/api/audit/audit/verify`
      → `{"intact": true, ...}`.
- [ ] Trazar un re-ruteo: `curl localhost:8080/api/audit/audit/trace/<correlationId>`.
- [ ] Cambiar tarifa (auditable): `curl -X POST localhost:8080/api/payment/tariff -H "Content-Type: application/json" -d '{"version":"v2026.2","baseFares":{"BUS":2.75,"METRO":3.25,"WALK":0},"transferRules":{"freeTransferWindowMin":60,"transferDiscountPct":50,"dailyCap":13},"actor":"operador-demo"}'`
      → luego aparece como `TARIFF_CHANGE` en `/audit/audit`.

## 7. Problemas comunes y solución
| Síntoma | Causa probable | Solución |
|---|---|---|
| Servicios reinician al inicio | Infra aún no *healthy* | Esperar; `EventBus` reintenta. Ver `docker compose ps`. |
| 404 en `/plan` | Seed de Neo4j no corrió | Revisar logs `uf-route-planning`; Neo4j tardó en arrancar (reintenta solo). |
| KPIs vacíos | Sin telemetría todavía | Confirmar `uf-simulator` `Up`; esperar ~30 s. |
| `arrivals` vacío | Cache Redis sin datos | Verificar que `tracking-service` consume `gps.telemetry` (Redpanda Console). |
| Puerto ocupado (8080/5432/7474…) | Otro proceso usa el puerto | Cerrarlo o cambiar el mapeo en `docker-compose.yml`. |
| `verify` → `intact:false` | Cadena alterada / orden | No se debe editar `audit.event_log` (trigger lo bloquea). Reset: `down -v`. |
| Build falla tras editar | Falta recompilar `shared` | `npm run build` (project references compila en orden). |
| Cambios no se reflejan en contenedor | Imagen vieja | `docker compose up -d --build <servicio>`. |

## 8. Inspección directa de datos
```bash
# Telemetría (TimescaleDB)
docker exec -it uf-timescaledb psql -U urbanflow -d telemetry -c "SELECT count(*) FROM gps_telemetry;"
# Pagos (Postgres)
docker exec -it uf-postgres psql -U urbanflow -c "SELECT status, count(*) FROM payment.transaction GROUP BY status;"
# Cadena de auditoría
docker exec -it uf-postgres psql -U urbanflow -c "SELECT category, count(*) FROM audit.event_log GROUP BY category;"
# Grafo de rutas (Neo4j)
docker exec -it uf-neo4j cypher-shell -u neo4j -p urbanflow_secret "MATCH (s:Stop) RETURN count(s);"
```

## 9. Reset total
```bash
docker compose down -v   # borra contenedores + volúmenes (BD limpias)
docker compose up -d --build
```
