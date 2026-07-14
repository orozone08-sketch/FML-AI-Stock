import { type Money, type Quantity, type Rate, multiplyQuantityRate } from "./scalars";

export type FifoLayer = { id: number; sourceDate: string; availableQuantity: Quantity; unitCost: Rate };
export type FifoConsumption = { layerId: number | null; quantity: Quantity; rate: Rate; value: Money; isNegativeStock: boolean };

export function allocateFifo(required: Quantity, input: readonly FifoLayer[]) {
  if (required <= 0n) throw new RangeError("Quantity must be greater than zero.");
  let remaining = required;
  const layers = input.map((layer) => ({ ...layer }));
  layers.sort((a, b) => a.sourceDate.localeCompare(b.sourceDate) || a.id - b.id);
  const consumptions: FifoConsumption[] = [];
  for (const layer of layers) {
    if (remaining === 0n) break;
    if (layer.availableQuantity <= 0n) continue;
    const take = layer.availableQuantity < remaining ? layer.availableQuantity : remaining;
    layer.availableQuantity = (layer.availableQuantity - take) as Quantity;
    consumptions.push({ layerId: layer.id, quantity: take, rate: layer.unitCost, value: multiplyQuantityRate(take, layer.unitCost), isNegativeStock: false });
    remaining = (remaining - take) as Quantity;
  }
  if (remaining > 0n) consumptions.push({ layerId: null, quantity: remaining, rate: 0n as Rate, value: 0n as Money, isNegativeStock: true });
  return { layers, consumptions, coveredCost: consumptions.reduce((sum, row) => sum + row.value, 0n) as Money, shortage: remaining };
}

export function restoreFifo(layers: readonly FifoLayer[], consumptions: readonly FifoConsumption[]) {
  const restored = layers.map((layer) => ({ ...layer }));
  const byId = new Map(restored.map((layer) => [layer.id, layer]));
  for (const consumption of consumptions) {
    if (consumption.layerId === null) continue;
    const layer = byId.get(consumption.layerId);
    if (!layer) throw new Error(`FIFO layer ${consumption.layerId} was not found.`);
    layer.availableQuantity = (layer.availableQuantity + consumption.quantity) as Quantity;
  }
  return restored;
}
