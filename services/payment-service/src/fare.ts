import { MultimodalRoute, TransportMode } from '@urbanflow/shared';

export interface TariffRules {
  version: string;
  baseFares: Record<string, number>;
  transferRules: {
    freeTransferWindowMin: number;
    transferDiscountPct: number;
    dailyCap: number;
  };
}

export interface FareBreakdown {
  legs: { mode: TransportMode; lineId?: string; fare: number }[];
  total: number;
}

/**
 * Calcula la tarifa de un viaje multimodal según la combinación de modos usada,
 * aplicando descuento por transbordo y tope diario (daily cap).
 *
 * Regla: el primer tramo de pago cobra tarifa completa; los siguientes tramos
 * (transbordos) reciben `transferDiscountPct` de descuento. Caminar no cuesta.
 */
export function computeFare(route: MultimodalRoute, tariff: TariffRules): FareBreakdown {
  const { baseFares, transferRules } = tariff;
  const legs: FareBreakdown['legs'] = [];
  let paidLegCount = 0;

  for (const leg of route.legs) {
    const base = baseFares[leg.mode] ?? 0;
    if (base === 0 || leg.mode === 'WALK') {
      legs.push({ mode: leg.mode, lineId: leg.lineId, fare: 0 });
      continue;
    }
    let fare = base;
    if (paidLegCount > 0) {
      fare = round(base * (1 - transferRules.transferDiscountPct / 100));
    }
    paidLegCount++;
    legs.push({ mode: leg.mode, lineId: leg.lineId, fare });
  }

  let total = round(legs.reduce((s, l) => s + l.fare, 0));
  if (transferRules.dailyCap && total > transferRules.dailyCap) {
    total = transferRules.dailyCap;
  }
  return { legs, total };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
