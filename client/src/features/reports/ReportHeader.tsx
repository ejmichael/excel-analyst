import type { ReactNode } from 'react';
import type { Brand } from '@/api/types';
import { readableTextOn } from '@/lib/color';
import { formatDate } from '@/lib/format';

interface ReportHeaderProps {
  brand: Brand;
  title: string;
  subtitle?: string | null;
  periodLabel?: string | null;
  createdAt?: string | null;
  notes?: string | null;
  /** Called when the logo image fails (for example an expired signed URL). */
  onLogoError?: () => void;
  /** Hide the logo after it has failed for good. */
  logoHidden?: boolean;
  /** Replaces the title line (used by edit mode). */
  titleSlot?: ReactNode;
  headingLevel?: 1 | 2;
}

/**
 * The report's own header, in the user's brand: a band in the brand colour with the logo and business name (text
 * colour chosen for contrast), then the title, subtitle, period, date and notes. The brand applies here only, never
 * to the app around it. Used by the report page and, unchanged, by the brand settings preview.
 */
export function ReportHeader({
  brand,
  title,
  subtitle,
  periodLabel,
  createdAt,
  notes,
  onLogoError,
  logoHidden = false,
  titleSlot,
  headingLevel = 1,
}: ReportHeaderProps) {
  const { text } = readableTextOn(brand.color);
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  const meta = [periodLabel, createdAt ? formatDate(createdAt) : null].filter(Boolean).join(' · ');
  const showLogo = Boolean(brand.logo_url) && !logoHidden;

  return (
    <header className="overflow-hidden rounded-xl border bg-card" data-testid="report-header">
      <div
        className="flex min-h-16 items-center gap-3 px-5 py-3"
        style={{ backgroundColor: brand.color, color: text }}
        data-testid="report-brand-band"
      >
        {showLogo && (
          <img
            src={brand.logo_url ?? undefined}
            alt={brand.business_name ? `${brand.business_name} logo` : 'Logo'}
            className="h-10 max-w-[10rem] rounded-sm bg-white/90 object-contain p-1"
            onError={onLogoError}
          />
        )}
        {/* Only the business name the user set; nothing is invented when it is empty. */}
        {brand.business_name && <p className="font-heading text-lg font-semibold break-words">{brand.business_name}</p>}
      </div>
      <div className="space-y-2 px-5 py-4">
        {titleSlot ?? <Heading className="text-2xl font-semibold break-words sm:text-3xl">{title}</Heading>}
        {subtitle && <p className="text-lg break-words">{subtitle}</p>}
        {meta && <p className="text-sm text-muted-foreground">{meta}</p>}
        {notes && <p className="whitespace-pre-line break-words">{notes}</p>}
      </div>
    </header>
  );
}
