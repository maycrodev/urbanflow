import neo4j, { Driver } from 'neo4j-driver';
import { MultimodalRoute, RouteLeg, TransportMode } from '@urbanflow/shared';

interface Edge {
  from: string;
  to: string;
  mode: TransportMode;
  lineId: string;
  durationMin: number;
  cost: number;
  carbonGramsPerKm: number;
  distanceM: number;
}

const SEED_STOPS = [
  { id: 'ST-CENTRO', name: 'Plaza Central', lat: -16.5, lon: -68.15, modes: ['BUS', 'METRO', 'SCOOTER', 'BIKE'] },
  { id: 'ST-NORTE', name: 'Terminal Norte', lat: -16.48, lon: -68.13, modes: ['BUS', 'METRO', 'BIKE'] },
  { id: 'ST-SUR', name: 'Terminal Sur', lat: -16.54, lon: -68.12, modes: ['BUS', 'SCOOTER'] },
  { id: 'ST-ESTE', name: 'Mercado Este', lat: -16.505, lon: -68.11, modes: ['BUS', 'SCOOTER', 'BIKE'] },
  { id: 'ST-OESTE', name: 'Universidad Oeste', lat: -16.502, lon: -68.18, modes: ['BUS', 'METRO'] },
  { id: 'M-1', name: 'Metro Línea Roja 1', lat: -16.495, lon: -68.145, modes: ['METRO'] },
  { id: 'M-2', name: 'Metro Línea Roja 2', lat: -16.49, lon: -68.14, modes: ['METRO'] },
];

// Aristas dirigidas (mode, duración, costo, carbono/km, distancia).
const SEED_EDGES: Edge[] = [
  e('ST-CENTRO', 'ST-NORTE', 'BUS', 'B-101', 12, 2.5, 68, 3200),
  e('ST-NORTE', 'ST-CENTRO', 'BUS', 'B-101', 12, 2.5, 68, 3200),
  e('ST-CENTRO', 'ST-SUR', 'BUS', 'B-202', 15, 2.5, 68, 4500),
  e('ST-SUR', 'ST-CENTRO', 'BUS', 'B-202', 15, 2.5, 68, 4500),
  e('ST-CENTRO', 'ST-ESTE', 'BUS', 'B-303', 10, 2.5, 68, 3000),
  e('ST-ESTE', 'ST-CENTRO', 'BUS', 'B-303', 10, 2.5, 68, 3000),
  e('ST-CENTRO', 'ST-OESTE', 'BUS', 'B-404', 14, 2.5, 68, 4000),
  e('ST-OESTE', 'ST-CENTRO', 'BUS', 'B-404', 14, 2.5, 68, 4000),
  e('ST-CENTRO', 'M-1', 'METRO', 'L-ROJA', 6, 3.0, 14, 2500),
  e('M-1', 'ST-CENTRO', 'METRO', 'L-ROJA', 6, 3.0, 14, 2500),
  e('M-1', 'M-2', 'METRO', 'L-ROJA', 4, 3.0, 14, 1800),
  e('M-2', 'M-1', 'METRO', 'L-ROJA', 4, 3.0, 14, 1800),
  e('M-2', 'ST-NORTE', 'METRO', 'L-ROJA', 7, 3.0, 14, 2800),
  e('ST-NORTE', 'M-2', 'METRO', 'L-ROJA', 7, 3.0, 14, 2800),
  e('ST-CENTRO', 'ST-ESTE', 'SCOOTER', 'micro', 8, 1.5, 0, 1500),
  e('ST-ESTE', 'ST-CENTRO', 'SCOOTER', 'micro', 8, 1.5, 0, 1500),
  e('ST-SUR', 'ST-CENTRO', 'SCOOTER', 'micro', 9, 1.5, 0, 1700),
  e('ST-CENTRO', 'ST-NORTE', 'BIKE', 'ciclo', 11, 1.0, 0, 2000),
  e('ST-NORTE', 'ST-CENTRO', 'BIKE', 'ciclo', 11, 1.0, 0, 2000),
  e('ST-ESTE', 'ST-NORTE', 'BIKE', 'ciclo', 9, 1.0, 0, 1600),
  e('ST-CENTRO', 'M-1', 'WALK', 'walk', 5, 0, 0, 400),
  e('M-1', 'ST-CENTRO', 'WALK', 'walk', 5, 0, 0, 400),
];

function e(
  from: string,
  to: string,
  mode: TransportMode,
  lineId: string,
  durationMin: number,
  cost: number,
  carbonGramsPerKm: number,
  distanceM: number,
): Edge {
  return { from, to, mode, lineId, durationMin, cost, carbonGramsPerKm, distanceM };
}

export class RouteGraph {
  private driver: Driver;

  constructor() {
    const uri = process.env.NEO4J_URI ?? 'bolt://localhost:7687';
    const user = process.env.NEO4J_USER ?? 'neo4j';
    const pass = process.env.NEO4J_PASSWORD ?? 'urbanflow_secret';
    this.driver = neo4j.driver(uri, neo4j.auth.basic(user, pass));
  }

  /** Crea el grafo de transporte si aún no existe (idempotente). */
  async seed(): Promise<void> {
    const session = this.driver.session();
    try {
      const res = await session.run('MATCH (s:Stop) RETURN count(s) AS n');
      const count = res.records[0].get('n').toNumber();
      if (count > 0) return;

      await session.run(
        `UNWIND $stops AS s
         CREATE (n:Stop {id: s.id, name: s.name, lat: s.lat, lon: s.lon, modes: s.modes})`,
        { stops: SEED_STOPS },
      );
      await session.run(
        `UNWIND $edges AS e
         MATCH (a:Stop {id: e.from}), (b:Stop {id: e.to})
         CREATE (a)-[:CONNECTS {mode: e.mode, lineId: e.lineId, durationMin: e.durationMin,
                                cost: e.cost, carbonGramsPerKm: e.carbonGramsPerKm, distanceM: e.distanceM}]->(b)`,
        { edges: SEED_EDGES },
      );
      await session.run('CREATE INDEX stop_id IF NOT EXISTS FOR (s:Stop) ON (s.id)');
    } finally {
      await session.close();
    }
  }

  /** Lee todas las aristas desde Neo4j para el cálculo de rutas. */
  private async loadEdges(): Promise<Edge[]> {
    const session = this.driver.session();
    try {
      const res = await session.run(
        `MATCH (a:Stop)-[c:CONNECTS]->(b:Stop)
         RETURN a.id AS from, b.id AS to, c.mode AS mode, c.lineId AS lineId,
                c.durationMin AS durationMin, c.cost AS cost,
                c.carbonGramsPerKm AS carbonGramsPerKm, c.distanceM AS distanceM`,
      );
      return res.records.map((r) => ({
        from: r.get('from'),
        to: r.get('to'),
        mode: r.get('mode') as TransportMode,
        lineId: r.get('lineId'),
        durationMin: toNum(r.get('durationMin')),
        cost: toNum(r.get('cost')),
        carbonGramsPerKm: toNum(r.get('carbonGramsPerKm')),
        distanceM: toNum(r.get('distanceM')),
      }));
    } finally {
      await session.close();
    }
  }

  async listStops(): Promise<{ id: string; name: string }[]> {
    const session = this.driver.session();
    try {
      const res = await session.run('MATCH (s:Stop) RETURN s.id AS id, s.name AS name ORDER BY id');
      return res.records.map((r) => ({ id: r.get('id'), name: r.get('name') }));
    } finally {
      await session.close();
    }
  }

  /**
   * Planifica rutas multimodales óptimas con 3 criterios (Dijkstra):
   *  FASTEST (tiempo), CHEAPEST (costo), GREENEST (huella de carbono).
   * Devuelve las opciones distintas encontradas.
   */
  async plan(fromStopId: string, toStopId: string): Promise<MultimodalRoute[]> {
    const edges = await this.loadEdges();
    const adj = new Map<string, Edge[]>();
    for (const ed of edges) {
      if (!adj.has(ed.from)) adj.set(ed.from, []);
      adj.get(ed.from)!.push(ed);
    }

    const criteria: MultimodalRoute['optimizedFor'][] = ['FASTEST', 'CHEAPEST', 'GREENEST'];
    const weightOf = (ed: Edge, c: MultimodalRoute['optimizedFor']): number => {
      if (c === 'FASTEST') return ed.durationMin;
      if (c === 'CHEAPEST') return ed.cost + ed.durationMin * 0.001; // desempate por tiempo
      return carbonGrams(ed) + ed.durationMin * 0.001; // GREENEST
    };

    const seen = new Set<string>();
    const routes: MultimodalRoute[] = [];
    for (const c of criteria) {
      const path = dijkstra(adj, fromStopId, toStopId, (ed) => weightOf(ed, c));
      if (!path) continue;
      const legs = path.map(toLeg);
      const key = legs.map((l) => `${l.mode}:${l.lineId}:${l.fromStopId}->${l.toStopId}`).join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      routes.push({
        routeOptionId: `${c.toLowerCase()}-${routes.length + 1}`,
        legs,
        totalDurationMin: round(legs.reduce((s, l) => s + l.durationMin, 0)),
        totalCost: round(legs.reduce((s, l) => s + l.cost, 0)),
        totalCarbonGrams: round(legs.reduce((s, l) => s + l.carbonGrams, 0)),
        optimizedFor: c,
      });
    }
    return routes;
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}

// --- helpers ---

function carbonGrams(ed: Edge): number {
  return (ed.carbonGramsPerKm * ed.distanceM) / 1000;
}

function toLeg(ed: Edge): RouteLeg {
  return {
    mode: ed.mode,
    fromStopId: ed.from,
    toStopId: ed.to,
    lineId: ed.lineId,
    durationMin: ed.durationMin,
    cost: ed.cost,
    carbonGrams: round(carbonGrams(ed)),
    distanceM: ed.distanceM,
  };
}

function dijkstra(
  adj: Map<string, Edge[]>,
  start: string,
  goal: string,
  weight: (e: Edge) => number,
): Edge[] | null {
  const dist = new Map<string, number>();
  const prevEdge = new Map<string, Edge>();
  const pq: { node: string; d: number }[] = [{ node: start, d: 0 }];
  dist.set(start, 0);

  while (pq.length) {
    pq.sort((a, b) => a.d - b.d);
    const { node, d } = pq.shift()!;
    if (node === goal) break;
    if (d > (dist.get(node) ?? Infinity)) continue;
    for (const ed of adj.get(node) ?? []) {
      const nd = d + weight(ed);
      if (nd < (dist.get(ed.to) ?? Infinity)) {
        dist.set(ed.to, nd);
        prevEdge.set(ed.to, ed);
        pq.push({ node: ed.to, d: nd });
      }
    }
  }

  if (!dist.has(goal)) return null;
  const path: Edge[] = [];
  let cur = goal;
  while (cur !== start) {
    const ed = prevEdge.get(cur);
    if (!ed) return null;
    path.unshift(ed);
    cur = ed.from;
  }
  return path;
}

function toNum(v: unknown): number {
  if (typeof v === 'number') return v;
  if (v && typeof (v as { toNumber?: () => number }).toNumber === 'function') {
    return (v as { toNumber: () => number }).toNumber();
  }
  return Number(v);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
