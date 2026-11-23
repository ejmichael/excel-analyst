import { cloneElement, useId, useMemo, useState, type ReactElement } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { BarChart3, Table2 } from 'lucide-react';
import type { Block, ValueFormat } from '@/api/types';
import { Button } from '@/components/ui/button';
import { formatNumber, formatValue } from '@/lib/format';
import { buildChartModel, formatOf, groupKeyColumns, shortLabel, valueAxis, wrapLabel, type ChartModel } from './chartData';
import { SERIES_COLOURS, colourAt, dashAt, fillAt, hatchId, isHatched, swatchAt } from './chartPalette';
import { ResultTable } from './ResultTable';

const TYPE_NAMES: Record<ChartModel['kind'] | 'bar' | 'line' | 'area', string> = {
  empty: 'Result',
  table: 'Table',
  kpi: 'Single value',
  pie: 'Pie chart',
  cartesian: 'Chart',
  bar: 'Bar chart',
  line: 'Line chart',
  area: 'Area chart',
};

/** Labels on bars and points only where they fit without overlapping. */
const MAX_LABELLED_VALUES = 12;

const AXIS_TICK = { fontSize: 12, fill: 'var(--muted-foreground)' };

/** Roughly the width of one 12px character, used to fit a category label under its bar. */
const TICK_CHAR_PX = 7.5;

/** Bar charts with at most this many bars label every bar; denser axes let Recharts skip labels that would overlap. */
export const LABEL_EVERY_BAR_UP_TO = 8;

/** Which category labels the x axis shows: every bar on a short bar chart, otherwise the ones that fit. */
export function categoryInterval(type: string, count: number): 0 | 'preserveStartEnd' {
  return type === 'bar' && count <= LABEL_EVERY_BAR_UP_TO ? 0 : 'preserveStartEnd';
}

/** How many characters of a category label fit under its bar (4 to 14), from the axis width and the tick count. */
export function categoryLabelMax(width?: number, ticks?: number): number {
  if (!width || !ticks) return 14;
  return Math.max(4, Math.min(14, width / ticks / TICK_CHAR_PX));
}

/** A category tick that is cut short but keeps the full text as a hover/focus title. */
function CategoryTick(props: {
  x?: number;
  y?: number;
  payload?: { value: string };
  textAnchor?: 'start' | 'middle' | 'end';
  horizontal?: boolean;
  /** Passed by Recharts: the axis width and the number of ticks shown, so a label can fit its slot. */
  width?: number;
  visibleTicksCount?: number;
  /** A report document's horizontal bars: wrap the label at about this many characters. */
  wrapAt?: number;
}) {
  const full = String(props.payload?.value ?? '');
  if (props.wrapAt) {
    // A report document: up to two lines in the label column, then an ellipsis.
    const lines = wrapLabel(full, props.wrapAt);
    return (
      <text x={props.x} y={props.y} textAnchor="end" fontSize={11} fill="var(--muted-foreground)">
        <title>{full}</title>
        {lines.map((line, i) => (
          // The block of lines is centred on the bar.
          <tspan key={i} x={props.x} dy={i === 0 ? (lines.length === 1 ? 4 : -2) : 13}>
            {line}
          </tspan>
        ))}
      </text>
    );
  }
  const max = props.horizontal ? 16 : categoryLabelMax(props.width, props.visibleTicksCount);
  return (
    <text
      x={props.x}
      y={props.y}
      dy={props.horizontal ? 4 : 14}
      textAnchor={props.horizontal ? 'end' : 'middle'}
      fontSize={12}
      fill="var(--muted-foreground)"
    >
      <title>{full}</title>
      {shortLabel(full, max)}
    </text>
  );
}

/**
 * 'document': the shared report page on screen. 'print': a report while it prints, drawn at the A4 content width with
 * a height that lets two chart answers share a page.
 */
export type ChartLook = 'app' | 'document' | 'print';

/** CSS pixels per millimetre (96 dpi). */
const PX_PER_MM = 96 / 25.4;

/** A4 (210mm) less the 16mm side margins of a printed report. */
export const PRINT_CHART_WIDTH = 178 * PX_PER_MM;

/**
 * A printed chart's height: about 5mm per category for horizontal bars (plus room for the axis), at most 95mm; a
 * vertical bar, line or area chart at most 75mm. Layout only.
 */
export function printChartHeight(horizontal: boolean, categories: number): number {
  return horizontal ? Math.min(95, categories * 5 + 16) * PX_PER_MM : 75 * PX_PER_MM;
}

/** An id usable in url(#…): React's ids contain characters that are not. */
const svgId = (id: string) => `c${id.replace(/[^a-zA-Z0-9]/g, '')}`;

/** Hatch patterns for series past the tenth: a palette colour with white diagonal stripes at a different angle each. */
function HatchDefs({ chartId, count }: { chartId: string; count: number }) {
  const hatched = Array.from({ length: count }, (_, i) => i).filter(isHatched);
  if (hatched.length === 0) return null;
  return (
    <defs>
      {hatched.map((i) => (
        <pattern key={i} id={hatchId(chartId, i)} patternUnits="userSpaceOnUse" width={6} height={6} patternTransform={`rotate(${45 + (i - SERIES_COLOURS) * 35})`}>
          <rect width={6} height={6} fill={colourAt(i)} />
          <line x1={0} y1={0} x2={0} y2={6} stroke="#ffffff" strokeWidth={2} />
        </pattern>
      ))}
    </defs>
  );
}

/** On a report document, the category labels of horizontal bars get about this share of the chart's width. */
export const DOCUMENT_LABEL_SHARE = 0.36;

/** Takes the parts of an answer it draws, so a dashboard widget's result can use it too. */
export function BlockChart({ block, look = 'app' }: { block: Pick<Block, 'title' | 'chart' | 'columns' | 'rows'>; look?: ChartLook }) {
  const model = useMemo(() => buildChartModel(block), [block]);
  const keys = useMemo(() => groupKeyColumns(block), [block]);
  const [asTable, setAsTable] = useState(model.kind === 'table');
  const tableId = useId();
  const rowsShown = block.rows.length;
  const rowsText = `${formatNumber(rowsShown, 0)} ${rowsShown === 1 ? 'row' : 'rows'}`;
  const typeName =
    model.kind === 'cartesian' ? TYPE_NAMES[model.type] : TYPE_NAMES[model.kind];
  const ariaLabel = `${typeName}: ${block.title}, ${rowsText}`;

  if (model.kind === 'empty') {
    return <p className="rounded-lg border border-dashed bg-background p-4 text-sm">This question returned no rows, so there is nothing to show.</p>;
  }

  const table = (
    <ResultTable
      columns={block.columns.map((c) => ({ name: c.name, format: formatOf(block, c.name), key: keys.has(c.name) }))}
      rows={block.rows.slice(0, 500)}
      label={`Table: ${block.title}, ${rowsText}`}
    />
  );

  return (
    <div className="space-y-3">
      {model.kind !== 'table' && (
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            aria-pressed={asTable}
            aria-controls={tableId}
            onClick={() => setAsTable((v) => !v)}
          >
            {asTable ? <BarChart3 aria-hidden /> : <Table2 aria-hidden />}
            {asTable ? 'View as chart' : 'View as table'}
          </Button>
        </div>
      )}
      <div id={tableId}>{asTable || model.kind === 'table' ? table : <ChartView model={model} ariaLabel={ariaLabel} look={look} />}</div>
    </div>
  );
}

function ChartView({ model, ariaLabel, look }: { model: Exclude<ChartModel, { kind: 'empty' } | { kind: 'table' }>; ariaLabel: string; look: ChartLook }) {
  if (model.kind === 'kpi') {
    return (
      <div role="img" aria-label={`${ariaLabel}. ${model.label}: ${formatValue(model.value, model.format)}`} data-kpi className="rounded-lg border bg-background p-5">
        <p className="text-sm text-muted-foreground" aria-hidden>
          {model.label}
        </p>
        <p className="mt-1 font-heading text-4xl font-semibold tabular break-all" aria-hidden>
          {formatValue(model.value, model.format) || 'No value'}
        </p>
      </div>
    );
  }

  if (model.kind === 'pie') return <PieView model={model} ariaLabel={ariaLabel} />;
  return <CartesianView model={model} ariaLabel={ariaLabel} look={look} />;
}

function PieView({ model, ariaLabel }: { model: Extract<ChartModel, { kind: 'pie' }>; ariaLabel: string }) {
  const chartId = svgId(useId());
  return (
    <div className="space-y-3">
      <div role="img" aria-label={ariaLabel} className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <HatchDefs chartId={chartId} count={model.slices.length} />
            <Pie
              data={model.slices}
              dataKey="value"
              nameKey="label"
              innerRadius="45%"
              outerRadius="80%"
              stroke="var(--card)"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {model.slices.map((s, i) => (
                <Cell key={s.name} fill={fillAt(chartId, i)} />
              ))}
            </Pie>
            <Tooltip formatter={(v) => formatValue(v as number, model.format)} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      {/* Labels and values written out, not only in colour. */}
      <ul className="grid gap-1.5 text-sm sm:grid-cols-2">
        {model.slices.map((s, i) => (
          <li key={s.name} className="flex items-center gap-2">
            <span className="size-3 shrink-0 rounded-sm" style={{ background: swatchAt(i) }} aria-hidden />
            <span className="min-w-0 flex-1 truncate" title={s.label}>
              {s.label}
            </span>
            <span className="tabular font-medium">{formatValue(s.value, model.format)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CartesianView({ model, ariaLabel, look }: { model: Extract<ChartModel, { kind: 'cartesian' }>; ariaLabel: string; look: ChartLook }) {
  // The drawn width, for the document look's label column (layout only, never a figure).
  const [measuredWidth, setChartWidth] = useState(0);
  const printing = look === 'print';
  const chartId = svgId(useId());
  // In print the chart is drawn at the page's content width, not the screen's.
  const chartWidth = printing ? PRINT_CHART_WIDTH : measuredWidth;
  const documentLabels = look !== 'app' && chartWidth > 0;
  const horizontal = model.type === 'bar' && model.orientation === 'horizontal';
  // xLabel comes from the model: formatted, and "(blank)" for a missing key.
  const data = model.data;
  const labelled = data.length * model.series.length <= MAX_LABELLED_VALUES;
  const firstFormat: ValueFormat = model.series[0]?.format ?? 'number';
  const valueTick = (v: number) => formatValue(v, firstFormat);
  const height = printing ? printChartHeight(horizontal, data.length) : horizontal ? Math.max(240, data.length * 36 + 60) : 300;
  // Ticks from the chart library's scale: whole numbers only on a whole-number axis (see valueAxis).
  const axis = valueAxis(model);
  // On a report document bars keep a sensible thickness rather than filling the band.
  const maxBarSize = look === 'app' ? undefined : horizontal ? 18 : 56;
  const formatFor = (key: string) => model.series.find((s) => s.key === key)?.format ?? firstFormat;
  const tooltip = (
    <Tooltip
      formatter={(value, _name, item) => formatValue(value as number, formatFor(String(item.dataKey)))}
      labelFormatter={(l) => String(l)}
    />
  );
  // Legend text in ink, not the series colour (orange text on white is hard to read); the swatch carries the colour.
  const legend =
    model.series.length > 1 ? (
      <Legend wrapperStyle={{ fontSize: 13 }} formatter={(value) => <span style={{ color: 'var(--foreground)' }}>{String(value)}</span>} />
    ) : null;
  const grid = <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={horizontal} horizontal={!horizontal} />;
  const stackId = model.stacked ? 'stack' : undefined;

  const xAxis = horizontal ? (
    <XAxis type="number" tickFormatter={valueTick} tick={AXIS_TICK} allowDecimals={axis.allowDecimals} tickCount={axis.tickCount} />
  ) : (
    <XAxis
      dataKey="xLabel"
      tick={<CategoryTick />}
      interval={categoryInterval(model.type, data.length)}
      height={40}
    />
  );
  const yAxis = horizontal ? (
    documentLabels ? (
      <YAxis
        type="category"
        dataKey="xLabel"
        width={chartWidth * DOCUMENT_LABEL_SHARE}
        tick={<CategoryTick horizontal wrapAt={(chartWidth * DOCUMENT_LABEL_SHARE) / 6.5} />}
        interval={0}
      />
    ) : (
      <YAxis type="category" dataKey="xLabel" width={112} tick={<CategoryTick horizontal />} interval={0} />
    )
  ) : (
    <YAxis tickFormatter={valueTick} tick={AXIS_TICK} width={88} allowDecimals={axis.allowDecimals} tickCount={axis.tickCount} />
  );

  const chart: ReactElement<{ width?: number; height?: number }> =
        model.type === 'bar' ? (
          <BarChart data={data} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ top: 16, right: horizontal && labelled && !model.stacked ? 104 : 24, left: 4, bottom: 4 }}>
            {grid}
            {xAxis}
            {yAxis}
            {tooltip}
            {legend}
            <HatchDefs chartId={chartId} count={model.series.length} />
            {model.series.map((s, i) => (
              <Bar key={s.key} dataKey={s.key} name={s.label} fill={fillAt(chartId, i)} stackId={stackId} maxBarSize={maxBarSize} isAnimationActive={false}>
                {labelled && !model.stacked && (
                  <LabelList
                    dataKey={s.key}
                    position={horizontal ? 'right' : 'top'}
                    fontSize={11}
                    formatter={(v: unknown) => formatValue(v as number, s.format)}
                  />
                )}
              </Bar>
            ))}
          </BarChart>
        ) : model.type === 'line' ? (
          <LineChart data={data} margin={{ top: 16, right: 24, left: 4, bottom: 4 }}>
            {grid}
            {xAxis}
            {yAxis}
            {tooltip}
            {legend}
            {model.series.map((s, i) => (
              <Line
                key={s.key}
                dataKey={s.key}
                name={s.label}
                stroke={colourAt(i)}
                strokeWidth={2}
                strokeDasharray={dashAt(i)}
                dot={{ r: 3 }}
                connectNulls={false}
                isAnimationActive={false}
              >
                {labelled && model.series.length === 1 && (
                  <LabelList dataKey={s.key} position="top" fontSize={11} formatter={(v: unknown) => formatValue(v as number, s.format)} />
                )}
              </Line>
            ))}
          </LineChart>
        ) : (
          <AreaChart data={data} margin={{ top: 16, right: 24, left: 4, bottom: 4 }}>
            {grid}
            {xAxis}
            {yAxis}
            {tooltip}
            {legend}
            <HatchDefs chartId={chartId} count={model.series.length} />
            {model.series.map((s, i) => (
              <Area
                key={s.key}
                dataKey={s.key}
                name={s.label}
                stroke={colourAt(i)}
                fill={fillAt(chartId, i)}
                fillOpacity={0.2}
                strokeWidth={2}
                strokeDasharray={dashAt(i)}
                stackId={stackId}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        );

  return (
    <div role="img" aria-label={ariaLabel} className="w-full" style={{ height }}>
      {printing ? (
        // In print: drawn at the page's content width and the print height (no screen measurement).
        cloneElement(chart, { width: chartWidth, height })
      ) : (
        <ResponsiveContainer width="100%" height="100%" onResize={(width) => setChartWidth(width)}>
          {chart}
        </ResponsiveContainer>
      )}
    </div>
  );
}
