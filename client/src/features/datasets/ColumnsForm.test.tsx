import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@/api/client';
import type { DatasetColumn, DatasetDetail } from '@/api/types';
import { ColumnsForm } from './ColumnsForm';
import { buildColumnsPatch, draftsFrom } from './columnsPatch';

const column = (over: Partial<DatasetColumn>): DatasetColumn => ({
  id: 'c1',
  position: 0,
  name: 'Name',
  display_name: null,
  sql_name: 'name',
  data_type: 'text',
  semantic: 'none',
  is_pii: false,
  vat_included: null,
  null_count: 0,
  distinct_count: 3,
  min_value: null,
  max_value: null,
  sample_values: [],
  ...over,
});

const columns = [
  column({ id: 'c-store', name: 'Store', sql_name: 'store', semantic: 'category' }),
  column({ id: 'c-total', name: 'Total', sql_name: 'total', data_type: 'decimal', semantic: 'currency_zar' }),
  column({ id: 'c-email', name: 'Email', sql_name: 'email' }),
];

const rowFor = (name: string) => screen.getByRole('heading', { name, level: 3 }).closest('li') as HTMLElement;

describe('buildColumnsPatch', () => {
  it('contains only changed columns, and only their changed fields', () => {
    const drafts = draftsFrom(columns);
    drafts['c-total'] = { ...drafts['c-total']!, vat_included: true };
    drafts['c-store'] = { ...drafts['c-store']!, display_name: '  Branch ' };
    expect(buildColumnsPatch(columns, drafts)).toEqual([
      { id: 'c-store', display_name: 'Branch' },
      { id: 'c-total', vat_included: true },
    ]);
  });

  it('treats an emptied display name as null, and an untouched form as clean', () => {
    const named = [column({ id: 'a', display_name: 'Old' })];
    const drafts = draftsFrom(named);
    expect(buildColumnsPatch(named, drafts)).toEqual([]);
    drafts.a = { ...drafts.a!, display_name: '' };
    expect(buildColumnsPatch(named, drafts)).toEqual([{ id: 'a', display_name: null }]);
  });
});

describe('ColumnsForm', () => {
  it('enables Save only when something changed, and sends only the changes', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => ({ columns }) as DatasetDetail);
    render(<ColumnsForm columns={columns} onSave={onSave} />);

    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled();

    await user.selectOptions(within(rowFor('Email')).getByLabelText('Meaning'), 'email');
    expect(within(rowFor('Email')).getByText(/Saving turns Private on/)).toBeInTheDocument();
    expect(save).toBeEnabled();
    expect(screen.getByText('Unsaved changes in 1 column.')).toBeInTheDocument();

    await user.click(save);
    expect(onSave).toHaveBeenCalledWith([{ id: 'c-email', semantic: 'email' }]);
  });

  it('shows the VAT choice only for money columns', () => {
    render(<ColumnsForm columns={columns} onSave={vi.fn()} />);
    expect(within(rowFor('Total')).getByLabelText('VAT')).toBeInTheDocument();
    expect(within(rowFor('Store')).queryByLabelText('VAT')).not.toBeInTheDocument();
  });

  it('shows validation_failed field errors next to the right column', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => {
      throw new ApiError(422, 'validation_failed', 'Some fields need attention.', {
        fields: [{ location: 'body', path: 'columns.0.display_name', message: 'Too long for a column name' }],
      });
    });
    render(<ColumnsForm columns={columns} onSave={onSave} />);

    await user.type(within(rowFor('Total')).getByLabelText('Display name'), 'Grand total');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(within(rowFor('Total')).getByText('Too long for a column name')).toBeInTheDocument();
    expect(within(rowFor('Store')).queryByText('Too long for a column name')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Some columns need attention');
  });
});
