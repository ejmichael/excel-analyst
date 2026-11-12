/**
 * The only chart colours. Six, chosen to stay distinguishable with the common kinds of colour blindness
 * (based on the Okabe-Ito set, starting from the brand accent). Colour is never the only cue: line and area
 * series also differ by dash pattern, and every chart has a text legend, value labels where they fit, and a
 * table view.
 */
export const CHART_COLOURS = ['#1E7A5F', '#E69F00', '#0072B2', '#CC79A7', '#56B4E9', '#D55E00'] as const;

/** Line dashes per series, paired with the colours above ('' = solid). */
export const CHART_DASHES = ['', '6 3', '2 3', '8 3 2 3', '1 4', '10 4'] as const;

export const colourAt = (i: number) => CHART_COLOURS[i % CHART_COLOURS.length]!;
export const dashAt = (i: number) => CHART_DASHES[i % CHART_DASHES.length]!;
