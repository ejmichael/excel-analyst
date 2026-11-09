import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface State {
  failed: boolean;
}

/** Top-level safety net: a friendly screen with a reload button instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Log the error name and component stack only; never data.
    console.error('Unhandled UI error', error.name, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-4">
        <div role="alert" className="w-full max-w-md rounded-xl border bg-card p-6">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-1 size-5 shrink-0 text-destructive" aria-hidden />
            <div className="space-y-3">
              <h1 className="text-xl font-semibold">Something went wrong</h1>
              <p className="text-muted-foreground">
                This page ran into a problem. Your saved work is not affected. Reloading usually fixes it.
              </p>
              <Button onClick={() => window.location.reload()}>Reload the page</Button>
            </div>
          </div>
        </div>
      </main>
    );
  }
}
