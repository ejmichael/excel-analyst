import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DatasetDetail } from '@/api/types';
import { ParseDialog } from './ParseDialog';
import { changedOptions, formValuesFrom } from './parseOptions';

const base = {
  id: 'd1',
  file_type: 'csv',
  parse_options: { sheet_name: null, header_row: 5, delimiter: ';', decimal_separator: ',', date_format: 'dmy' },
  sheet_names: [],
  // Like the server: blank lines above the header are not in preamble_lines.
  preamble_lines: ['Sales report', 'Period: 01/10/2026 to 31/10/2026', 'Generated: 01/11/2026 06:00'],
} as unknown as DatasetDetail;

const xlsx = {
  ...base,
  file_type: 'xlsx',
  parse_options: { sheet_name: 'Sales', header_row: 1, delimiter: null, decimal_separator: '.', date_format: 'dmy' },
  sheet_names: ['Sales', 'Notes'],
  preamble_lines: [],
} as unknown as DatasetDetail;

describe('changedOptions', () => {
  it('returns only what changed, typed for the API', () => {
    const initial = formValuesFrom(base.parse_options);
    expect(changedOptions('csv', initial, initial)).toEqual({});
    expect(changedOptions('csv', initial, { ...initial, header_row: '3', date_format: 'mdy' })).toEqual({
      header_row: 3,
      date_format: 'mdy',
    });
  });

  it('ignores options that do not apply to the file type', () => {
    const initial = formValuesFrom(xlsx.parse_options);
    expect(changedOptions('xlsx', initial, { ...initial, delimiter: ';', sheet_name: 'Notes' })).toEqual({ sheet_name: 'Notes' });
  });
});

describe('ParseDialog', () => {
  it('for a CSV: shows the delimiter, not the sheet, plus the skipped lines', () => {
    render(<ParseDialog dataset={base} open onClose={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText('Columns are separated by')).toBeInTheDocument();
    expect(screen.queryByLabelText('Sheet')).not.toBeInTheDocument();
    // Header on row 5: all 4 lines above it were skipped, one of them empty.
    expect(screen.getByText('These 4 lines above your table were skipped')).toBeInTheDocument();
    expect(screen.getByText('and 1 empty line')).toBeInTheDocument();
    expect(screen.getByText('Dates are read day first, 31/10/2026.')).toBeInTheDocument();
  });

  it('for an XLSX: shows the sheet, not the delimiter', () => {
    render(<ParseDialog dataset={xlsx} open onClose={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText('Sheet')).toBeInTheDocument();
    expect(screen.queryByLabelText('Columns are separated by')).not.toBeInTheDocument();
  });

  it('is disabled until something changes, then sends every option with the change (the server re-detects the rest)', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => undefined);
    const onClose = vi.fn();
    render(<ParseDialog dataset={base} open onClose={onClose} onSubmit={onSubmit} />);

    const submit = screen.getByRole('button', { name: 'Read the file again' });
    expect(submit).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Date order'), 'mdy');
    await user.click(submit);

    expect(onSubmit).toHaveBeenCalledWith({ header_row: 5, delimiter: ';', decimal_separator: ',', date_format: 'mdy' });
    expect(onClose).toHaveBeenCalled();
  });

  it('checks the header row number in words', async () => {
    const user = userEvent.setup();
    render(<ParseDialog dataset={base} open onClose={vi.fn()} onSubmit={vi.fn()} />);
    const header = screen.getByLabelText('Row with the column names');
    await user.clear(header);
    await user.type(header, '0');
    expect(screen.getByText('Enter a whole number from 1 to 1000.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Read the file again' })).toBeDisabled();
  });
});
