# ======================================================================
# Imagen única para todos los microservicios Node/TypeScript del monorepo.
# Se construye una vez; cada contenedor sobreescribe `command:` en compose
# para arrancar su propio servicio (node services/<svc>/dist/index.js).
# ======================================================================
FROM node:20-alpine AS build
WORKDIR /app

# Instalar dependencias de todo el workspace (mejor cacheo de capas).
COPY package.json tsconfig.base.json tsconfig.json ./
COPY shared/package.json shared/
COPY services/route-planning-service/package.json services/route-planning-service/
COPY services/tracking-service/package.json services/tracking-service/
COPY services/payment-service/package.json services/payment-service/
COPY services/traffic-signal-service/package.json services/traffic-signal-service/
COPY services/sharing-service/package.json services/sharing-service/
COPY services/congestion-prediction-service/package.json services/congestion-prediction-service/
COPY services/notification-service/package.json services/notification-service/
COPY services/analytics-service/package.json services/analytics-service/
COPY services/audit-service/package.json services/audit-service/
COPY services/api-gateway/package.json services/api-gateway/
COPY dashboard/package.json dashboard/
COPY simulator/package.json simulator/
RUN npm install

# Copiar el código fuente y compilar todos los proyectos (project references).
COPY . .
RUN npm run build

# Imagen runtime delgada.
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app .
# El comando real lo define cada servicio en docker-compose.yml.
CMD ["node", "--version"]
