import { useEffect } from 'react';
import { useLocation } from 'react-router';
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
          <WorkspacesSection me={me.data} />
        </div>
      ) : (
        <InlineLoading />
      )}
    </div>
  );
}
