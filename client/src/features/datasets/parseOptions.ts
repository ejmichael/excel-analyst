import type { FileType, ParseOptions, ReparseRequest } from '@/api/types';

/** Form values as strings; '' means "leave as detected". */
export interface ParseFormValues {
  sheet_name: string;
  header_row: string;
  delimiter: string;
  decimal_separator: string;
  date_format: string;
}

export function formValuesFrom(options: ParseOptions): ParseFormValues {
  return {
    sheet_name: options.sheet_name ?? '',
    header_row: options.header_row ? String(options.header_row) : '',
    delimiter: options.delimiter ?? '',
    decimal_separator: options.decimal_separator ?? '',
    date_format: options.date_format ?? '',
  };
}

/** Which options apply to which file type: sheet for XLSX, delimiter for CSV, the rest for both. */
export function fieldsFor(fileType: FileType): Array<keyof ParseFormValues> {
  return fileType === 'xlsx'
    ? ['sheet_name', 'header_row', 'decimal_separator', 'date_format']
    : ['header_row', 'delimiter', 'decimal_separator', 'date_format'];
}

/** Only the options the user changed, typed for POST /datasets/:id/reparse. */
export function changedOptions(fileType: FileType, initial: ParseFormValues, current: ParseFormValues): ReparseRequest {
  const out: ReparseRequest = {};
  for (const field of fieldsFor(fileType)) {
    const value = current[field];
    if (value === initial[field] || value === '') continue;
    switch (field) {
      case 'header_row':
        out.header_row = Number(value);
        break;
      case 'sheet_name':
        out.sheet_name = value;
        break;
      case 'delimiter':
        out.delimiter = value as NonNullable<ParseOptions['delimiter']>;
        break;
      case 'decimal_separator':
        out.decimal_separator = value as NonNullable<ParseOptions['decimal_separator']>;
        break;
      case 'date_format':
        out.date_format = value as NonNullable<ParseOptions['date_format']>;
        break;
    }
  }
  return out;
}

export function headerRowError(value: string): string | null {
  if (value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? null : 'Enter a whole number from 1 to 1000.';
}
