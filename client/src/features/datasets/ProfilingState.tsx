import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';

/** The API exposes no stage names, so these advance on a timer and stop at the last one. */
export const PROFILING_STAGES = ['Reading your file', 'Checking the columns', 'Getting your questions ready'];
const STAGE_MS = 4000;

export function ProfilingState({ slow }: { slow: boolean }) {
  const [stage, setStage] = useState(0);

  useEffect(() => {
    if (stage >= PROFILING_STAGES.length - 1) return;
    const timer = setTimeout(() => setStage((s) => s + 1), STAGE_MS);
    return () => clearTimeout(timer);
  }, [stage]);

  return (
    <div className="rounded-xl border bg-card p-6">
      <div className="flex items-start gap-3">
        <LoaderCircle className="mt-0.5 size-5 shrink-0 text-primary motion-safe:animate-spin" aria-hidden />
        <div className="space-y-3" aria-live="polite">
          <p className="font-medium">{PROFILING_STAGES[stage]}…</p>
          <ol className="space-y-1 text-sm">
            {PROFILING_STAGES.map((label, i) => (
              <li key={label} className={i <= stage ? 'text-foreground' : 'text-muted-foreground'}>
                {i < stage ? 'Done: ' : i === stage ? 'Now: ' : 'Next: '}
                {label}
              </li>
            ))}
          </ol>
          <p className="text-sm text-muted-foreground">
            {slow
              ? 'This is taking longer than usual. You can leave this page; we will keep working.'
              : 'This usually takes a few seconds. You can leave this page; we will keep working.'}
          </p>
        </div>
      </div>
    </div>
  );
}
