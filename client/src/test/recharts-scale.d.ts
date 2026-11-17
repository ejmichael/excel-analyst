/** The chart library's tick generator, used by tests to check the ticks a value axis draws. */
declare module 'recharts/lib/util/scale/getNiceTickValues' {
  export function getNiceTickValues(domain: [number, number], tickCount?: number, allowDecimals?: boolean): number[];
}
