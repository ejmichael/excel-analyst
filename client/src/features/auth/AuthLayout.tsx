import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { env } from '@/env';
import { BrandMark } from '@/features/shell/BrandMark';

/** Centered card used by every signed-out page. */
export function AuthLayout({ title, intro, children, footer }: { title: string; intro?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="px-4 pt-6 sm:px-8">
        <Link to="/" className="inline-flex min-h-11 items-center gap-2 rounded-md font-heading text-lg font-semibold">
          <BrandMark />
          {env.appName}
        </Link>
      </header>
      <main className="flex flex-1 items-start justify-center px-4 py-8 sm:items-center">
        <div className="w-full max-w-md space-y-4">
          <div className="rounded-xl border bg-card p-6 sm:p-8">
            <h1 className="text-2xl font-semibold">{title}</h1>
            {intro && <div className="mt-2 text-muted-foreground">{intro}</div>}
            <div className="mt-6">{children}</div>
          </div>
          {footer && <div className="text-center text-sm">{footer}</div>}
          {env.useMocks && (
            <p className="rounded-md border border-dashed bg-card/60 px-3 py-2 text-center text-sm text-muted-foreground">
              Mock mode: nothing is sent to Supabase or the server. Any email with a password of 8 or more characters signs
              you in.
            </p>
          )}
        </div>
      </main>
      <footer className="flex flex-wrap justify-center gap-x-4 px-4 pb-6 text-sm text-muted-foreground">
        <Link to="/terms" className="inline-flex min-h-11 items-center underline-offset-4 hover:underline">
          Terms of use
        </Link>
        <Link to="/privacy" className="inline-flex min-h-11 items-center underline-offset-4 hover:underline">
          Privacy notice
        </Link>
      </footer>
    </div>
  );
}

export function TextLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="inline-flex min-h-11 items-center font-medium text-primary underline-offset-4 hover:underline">
      {children}
    </Link>
  );
}
