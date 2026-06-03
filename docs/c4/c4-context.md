# C4 · Nivel 1 — Diagrama de Contexto

Sistema: **Plataforma Inteligente de Movilidad Urbana (UrbanFlow)**.

```mermaid
C4Context
    title Contexto - UrbanFlow Technologies

    Person(citizen, "Ciudadano", "3.2M usuarios de transporte público/privado")
    Person(driver, "Conductor de bus", "~4.500 conductores")
    Person(operator, "Operador Centro de Control", "~200 operadores 24/7")
    Person(planner, "Autoridad / Analista urbano", "Planificación y KPIs")

    System(urbanflow, "UrbanFlow Platform", "Movilidad urbana multimodal en tiempo real: rutas, tracking, pago, semáforos, sharing, predicción y auditoría")

    System_Ext(signals, "Semáforos legados", "20 años, NTCIP sobre 4G privada, msg <=256 bytes")
    System_Ext(providers, "Proveedores de movilidad compartida", "Scooters, bicicletas, carpooling")
    System_Ext(banks, "Entidades financieras", "Liquidación del pago unificado")
    System_Ext(regulator, "Ente regulador de transporte", "Auditoría trimestral")
    System_Ext(datalake, "Data Lake (AWS S3)", "10 años de datos históricos de movilidad")

    Rel(citizen, urbanflow, "Planifica rutas, paga, recibe notificaciones", "HTTPS/Móvil")
    Rel(driver, urbanflow, "Recibe re-enrutamientos y desvíos", "App conductor")
    Rel(operator, urbanflow, "Monitorea y opera la red", "Panel de control")
    Rel(planner, urbanflow, "Consume KPIs de movilidad", "Dashboard")

    Rel(urbanflow, signals, "Prioriza buses/emergencias (bidireccional)", "NTCIP/4G")
    Rel(urbanflow, providers, "Disponibilidad, reservas, desbloqueo", "API")
    Rel(urbanflow, banks, "Cobros del pago unificado", "API pagos")
    Rel(urbanflow, regulator, "Entrega pista de auditoría", "Export/API")
    Rel(urbanflow, datalake, "Lee histórico para predicción / escribe analítica", "S3")
```

> Si tu visor de Markdown no soporta `C4Context`, el mismo contenido está descrito
> como grafo en [c4-container.md](c4-container.md).
