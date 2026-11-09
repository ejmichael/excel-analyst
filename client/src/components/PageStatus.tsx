import { AlertCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function FullPageLoading({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex min-h-dvh items-center justify-center gap-3 text-muted-foreground">
      <Loader2 className="size-5 motion-safe:animate-spin" aria-hidden />
      <span>{label}…</span>
    </div>
  );
}

export function InlineLoading({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
      <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
      <span>{label}…</span>
    </div>
  );
}

export function FullPageError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div role="alert" className="w-full max-w-md rounded-xl border bg-card p-6">
        <div className="flex items-start gap-3">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />
          <div className="space-y-3">
            <h1 className="text-lg font-semibold">We could not load your account</h1>
            <p className="text-sm text-muted-foreground">{message}</p>
            <Button onClick={onRetry}>Try again</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
