// Kubernetes quantities, as the executor writes and reads them (ticket 07): CPU in millicores,
// memory in MiB. Only the forms a pod's resources and a quota use.

const SUFFIXES: Readonly<Record<string, number>> = {
  "": 1,
  m: 1e-3,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
};

/** A quantity's value in its base unit (cores, bytes), or `null` when it doesn't parse. */
export const quantityValue = (text: string): number | null => {
  const match = /^([0-9]+(?:\.[0-9]+)?)(m|k|M|G|T|Ki|Mi|Gi|Ti)?$/.exec(text.trim());
  if (match === null) return null;
  const factor = SUFFIXES[match[2] ?? ""];
  return factor === undefined ? null : Number(match[1]) * factor;
};

/** CPU as millicores, rounded down; `null` when it doesn't parse. */
export const cpuMillisOf = (text: string): number | null => {
  const value = quantityValue(text);
  return value === null ? null : Math.floor(value * 1000 + 1e-6);
};

/** Memory as MiB, rounded down; `null` when it doesn't parse. */
export const memoryMiBOf = (text: string): number | null => {
  const value = quantityValue(text);
  return value === null ? null : Math.floor(value / 1024 ** 2 + 1e-9);
};

export const cpuQuantity = (millis: number): string => `${String(Math.max(0, Math.round(millis)))}m`;
export const memoryQuantity = (mib: number): string => `${String(Math.max(0, Math.round(mib)))}Mi`;
