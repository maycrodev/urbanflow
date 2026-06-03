import type { ServerResponse } from 'node:http';
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { createLogger } from '@urbanflow/shared';

const PORT = Number(process.env.PORT ?? 8080);
const log = createLogger('api-gateway');

/**
 * api-gateway
 * Punto único de entrada (BFF). Enruta a cada microservicio y centraliza
 * CORS, health agregado y logging. No toca Kafka: solo HTTP norte-sur.
 */
const TARGETS: Record<string, { target: string; label: string }> = {
  '/api/routing': { target: env('ROUTE_PLANNING_URL', 'http://route-planning-service:3001'), label: 'route-planning' },
  '/api/tracking': { target: env('TRACKING_URL', 'http://tracking-service:3002'), label: 'tracking' },
  '/api/payment': { target: env('PAYMENT_URL', 'http://payment-service:3003'), label: 'payment' },
  '/api/signals': { target: env('TRAFFIC_SIGNAL_URL', 'http://traffic-signal-service:3004'), label: 'traffic-signal' },
  '/api/sharing': { target: env('SHARING_URL', 'http://sharing-service:3005'), label: 'sharing' },
  '/api/congestion': { target: env('CONGESTION_URL', 'http://congestion-prediction-service:3006'), label: 'congestion' },
  '/api/notifications': { target: env('NOTIFICATION_URL', 'http://notification-service:3007'), label: 'notification' },
  '/api/analytics': { target: env('ANALYTICS_URL', 'http://analytics-service:3008'), label: 'analytics' },
  '/api/audit': { target: env('AUDIT_URL', 'http://audit-service:3009'), label: 'audit' },
};

function env(name: string, def: string): string {
  return process.env[name] ?? def;
}

const app = express();

// CORS abierto (demo).
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'api-gateway' }));

// Mapa de servicios para descubrimiento.
app.get('/api', (_req, res) => {
  res.json({
    gateway: 'urbanflow-api-gateway',
    routes: Object.entries(TARGETS).map(([prefix, t]) => ({ prefix, service: t.label })),
  });
});

for (const [prefix, { target, label }] of Object.entries(TARGETS)) {
  app.use(
    prefix,
    createProxyMiddleware({
      target,
      changeOrigin: true,
      pathRewrite: { [`^${prefix}`]: '' },
      ws: true,
      on: {
        error: (err, _req, res) => {
          log.error({ err: String(err), service: label }, 'proxy error');
          if (res && 'writeHead' in res) {
            const sr = res as ServerResponse;
            if (!sr.headersSent) {
              sr.writeHead(502, { 'Content-Type': 'application/json' });
              sr.end(JSON.stringify({ error: `servicio ${label} no disponible` }));
            }
          }
        },
      },
    }),
  );
}

app.listen(PORT, () => log.info(`🌐 api-gateway escuchando en :${PORT}`));
