-- ======================================================================
-- TimescaleDB (time-series) - Telemetría GPS de buses y metros (MVP 1, II)
-- Polyglot persistence: serie temporal de alto volumen (>50k ev/s en pico).
-- ======================================================================
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ----------------------------------------------------------------------
-- Telemetría cruda. Hypertable particionada por tiempo.
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gps_telemetry (
  time          TIMESTAMPTZ      NOT NULL,
  vehicle_id    TEXT             NOT NULL,
  vehicle_type  TEXT             NOT NULL,
  route_id      TEXT             NOT NULL,
  lat           DOUBLE PRECISION NOT NULL,
  lon           DOUBLE PRECISION NOT NULL,
  speed_kmh     DOUBLE PRECISION NOT NULL,
  bearing       DOUBLE PRECISION,
  delay_seconds INTEGER          NOT NULL DEFAULT 0,
  next_stop_id  TEXT
);

SELECT create_hypertable('gps_telemetry', 'time', if_not_exists => TRUE, chunk_time_interval => INTERVAL '1 hour');

CREATE INDEX IF NOT EXISTS idx_gps_vehicle_time ON gps_telemetry (vehicle_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_gps_route_time   ON gps_telemetry (route_id, time DESC);

-- Compresión para datos > 6h (ahorro de almacenamiento en serie histórica).
ALTER TABLE gps_telemetry SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'vehicle_id',
  timescaledb.compress_orderby = 'time DESC'
);
SELECT add_compression_policy('gps_telemetry', INTERVAL '6 hours', if_not_exists => TRUE);

-- Retención: la telemetría cruda vive 7 días; lo histórico va al data lake (S3).
SELECT add_retention_policy('gps_telemetry', INTERVAL '7 days', if_not_exists => TRUE);

-- ----------------------------------------------------------------------
-- Vista materializada continua: velocidad media por corredor cada 1 min.
-- Alimenta el cálculo de flujo por corredor (analítica MVP 3, VIII).
-- ----------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS corridor_speed_1m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 minute', time) AS bucket,
  route_id,
  avg(speed_kmh)               AS avg_speed_kmh,
  avg(delay_seconds)           AS avg_delay_sec,
  count(*)                     AS samples
FROM gps_telemetry
GROUP BY bucket, route_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('corridor_speed_1m',
  start_offset => INTERVAL '10 minutes',
  end_offset   => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute',
  if_not_exists => TRUE);

-- ----------------------------------------------------------------------
-- Tabla de últimas posiciones (snapshot) para "llegadas exactas".
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vehicle_last_position (
  vehicle_id    TEXT PRIMARY KEY,
  route_id      TEXT,
  lat           DOUBLE PRECISION,
  lon           DOUBLE PRECISION,
  speed_kmh     DOUBLE PRECISION,
  delay_seconds INTEGER,
  next_stop_id  TEXT,
  updated_at    TIMESTAMPTZ
);
