import { useId, useMemo, useState } from 'react';
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
import { buildChartModel, formatOf, groupKeyColumns, shortLabel, type ChartModel } from './chartData';
import { colourAt, dashAt } from './chartPalette';
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
}) {
  const full = String(props.payload?.value ?? '');
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

export function BlockChart({ block }: { block: Block }) {
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
      <div id={tableId}>{asTable || model.kind === 'table' ? table : <ChartView model={model} ariaLabel={ariaLabel} />}</div>
    </div>
  );
}

function ChartView({ model, ariaLabel }: { model: Exclude<ChartModel, { kind: 'empty' } | { kind: 'table' }>; ariaLabel: string }) {
  if (model.kind === 'kpi') {
    return (
      <div role="img" aria-label={`${ariaLabel}. ${model.label}: ${formatValue(model.value, model.format)}`} className="rounded-lg border bg-background p-5">
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
  return <CartesianView model={model} ariaLabel={ariaLabel} />;
}

function PieView({ model, ariaLabel }: { model: Extract<ChartModel, { kind: 'pie' }>; ariaLabel: string }) {
  return (
    <div className="space-y-3">
      <div role="img" aria-label={ariaLabel} className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
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
                <Cell key={s.name} fill={colourAt(i)} />
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
            <span className="size-3 shrink-0 rounded-sm" style={{ background: colourAt(i) }} aria-hidden />
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

function CartesianView({ model, ariaLabel }: { model: Extract<ChartModel, { kind: 'cartesian' }>; ariaLabel: string }) {
  const horizontal = model.type === 'bar' && model.orientation === 'horizontal';
  // xLabel comes from the model: formatted, and "(blank)" for a missing key.
  const data = model.data;
  const labelled = data.length * model.series.length <= MAX_LABELLED_VALUES;
  const firstFormat: ValueFormat = model.series[0]?.format ?? 'number';
  const valueTick = (v: number) => formatValue(v, firstFormat);
  const height = horizontal ? Math.max(240, data.length * 36 + 60) : 300;
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
    <XAxis type="number" tickFormatter={valueTick} tick={AXIS_TICK} />
  ) : (
    <XAxis
      dataKey="xLabel"
      tick={<CategoryTick />}
      interval={categoryInterval(model.type, data.length)}
      height={40}
    />
  );
  const yAxis = horizontal ? (
    <YAxis type="category" dataKey="xLabel" width={112} tick={<CategoryTick horizontal />} interval={0} />
  ) : (
    <YAxis tickFormatter={valueTick} tick={AXIS_TICK} width={88} />
  );

  return (
    <div role="img" aria-label={ariaLabel} className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        {model.type === 'bar' ? (
          <BarChart data={data} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ top: 16, right: horizontal && labelled && !model.stacked ? 104 : 24, left: 4, bottom: 4 }}>
            {grid}
            {xAxis}
            {yAxis}
            {tooltip}
            {legend}
            {model.series.map((s, i) => (
              <Bar key={s.key} dataKey={s.key} name={s.label} fill={colourAt(i)} stackId={stackId} isAnimationActive={false}>
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
            {model.series.map((s, i) => (
              <Area
                key={s.key}
                dataKey={s.key}
                name={s.label}
                stroke={colourAt(i)}
                fill={colourAt(i)}
                fillOpacity={0.2}
                strokeWidth={2}
                strokeDasharray={dashAt(i)}
                stackId={stackId}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
