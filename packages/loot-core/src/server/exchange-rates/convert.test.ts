import { convertAmount } from './convert';

describe('convertAmount', () => {
  it('converts 2 -> 2 decimals', () => {
    expect(convertAmount(10000, 0.65, 2, 2)).toBe(6500);
  });

  it('converts 0 -> 2 decimals (JPY -> USD)', () => {
    expect(convertAmount(1000, 0.0067, 0, 2)).toBe(670);
  });

  it('converts 2 -> 0 decimals (USD -> JPY)', () => {
    expect(convertAmount(10000, 150, 2, 0)).toBe(15000);
  });

  it('rounds half away from zero', () => {
    expect(convertAmount(1, 0.5, 2, 2)).toBe(1);
    expect(convertAmount(-1, 0.5, 2, 2)).toBe(-1);
    expect(convertAmount(3, 0.5, 2, 2)).toBe(2);
    expect(convertAmount(-3, 0.5, 2, 2)).toBe(-2);
  });

  it('is symmetric for negatives and handles float error', () => {
    expect(convertAmount(-10050, 1.005, 2, 2)).toBe(
      -convertAmount(10050, 1.005, 2, 2),
    );
    expect(convertAmount(100, 1.005, 2, 2)).toBe(101);
  });

  it('never returns negative zero', () => {
    expect(Object.is(convertAmount(-1, 0.1, 2, 2), -0)).toBe(false);
  });
});
