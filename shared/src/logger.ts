import pino from 'pino';

/**
 * Logger estructurado (JSON) por servicio. En desarrollo usa pino-pretty.
 */
export function createLogger(service: string) {
  const level = process.env.LOG_LEVEL ?? 'info';
  const isDev = process.env.NODE_ENV !== 'production';
  return pino({
    level,
    base: { service },
    transport: isDev
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } }
      : undefined,
  });
}

export type Logger = ReturnType<typeof createLogger>;
