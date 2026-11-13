import { useEffect } from 'react';
import { Link, useLocation } from 'react-router';
import { useMe } from '@/auth/useMe';
import { InlineLoading } from '@/components/PageStatus';
import { PageHeader } from '@/features/shell/pages';
import { WorkspacesSection } from '@/features/workspaces/WorkspacesSection';
import { ProfileSection } from './ProfileSection';

export function SettingsPage() {
  const me = useMe();
  const { hash } = useLocation();

  useEffect(() => {
    if (hash && me.data) document.getElementById(hash.slice(1))?.scrollIntoView();
  }, [hash, me.data]);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Settings" />
      {me.data ? (
        <div className="space-y-6">
          <ProfileSection me={me.data} />
          <section aria-labelledby="brand-link-heading" className="rounded-xl border bg-card p-5 sm:p-6">
            <h2 id="brand-link-heading" className="text-xl font-semibold">
              Your brand
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">The business name, colour and logo on your reports.</p>
            <Link
              to="/settings/brand"
              className="mt-3 inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4"
            >
              Set your brand
            </Link>
          </section>
          <WorkspacesSection me={me.data} />
        </div>
      ) : (
        <InlineLoading />
      )}
    </div>
  );
}
