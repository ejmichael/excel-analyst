import { Archive, CircleAlert, CircleCheck, LoaderCircle, Upload, type LucideIcon } from 'lucide-react';
import type { DatasetStatus } from '@/api/types';
import { cn } from '@/lib/utils';
import { STATUS_LABELS } from './labels';

const STYLES: Record<DatasetStatus, { icon: LucideIcon; className: string; spin?: boolean }> = {
  uploading: { icon: Upload, className: 'border-border bg-secondary text-foreground' },
  profiling: { icon: LoaderCircle, className: 'border-border bg-secondary text-foreground', spin: true },
  ready: { icon: CircleCheck, className: 'border-primary/40 bg-accent text-foreground' },
  failed: { icon: CircleAlert, className: 'border-destructive/40 bg-destructive/5 text-destructive' },
  expired: { icon: Archive, className: 'border-border bg-muted text-muted-foreground' },
};

/** Status in words with an icon; colour only reinforces it. */
export function StatusBadge({ status, className }: { status: DatasetStatus; className?: string }) {
  const { icon: Icon, className: tone, spin } = STYLES[status];
  return (
    <span
      data-status={status}
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium whitespace-nowrap',
        tone,
        className,
      )}
    >
      <Icon className={cn('size-3.5', spin && 'motion-safe:animate-spin')} aria-hidden />
      {STATUS_LABELS[status]}
    </span>
  );
}
