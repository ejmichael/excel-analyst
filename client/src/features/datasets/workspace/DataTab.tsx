import { errorMessage } from '@/api/client';
import type { DatasetDetail } from '@/api/types';
import { FormMessage } from '@/components/FormField';
import { InlineLoading } from '@/components/PageStatus';
import { Button } from '@/components/ui/button';
import { ColumnsForm } from '../ColumnsForm';
import { PreviewTable } from '../PreviewTable';
import { useDatasetPreview, useUpdateDataset } from '../queries';

/** The Data tab: the file's rows and its columns. */
export function DataTab({ dataset }: { dataset: DatasetDetail }) {
  const update = useUpdateDataset(dataset.id);
  const preview = useDatasetPreview(dataset.id, true);
  return (
    <div className="space-y-8">
      <section aria-labelledby="preview-heading" className="space-y-3">
        <h2 id="preview-heading" className="text-xl font-semibold">
          Preview
        </h2>
        {preview.isPending ? (
          <InlineLoading label="Loading the preview" />
        ) : preview.isError ? (
          <div className="space-y-3">
            <FormMessage>{errorMessage(preview.error)}</FormMessage>
            <Button variant="outline" onClick={() => void preview.refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <PreviewTable preview={preview.data} columns={dataset.columns} />
        )}
      </section>
      <ColumnsForm columns={dataset.columns} onSave={(columns) => update.mutateAsync({ columns })} />
    </div>
  );
}
