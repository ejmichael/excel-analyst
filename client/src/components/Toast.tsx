import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * A short confirmation at the bottom of the screen, with an optional action. It stays until it is dismissed (an action
 * should not vanish before it can be reached). The live region is always in the page, so the message is announced.
 */
export function Toast({ message, action, onDismiss }: { message: string | null; action?: ReactNode; onDismiss: () => void }) {
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex justify-end sm:left-auto">
      {message && (
        <div className="pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-xl border bg-card p-4 shadow-lg" data-toast>
          <div className="min-w-0 flex-1 space-y-2">
            <p className="text-sm break-words">{message}</p>
            {action}
          </div>
          <Button variant="ghost" size="icon" className="-mt-1 -mr-1 size-11 shrink-0" aria-label="Dismiss" onClick={onDismiss}>
            <X aria-hidden />
          </Button>
        </div>
      )}
    </div>
  );
}
