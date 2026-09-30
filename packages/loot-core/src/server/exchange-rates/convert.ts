/**
 * Convert an integer amount in minor units of `from` into integer minor units
 * of `to`, using `rate` (units of `to` per one unit of `from`).
 *
 * Rounding rule: half away from zero (symmetric for negatives), so
 * convertAmount(-x) === -convertAmount(x).
 */
export function convertAmount(
  amount: number,
  rate: number,
  fromDecimals: number,
  toDecimals: number,
): number {
  const converted = (amount / 10 ** fromDecimals) * rate * 10 ** toDecimals;
  // Tiny epsilon guards against float error such as 1.005 * 100 = 100.49999...
  const rounded = Math.round(Math.abs(converted) * (1 + Number.EPSILON));
  return converted < 0 && rounded !== 0 ? -rounded : rounded;
}
