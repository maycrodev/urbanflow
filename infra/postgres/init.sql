-- ======================================================================
-- PostgreSQL (relacional) - Pagos, Movilidad compartida y Auditoría
-- Polyglot persistence: relacional para datos transaccionales/ACID.
-- ======================================================================

-- ----------------------------------------------------------------------
-- Esquema PAYMENT (MVP 1, inciso III - pago unificado NFC/App/QR)
-- ----------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS payment;

-- Versiones de tarifa (auditable: cambios de tarifa - MVP 4).
CREATE TABLE IF NOT EXISTS payment.tariff_version (
  version        TEXT PRIMARY KEY,
  effective_from TIMESTAMPTZ NOT NULL,
  base_fares     JSONB NOT NULL,            -- { "BUS": 2.5, "METRO": 3.0, ... }
  transfer_rules JSONB NOT NULL,            -- reglas de descuento por transbordo
  created_by     TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment.account (
  citizen_id   TEXT PRIMARY KEY,
  display_name TEXT,
  nfc_card_id  TEXT UNIQUE,
  balance      NUMERIC(12,2) NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment.transaction (
  payment_id      UUID PRIMARY KEY,
  citizen_id      TEXT NOT NULL REFERENCES payment.account(citizen_id),
  trip_id         TEXT NOT NULL,
  method          TEXT NOT NULL CHECK (method IN ('NFC_CARD','MOBILE_APP','QR')),
  legs            JSONB NOT NULL,
  total_charged   NUMERIC(12,2) NOT NULL,
  tariff_version  TEXT NOT NULL REFERENCES payment.tariff_version(version),
  status          TEXT NOT NULL CHECK (status IN ('AUTHORIZED','SETTLED','DECLINED')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_txn_citizen ON payment.transaction(citizen_id);
CREATE INDEX IF NOT EXISTS idx_txn_trip ON payment.transaction(trip_id);

-- ----------------------------------------------------------------------
-- Esquema SHARING (MVP 2, inciso V - scooters/bicicletas)
-- ----------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS sharing;

CREATE TABLE IF NOT EXISTS sharing.vehicle (
  vehicle_id   TEXT PRIMARY KEY,
  type         TEXT NOT NULL CHECK (type IN ('SCOOTER','BIKE')),
  status       TEXT NOT NULL DEFAULT 'AVAILABLE'
                 CHECK (status IN ('AVAILABLE','RESERVED','IN_USE','MAINTENANCE','DAMAGED')),
  station_id   TEXT,
  lat          DOUBLE PRECISION,
  lon          DOUBLE PRECISION,
  battery_pct  INTEGER DEFAULT 100,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vehicle_status ON sharing.vehicle(status);
CREATE INDEX IF NOT EXISTS idx_vehicle_station ON sharing.vehicle(station_id);

CREATE TABLE IF NOT EXISTS sharing.reservation (
  reservation_id UUID PRIMARY KEY,
  vehicle_id     TEXT NOT NULL REFERENCES sharing.vehicle(vehicle_id),
  citizen_id     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'ACTIVE'
                   CHECK (status IN ('ACTIVE','UNLOCKED','COMPLETED','CANCELLED')),
  reserved_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  ended_at       TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sharing.damage_report (
  report_id   UUID PRIMARY KEY,
  vehicle_id  TEXT NOT NULL REFERENCES sharing.vehicle(vehicle_id),
  citizen_id  TEXT,
  note        TEXT NOT NULL,
  reported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------
-- Esquema AUDIT (MVP 4 - trazabilidad regulatoria, append-only)
-- Cadena de hashes para detectar manipulación (tamper-evidence).
-- ----------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE IF NOT EXISTS audit.event_log (
  audit_id       UUID PRIMARY KEY,
  seq            BIGSERIAL UNIQUE,          -- orden monotónico real de inserción (cadena)
  category       TEXT NOT NULL CHECK (category IN ('REROUTE','TARIFF_CHANGE','SIGNAL_PRIORITY','PAYMENT')),
  correlation_id TEXT NOT NULL,
  actor          TEXT NOT NULL,
  prev_hash      TEXT NOT NULL,
  hash           TEXT NOT NULL,
  occurred_at    TIMESTAMPTZ NOT NULL,
  recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload        JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_category ON audit.event_log(category);
CREATE INDEX IF NOT EXISTS idx_audit_correlation ON audit.event_log(correlation_id);
CREATE INDEX IF NOT EXISTS idx_audit_occurred ON audit.event_log(occurred_at);

-- Bloquear UPDATE/DELETE sobre el log de auditoría (append-only real).
CREATE OR REPLACE FUNCTION audit.prevent_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit.event_log es append-only: % no permitido', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_no_update ON audit.event_log;
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE OR DELETE ON audit.event_log
  FOR EACH ROW EXECUTE FUNCTION audit.prevent_mutation();

-- ----------------------------------------------------------------------
-- Datos semilla
-- ----------------------------------------------------------------------
INSERT INTO payment.tariff_version (version, effective_from, base_fares, transfer_rules, created_by)
VALUES (
  'v2026.1',
  '2026-01-01T00:00:00Z',
  '{"BUS": 2.50, "METRO": 3.00, "SCOOTER": 1.50, "BIKE": 1.00, "CARPOOL": 4.00, "WALK": 0}',
  '{"freeTransferWindowMin": 60, "transferDiscountPct": 50, "dailyCap": 12.00}',
  'system'
) ON CONFLICT (version) DO NOTHING;

INSERT INTO payment.account (citizen_id, display_name, nfc_card_id, balance) VALUES
  ('citizen-001', 'Ana Gómez',   'NFC-0001', 50.00),
  ('citizen-002', 'Luis Pérez',  'NFC-0002', 12.50),
  ('citizen-003', 'María Rojas', 'NFC-0003', 100.00)
ON CONFLICT (citizen_id) DO NOTHING;

INSERT INTO sharing.vehicle (vehicle_id, type, status, station_id, lat, lon, battery_pct) VALUES
  ('SCO-1001','SCOOTER','AVAILABLE','ST-CENTRO', -16.5000, -68.1500, 92),
  ('SCO-1002','SCOOTER','AVAILABLE','ST-CENTRO', -16.5002, -68.1498, 80),
  ('SCO-1003','SCOOTER','AVAILABLE','ST-SUR',    -16.5400, -68.1200, 65),
  ('BIK-2001','BIKE','AVAILABLE','ST-CENTRO',    -16.5001, -68.1502, 100),
  ('BIK-2002','BIKE','AVAILABLE','ST-NORTE',     -16.4800, -68.1300, 100)
ON CONFLICT (vehicle_id) DO NOTHING;

-- Registro génesis de la cadena de auditoría.
INSERT INTO audit.event_log (audit_id, category, correlation_id, actor, prev_hash, hash, occurred_at, payload)
VALUES (
  '00000000-0000-0000-0000-000000000000',
  'TARIFF_CHANGE', 'genesis', 'system',
  'GENESIS',
  'GENESIS',
  '2026-01-01T00:00:00Z',
  '{"note": "genesis block - inicio de la cadena de trazabilidad"}'
) ON CONFLICT (audit_id) DO NOTHING;
