import express, { Express, Request, Response, NextFunction } from 'express';
import { EventBus } from './kafka';
import { Logger } from './logger';

export interface ServiceContext {
  app: Express;
  bus: EventBus;
  log: Logger;
  port: number;
}

/**
 * Bootstrap común de un microservicio HTTP:
 *  - Express con JSON
 *  - /health (liveness)
 *  - log de cada request
 *  - conexión al EventBus
 *  - apagado ordenado (SIGTERM/SIGINT)
 *
 * `setup(ctx)` registra rutas y consumidores; luego este helper levanta el server.
 */
export async function createService(opts: {
  name: string;
  port: number;
  setup: (ctx: ServiceContext) => Promise<void> | void;
}): Promise<ServiceContext> {
  const bus = new EventBus({ service: opts.name });
  const log = bus.log;
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.use((req: Request, _res: Response, next: NextFunction) => {
    log.debug({ method: req.method, path: req.path }, 'request');
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: opts.name, ts: new Date().toISOString() });
  });

  await bus.connect();
  const ctx: ServiceContext = { app, bus, log, port: opts.port };
  await opts.setup(ctx);

  // Error handler al final del stack.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log.error({ err }, 'unhandled error');
    res.status(500).json({ error: err.message });
  });

  const server = app.listen(opts.port, () => {
    log.info(`🚦 ${opts.name} escuchando en :${opts.port}`);
  });

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'apagando servicio...');
    server.close();
    await bus.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  return ctx;
}
