# Diagrama de Despliegue en Nube (AWS)

Despliegue objetivo en producción. La arquitectura local (docker-compose) es un
espejo de esta topología para desarrollo y demo.

```mermaid
flowchart TB
    user([Ciudadanos / Conductores / Operadores])

    subgraph edge[Edge]
      cdn[CloudFront CDN]
      waf[AWS WAF]
    end

    subgraph aws[AWS Region]
      alb[Application Load Balancer]

      subgraph eks[Amazon EKS - Kubernetes]
        subgraph ns1[namespace mvp1-2-3-4]
          gwp[api-gateway pods]
          svcs[10 microservicios<br/>HPA por CPU/lag de Kafka]
        end
      end

      subgraph msk[Amazon MSK - Kafka]
        b1[(broker 1)]
        b2[(broker 2)]
        b3[(broker 3)]
      end

      subgraph data[Persistencia políglota gestionada]
        neo[(Neo4j Aura / EC2<br/>grafo de rutas)]
        tsdb[(Timescale Cloud / RDS<br/>telemetría)]
        rds[(Amazon RDS PostgreSQL<br/>pagos / sharing / audit)]
        ec[(Amazon ElastiCache Redis)]
      end

      s3[(Amazon S3 - Data Lake<br/>10 años histórico)]
      glue[AWS Glue + Athena<br/>ETL / consultas analíticas]
      emr[SageMaker / EMR<br/>entrenamiento modelos congestión]

      subgraph net[Conectividad legada]
        vpn[VPN / Direct Connect]
        gwntcip[Gateway NTCIP<br/>4G privada]
      end
    end

    signals[/Semáforos legados NTCIP/]
    banks[/Entidades financieras/]
    regulator[/Ente regulador/]

    user --> cdn --> waf --> alb --> gwp --> svcs
    svcs <--> msk
    svcs --> neo & tsdb & rds & ec
    tsdb -. tiering histórico .-> s3
    s3 --> glue --> emr
    emr -. baseline/modelos .-> svcs
    svcs --> vpn --> gwntcip <--> signals
    svcs --> banks
    rds -. export auditoría .-> regulator

    classDef ext fill:#2b2b2b,stroke:#888,color:#eee;
    class signals,banks,regulator ext;
```

## Decisiones de despliegue

- **Amazon EKS** con autoescalado horizontal (HPA) por CPU y por *consumer lag*
  de Kafka, para absorber los picos de 7-9 AM y 5-7 PM (>50.000 ev/s).
- **Amazon MSK** (Kafka gestionado) multi-AZ, replicación factor 3 → disponibilidad 99.95%.
- **Persistencia políglota gestionada**: RDS Multi-AZ (pagos/auditoría),
  Timescale (telemetría), Neo4j (rutas), ElastiCache (cache realtime).
- **Data Lake S3** + Glue/Athena para analítica histórica y SageMaker/EMR para
  reentrenar el modelo de predicción de congestión.
- **Gateway NTCIP** dedicado sobre VPN/Direct Connect hacia la red 4G privada
  de los semáforos (mensajes ≤256 bytes).
- **Multi-AZ + health checks + readiness/liveness** para tolerancia a fallos.
