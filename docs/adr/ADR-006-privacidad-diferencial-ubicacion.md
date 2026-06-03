# ADR-006 · Privacidad de ubicación y anonimización al finalizar el viaje

- **Estado**: Aceptada
- **Fecha**: 2026-06-02
- **Contexto del kata (NFR)**: los datos de ubicación de usuarios **solo** pueden
  usarse **durante el viaje activo** y deben **anonimizarse al finalizar**
  (privacidad diferencial).

## Decisión
- El `notification-service` mantiene el vínculo `ciudadano ↔ viaje activo` en
  Redis **con TTL**, solo mientras el viaje está en curso (`trip.started`).
- Al recibir `trip.completed`, **elimina el vínculo** (`DEL activetrip:*`) y
  notifica al usuario que su ubicación fue anonimizada.
- En el **data lake** (curated/Gold), el `citizen_id` se reemplaza por un
  **seudónimo rotado por día** y las trayectorias se **agregan** por corredor;
  no persiste la ubicación individual ligada a la identidad.
- La analítica (KPIs) opera sobre datos **agregados**, no sobre trazas personales.

## Alternativas consideradas
- **Guardar trazas completas con identidad**: incumple el NFR de privacidad.
  Rechazado.
- **Borrado físico inmediato de todo**: impediría la analítica histórica exigida.
  Se opta por **seudonimización + agregación** (privacidad diferencial) en vez de
  borrado total.

## Consecuencias
- (+) Cumple el NFR de privacidad sin perder valor analítico agregado.
- (+) Separación clara entre dato operativo (efímero) y dato analítico (anónimo).
- (−) Requiere disciplina de seudonimización en el ETL y pruebas de
  re-identificación; se documenta en el pipeline de Glue.
