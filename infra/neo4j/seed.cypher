// ======================================================================
// Neo4j (grafo) - Red de transporte multimodal para planificación de rutas
// Polyglot persistence: grafo para cálculo de rutas óptimas (MVP 1, I).
//
// Modelo:
//   (:Stop {id, name, lat, lon, modes})
//   -[:CONNECTS {mode, lineId, durationMin, cost, carbonGramsPerKm, distanceM}]->
// El costo en carbono se modela por gramos/km segun el modo (BUS/METRO/etc).
// ======================================================================

// Limpieza idempotente del grafo de transporte.
MATCH (n:Stop) DETACH DELETE n;

// --- Paradas / estaciones ---
CREATE (centro:Stop {id:'ST-CENTRO', name:'Plaza Central',  lat:-16.5000, lon:-68.1500, modes:['BUS','METRO','SCOOTER','BIKE']})
CREATE (norte:Stop  {id:'ST-NORTE',  name:'Terminal Norte',  lat:-16.4800, lon:-68.1300, modes:['BUS','METRO','BIKE']})
CREATE (sur:Stop    {id:'ST-SUR',    name:'Terminal Sur',    lat:-16.5400, lon:-68.1200, modes:['BUS','SCOOTER']})
CREATE (este:Stop   {id:'ST-ESTE',   name:'Mercado Este',    lat:-16.5050, lon:-68.1100, modes:['BUS','SCOOTER','BIKE']})
CREATE (oeste:Stop  {id:'ST-OESTE',  name:'Universidad Oeste',lat:-16.5020, lon:-68.1800, modes:['BUS','METRO']})
CREATE (m1:Stop     {id:'M-1',       name:'Metro Línea Roja 1',lat:-16.4950, lon:-68.1450, modes:['METRO']})
CREATE (m2:Stop     {id:'M-2',       name:'Metro Línea Roja 2',lat:-16.4900, lon:-68.1400, modes:['METRO']})

// --- Conexiones BUS (corredores) ---
CREATE (centro)-[:CONNECTS {mode:'BUS', lineId:'B-101', durationMin:12, cost:2.50, carbonGramsPerKm:68, distanceM:3200}]->(norte)
CREATE (norte)-[:CONNECTS {mode:'BUS', lineId:'B-101', durationMin:12, cost:2.50, carbonGramsPerKm:68, distanceM:3200}]->(centro)
CREATE (centro)-[:CONNECTS {mode:'BUS', lineId:'B-202', durationMin:15, cost:2.50, carbonGramsPerKm:68, distanceM:4500}]->(sur)
CREATE (sur)-[:CONNECTS {mode:'BUS', lineId:'B-202', durationMin:15, cost:2.50, carbonGramsPerKm:68, distanceM:4500}]->(centro)
CREATE (centro)-[:CONNECTS {mode:'BUS', lineId:'B-303', durationMin:10, cost:2.50, carbonGramsPerKm:68, distanceM:3000}]->(este)
CREATE (este)-[:CONNECTS  {mode:'BUS', lineId:'B-303', durationMin:10, cost:2.50, carbonGramsPerKm:68, distanceM:3000}]->(centro)
CREATE (centro)-[:CONNECTS {mode:'BUS', lineId:'B-404', durationMin:14, cost:2.50, carbonGramsPerKm:68, distanceM:4000}]->(oeste)
CREATE (oeste)-[:CONNECTS {mode:'BUS', lineId:'B-404', durationMin:14, cost:2.50, carbonGramsPerKm:68, distanceM:4000}]->(centro)

// --- Conexiones METRO (rápidas, bajas emisiones) ---
CREATE (centro)-[:CONNECTS {mode:'METRO', lineId:'L-ROJA', durationMin:6, cost:3.00, carbonGramsPerKm:14, distanceM:2500}]->(m1)
CREATE (m1)-[:CONNECTS  {mode:'METRO', lineId:'L-ROJA', durationMin:6, cost:3.00, carbonGramsPerKm:14, distanceM:2500}]->(centro)
CREATE (m1)-[:CONNECTS  {mode:'METRO', lineId:'L-ROJA', durationMin:4, cost:3.00, carbonGramsPerKm:14, distanceM:1800}]->(m2)
CREATE (m2)-[:CONNECTS  {mode:'METRO', lineId:'L-ROJA', durationMin:4, cost:3.00, carbonGramsPerKm:14, distanceM:1800}]->(m1)
CREATE (m2)-[:CONNECTS  {mode:'METRO', lineId:'L-ROJA', durationMin:7, cost:3.00, carbonGramsPerKm:14, distanceM:2800}]->(norte)
CREATE (norte)-[:CONNECTS {mode:'METRO', lineId:'L-ROJA', durationMin:7, cost:3.00, carbonGramsPerKm:14, distanceM:2800}]->(m2)

// --- Conexiones SCOOTER (última milla, cero emisiones de uso) ---
CREATE (centro)-[:CONNECTS {mode:'SCOOTER', lineId:'micro', durationMin:8, cost:1.50, carbonGramsPerKm:0, distanceM:1500}]->(este)
CREATE (este)-[:CONNECTS  {mode:'SCOOTER', lineId:'micro', durationMin:8, cost:1.50, carbonGramsPerKm:0, distanceM:1500}]->(centro)
CREATE (sur)-[:CONNECTS   {mode:'SCOOTER', lineId:'micro', durationMin:9, cost:1.50, carbonGramsPerKm:0, distanceM:1700}]->(centro)

// --- Conexiones BIKE / ciclovías ---
CREATE (centro)-[:CONNECTS {mode:'BIKE', lineId:'ciclo', durationMin:11, cost:1.00, carbonGramsPerKm:0, distanceM:2000}]->(norte)
CREATE (norte)-[:CONNECTS {mode:'BIKE', lineId:'ciclo', durationMin:11, cost:1.00, carbonGramsPerKm:0, distanceM:2000}]->(centro)
CREATE (este)-[:CONNECTS  {mode:'BIKE', lineId:'ciclo', durationMin:9, cost:1.00, carbonGramsPerKm:0, distanceM:1600}]->(norte)

// --- Conexiones WALK (caminata, conecta nodos cercanos) ---
CREATE (centro)-[:CONNECTS {mode:'WALK', lineId:'walk', durationMin:5, cost:0, carbonGramsPerKm:0, distanceM:400}]->(m1)
CREATE (m1)-[:CONNECTS  {mode:'WALK', lineId:'walk', durationMin:5, cost:0, carbonGramsPerKm:0, distanceM:400}]->(centro);

CREATE INDEX stop_id IF NOT EXISTS FOR (s:Stop) ON (s.id);
