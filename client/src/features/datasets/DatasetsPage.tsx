import { errorMessage } from '@/api/client';
import { useMe } from '@/auth/useMe';
import { InlineLoading } from '@/components/PageStatus';
import { PageHeader } from '@/features/shell/pages';
import { useActiveWorkspace } from '@/features/workspaces/WorkspaceProvider';
import { DatasetList } from './DatasetList';
import { useDatasetList } from './queries';
import { UploadPanel } from './UploadPanel';

export function DatasetsPage() {
  const me = useMe();
  const { active } = useActiveWorkspace();
  const list = useDatasetList(active?.id);
  const datasets = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title="Datasets" description={active ? `Workspace: ${active.name}` : undefined} />
      {me.data ? <UploadPanel me={me.data} workspaceId={active?.id} compact={datasets.length > 0} /> : <InlineLoading />}
      <section aria-labelledby="files-heading" className="space-y-3">
        <h2 id="files-heading" className="text-lg font-semibold">
          Your files
        </h2>
        <DatasetList
          status={!active || list.isPending ? 'pending' : list.isError ? 'error' : 'success'}
          datasets={datasets}
          error={list.isError ? errorMessage(list.error) : undefined}
          onRetry={() => void list.refetch()}
          hasMore={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
        />
      </section>
    </div>
  );
}
