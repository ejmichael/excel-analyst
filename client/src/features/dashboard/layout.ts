import type { DashboardWidgetWidth } from '@/api/types';

/**
 * The span of a widget in the 12-column grid: desktop (1024px and up) quarter 3, half 6, full 12; tablet and phone
 * quarter 6 (two tiles per row), the others 12.
 */
export function widthClass(width: DashboardWidgetWidth): string {
  if (width === 'quarter') return 'col-span-6 lg:col-span-3';
  if (width === 'half') return 'col-span-12 lg:col-span-6';
  return 'col-span-12';
}
