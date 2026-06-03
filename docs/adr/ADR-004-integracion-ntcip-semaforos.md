# ADR-004 · Integración con semáforos legados vía NTCIP (≤256 bytes)

- **Estado**: Aceptada
- **Fecha**: 2026-06-02
- **Contexto del kata**: el sistema de semáforos tiene 20 años, habla **NTCIP**
  sobre **4G privada**, la integración debe ser **bidireccional** y cada mensaje
  no puede superar **256 bytes**.

## Decisión
Un `traffic-signal-service` actúa como **anti-corruption layer** entre el mundo
de eventos (Kafka) y el protocolo legado:
- Codifica las peticiones de prioridad en una **trama NTCIP TLV compacta** y
  **valida el límite de 256 bytes** antes de enviar (lanza error si se excede).
- Publica `signal.commands` y consume `signal.status` (ACK) → **bidireccional**.
- Detecta automáticamente buses con **retraso > 5 min** desde `gps.telemetry` y
  atiende vehículos de **emergencia** por endpoint dedicado.
- Aplica *throttling* por (vehículo, intersección) para no saturar el enlace 4G.

## Alternativas consideradas
- **Hablar NTCIP desde cada servicio**: filtra el protocolo legado por todo el
  sistema. Rechazado (se aísla en un único adaptador).
- **JSON sobre el enlace legado**: excede los 256 bytes y no es NTCIP. Rechazado.

## Consecuencias
- (+) El resto del sistema ignora NTCIP; el legado queda encapsulado.
- (+) Garantía explícita del límite de 256 bytes (testeable).
- (−) El adaptador es un punto a endurecer (reintentos, *backpressure*, salud del
  enlace 4G); se mitiga con ACKs y estado en Redis.
