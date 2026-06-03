import path from 'node:path';
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { createLogger } from '@urbanflow/shared';

const PORT = Number(process.env.PORT ?? 8090);
const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://api-gateway:8080';
const log = createLogger('dashboard');

const app = express();

// Proxy mismo-origen hacia el gateway (evita CORS en el navegador).
// Sin montar en '/api' (Express quitaría el prefijo); se filtra por ruta y se
// reenvía la URL COMPLETA, que es la que el gateway sabe enrutar (/api/...).
app.use(
  createProxyMiddleware({
    target: GATEWAY_URL,
    changeOrigin: true,
    pathFilter: (path) => path.startsWith('/api'),
  }),
);

// Servir el panel estático.
app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => log.info(`📊 dashboard en http://localhost:${PORT} (gateway: ${GATEWAY_URL})`));
