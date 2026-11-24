import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The page column inside the app shell. `wide` (the file workspace and the Datasets list): up to 1800px, centred.
 * `narrow` (Settings, Templates and every report page): the reading width these pages have always had.
 * Side padding 16px on phones, 24px from 640px, 32px from 1024px; none in print, so a printed report is unchanged.
 * `className` goes on the inner column (spacing, or a narrower max width); other attributes on the outer one.
 */
export function PageContainer({
  variant,
  className,
  children,
  ...rest
}: {
  variant: 'wide' | 'narrow';
  className?: string;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'children'>) {
  return (
    <div {...rest} data-page-container={variant} className="px-4 sm:px-6 lg:px-8 print:px-0">
      <div className={cn('mx-auto w-full', variant === 'wide' ? 'max-w-[1800px]' : 'max-w-4xl', className)}>{children}</div>
    </div>
  );
}
