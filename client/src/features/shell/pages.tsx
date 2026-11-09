import { Link } from 'react-router';
import { Construction } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useActiveWorkspace } from '@/features/workspaces/WorkspaceProvider';
import { AuthLayout } from '@/features/auth/AuthLayout';

export function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-6 space-y-1">
      <h1 className="text-2xl font-semibold sm:text-3xl">{title}</h1>
      {description && <p className="text-muted-foreground">{description}</p>}
    </div>
  );
}

/** Datasets, Reports and Templates arrive in later parts; these keep the navigation visible. */
export function PlaceholderPage({ title }: { title: string }) {
  const { active } = useActiveWorkspace();
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={title} description={active ? `Workspace: ${active.name}` : undefined} />
      <div className="flex items-start gap-3 rounded-xl border bg-card p-6">
        <Construction className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
        <p>Coming in the next part.</p>
      </div>
    </div>
  );
}

/** Terms and privacy: clearly marked placeholders until the real text is supplied. */
export function LegalPlaceholderPage({ kind }: { kind: 'terms' | 'privacy' }) {
  const title = kind === 'terms' ? 'Terms of use' : 'Privacy notice';
  return (
    <AuthLayout title={title}>
      <div role="note" className="rounded-md border border-dashed bg-secondary px-4 py-3">
        <p className="font-medium">Placeholder</p>
        <p>
          {title}, draft to be supplied.
        </p>
      </div>
    </AuthLayout>
  );
}

export function NotFoundPage() {
  return (
    <AuthLayout title="Page not found">
      <div className="space-y-4">
        <p>We could not find that page. The link may be wrong, or the page may have moved.</p>
        <Button asChild>
          <Link to="/">Go to the start page</Link>
        </Button>
      </div>
    </AuthLayout>
  );
}
