export type ProviderResult = {
  /** Only published business days within [startDate, endDate]. */
  rates: Array<{ date: string; rate: number }>;
  /** Most recent date the provider has published for this pair. */
  latestDate: string;
  /** First date the provider has data for this pair. */
  earliestDate: string;
};

export type ExchangeRateProvider = {
  name: string;
  supports(base: string, quote: string): boolean;
  getRates(
    base: string,
    quote: string,
    startDate: string,
    endDate: string,
  ): Promise<ProviderResult>;
};
