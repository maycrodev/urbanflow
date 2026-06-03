import path from 'node:path';
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { createLogger } from '@urbanflow/shared';

const PORT = Number(process.env.PORT ?? 8090);
const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://api-gateway:8080';
const log = createLogger('dashboard');

const app = express();

// Proxy mismo-origen hacia el gateway (evita CORS en el navegador).
app.use(
  '/api',
  createProxyMiddleware({ target: GATEWAY_URL, changeOrigin: true }),
);

// Servir el panel estático.
app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => log.info(`📊 dashboard en http://localhost:${PORT} (gateway: ${GATEWAY_URL})`));
