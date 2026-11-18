export type FormatOptions = {
  /** Group the integer part in thousands: `1,234,567`. */
  readonly thousands?: boolean;
};

/** The text of a result, as the command line prints it. */
export const formatNumber = (value: number, options: FormatOptions = {}): string => {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
  const text = String(value);
  if (options.thousands !== true || text.includes("e")) return text;
  const [integer = "", fraction] = text.split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
};
