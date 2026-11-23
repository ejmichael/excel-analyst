import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import type { DashboardData, DashboardFilter } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { MAX_VALUES, rangeIsBackwards, withFilter, type DateRange, type FilterState } from './filters';

interface FilterBarProps {
  filters: DashboardFilter[];
  state: FilterState;
  onChange: (next: FilterState) => void;
  /** The latest results, for the row count line (both numbers come from the server). */
  data: Pick<DashboardData, 'rows_in_scope' | 'rows_total'> | null;
}

/** One control per filter, in the order the server sent them. Not shown when the dashboard has none. */
export function FilterBar({ filters, state, onChange, data }: FilterBarProps) {
  if (filters.length === 0) return null;
  const active = Object.keys(state).length > 0;
  return (
    <section aria-label="Filters" className="space-y-3 rounded-2xl border bg-card p-4" data-filter-bar>
      <div className="flex flex-wrap items-end gap-3">
        {filters.map((filter) =>
          filter.kind === 'date_range' ? (
            <DateFilter
              key={filter.id}
              filter={filter}
              value={(state[filter.id] as DateRange | undefined) ?? { from: null, to: null }}
              onChange={(range) => onChange(withFilter(state, filter.id, range))}
            />
          ) : (
            <CategoryFilter
              key={filter.id}
              filter={filter}
              selected={(state[filter.id] as string[] | undefined) ?? []}
              onChange={(values) => onChange(withFilter(state, filter.id, values))}
            />
          ),
        )}
        {active && (
          <Button variant="ghost" className="min-h-11 text-primary" onClick={() => onChange({})}>
            Clear all
          </Button>
        )}
      </div>
      {data && (
        <p className="text-sm text-muted-foreground tabular" data-rows-in-scope>
          {formatNumber(data.rows_in_scope, 0)} of {formatNumber(data.rows_total, 0)} rows
        </p>
      )}
    </section>
  );
}

function DateFilter({ filter, value, onChange }: { filter: DashboardFilter; value: DateRange; onChange: (range: DateRange) => void }) {
  const id = useId();
  const backwards = rangeIsBackwards(value);
  const errorId = `${id}-error`;
  const field = (end: 'from' | 'to', label: string) => (
    <div className="space-y-1">
      <label htmlFor={`${id}-${end}`} className="block text-sm">
        {label}
      </label>
      <Input
        id={`${id}-${end}`}
        type="date"
        className="w-auto min-w-40"
        min={filter.min ?? undefined}
        max={filter.max ?? undefined}
        value={value[end] ?? ''}
        aria-invalid={backwards || undefined}
        aria-describedby={backwards ? errorId : undefined}
        onChange={(event) => onChange({ ...value, [end]: event.target.value || null })}
      />
    </div>
  );
  return (
    <fieldset className="space-y-1" data-filter={filter.id}>
      <legend className="text-sm font-medium">{filter.label}</legend>
      <div className="flex flex-wrap gap-2">
        {field('from', 'From')}
        {field('to', 'To')}
      </div>
      {backwards && (
        <p id={errorId} role="alert" className="text-sm font-medium text-destructive">
          From must be on or before To
        </p>
      )}
    </fieldset>
  );
}

/** A button ("Store: All", "Store: 3 selected") that opens a list of the filter's values with a search box. */
function CategoryFilter({ filter, selected, onChange }: { filter: DashboardFilter; selected: string[]; onChange: (values: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const button = useRef<HTMLButtonElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const chosen = new Set(selected);
  const needle = search.trim().toLowerCase();
  const visible = needle ? filter.options.filter((o) => o.toLowerCase().includes(needle)) : filter.options;

  const close = (returnFocus: boolean) => {
    setOpen(false);
    setSearch('');
    if (returnFocus) button.current?.focus();
  };

  // A click outside closes the list.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  };

  // Kept in the filter's own order.
  const set = (values: Set<string>) => onChange(filter.options.filter((o) => values.has(o)).slice(0, MAX_VALUES));
  const toggle = (option: string) => {
    const next = new Set(chosen);
    if (next.has(option)) next.delete(option);
    else next.add(option);
    set(next);
  };

  return (
    <div
      ref={wrapper}
      className="relative"
      data-filter={filter.id}
      onBlur={(event) => {
        // Tabbing out of the list closes it.
        if (open && !wrapper.current?.contains(event.relatedTarget as Node | null)) close(false);
      }}
    >
      <Button
        ref={button}
        variant="outline"
        className={cn('min-h-11 bg-card', selected.length > 0 && 'border-primary')}
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup="dialog"
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        {filter.label}: {selected.length > 0 ? `${formatNumber(selected.length, 0)} selected` : 'All'}
        <ChevronDown className={cn('size-4', open && 'rotate-180')} aria-hidden />
      </Button>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label={filter.label}
          onKeyDown={onKeyDown}
          className="absolute top-full left-0 z-30 mt-2 w-72 max-w-[calc(100vw-2rem)] space-y-3 rounded-2xl border bg-card p-3 shadow-lg"
        >
          <label htmlFor={`${panelId}-search`} className="sr-only">
            Search {filter.label}
          </label>
          <Input
            id={`${panelId}-search`}
            type="search"
            placeholder="Search"
            autoFocus
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="min-h-11" onClick={() => set(new Set([...chosen, ...visible]))}>
              Select all
            </Button>
            <Button variant="outline" size="sm" className="min-h-11" onClick={() => set(new Set())}>
              Clear
            </Button>
          </div>
          {visible.length === 0 ? (
            <p className="text-sm text-muted-foreground">No values match “{search.trim()}”.</p>
          ) : (
            <ul className="max-h-64 space-y-0.5 overflow-y-auto" aria-label={`${filter.label} values`}>
              {visible.map((option) => (
                <li key={option}>
                  <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 hover:bg-secondary">
                    <input
                      type="checkbox"
                      className="size-5 shrink-0 accent-primary focus-visible:ring-2 focus-visible:ring-ring"
                      checked={chosen.has(option)}
                      onChange={() => toggle(option)}
                    />
                    <span className="min-w-0 break-words">{option}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
