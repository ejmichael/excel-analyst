import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';

/** The API exposes no stages, so these advance on a timer and stop at the last one. */
export const ASK_STAGES = ['Reading your question', 'Running the numbers', 'Checking the result', 'Writing it up'];
export const ASK_STAGE_MS = 4000;
export const ASK_SLOW_MS = 45_000;

export function AskWaiting() {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - started), 1000);
    return () => clearInterval(timer);
  }, []);

  const stage = Math.min(ASK_STAGES.length - 1, Math.floor(elapsed / ASK_STAGE_MS));
  const slow = elapsed >= ASK_SLOW_MS;

  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="flex items-start gap-3">
        <LoaderCircle className="mt-0.5 size-5 shrink-0 text-primary motion-safe:animate-spin" aria-hidden />
        <div className="space-y-2" role="status" aria-live="polite">
          <p className="font-medium">{ASK_STAGES[stage]}…</p>
          <p className="text-sm text-muted-foreground">
            {slow
              ? 'This is taking longer than usual. You can leave this page; the answer will be in your history.'
              : 'You can leave this page; the answer will be in your history.'}
          </p>
        </div>
      </div>
    </div>
  );
}
