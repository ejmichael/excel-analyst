import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Pencil, Trash2 } from 'lucide-react';
import { errorMessage, isApiError } from '@/api/client';
import type { DatasetDetail } from '@/api/types';
import { FormMessage, TextField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatBytes, formatNumber } from '@/lib/format';
import { expirySentence, rowCountLabel } from './DatasetList';
import { useDeleteDataset, useUpdateDataset } from './queries';
import { StatusBadge } from './StatusBadge';

export function excludedRowsNote(excluded: number): string | null {
  if (excluded <= 0) return null;
  return `We left out ${formatNumber(excluded, 0)} ${excluded === 1 ? 'row that looked' : 'rows that looked'} like a total or a blank line.`;
}

export function DatasetHeader({ dataset }: { dataset: DatasetDetail }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(dataset.name);
  const [nameError, setNameError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const update = useUpdateDataset(dataset.id);
  const remove = useDeleteDataset(dataset.id);
  const navigate = useNavigate();

  const saveName = () => {
    const trimmed = name.trim();
    if (!trimmed) return setNameError('Enter a name.');
    if (trimmed === dataset.name) return setEditing(false);
    setNameError(null);
    update.mutate(
      { name: trimmed },
      {
        onSuccess: () => setEditing(false),
        onError: (error) => setNameError((isApiError(error) && error.fieldErrors.name) || errorMessage(error)),
      },
    );
  };

  const meta = [
    dataset.original_filename,
    formatBytes(dataset.size_bytes),
    dataset.row_count !== null && dataset.status !== 'failed' ? rowCountLabel(dataset.row_count) : null,
  ].filter(Boolean);
  const excluded = dataset.status === 'ready' ? excludedRowsNote(dataset.excluded_rows) : null;
  // An expired file has its own panel saying when it was deleted.
  const expiry = dataset.status === 'expired' ? null : expirySentence(dataset);

  return (
    <header className="space-y-3">
      {editing ? (
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-start"
          onSubmit={(event) => {
            event.preventDefault();
            saveName();
          }}
        >
          <TextField
            label="File name in Analyst"
            className="flex-1"
            value={name}
            maxLength={200}
            autoFocus
            error={nameError ?? undefined}
            onChange={(event) => setName(event.target.value)}
          />
          <div className="flex gap-2 sm:mt-[1.625rem]">
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? 'Saving…' : 'Save name'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setEditing(false);
                setName(dataset.name);
                setNameError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="min-w-0 text-2xl font-semibold break-words sm:text-3xl">{dataset.name}</h1>
          <StatusBadge status={dataset.status} />
        </div>
      )}

      <div className="space-y-1 text-sm text-muted-foreground">
        <p className="tabular break-all">{meta.join(' · ')}</p>
        {excluded && <p>{excluded}</p>}
        {expiry && <p>{expiry}</p>}
      </div>

      {!editing && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setName(dataset.name);
              setEditing(true);
            }}
          >
            <Pencil aria-hidden />
            Rename
          </Button>
          <Button variant="outline" className="text-destructive" onClick={() => setConfirmDelete(true)}>
            <Trash2 aria-hidden />
            Delete
          </Button>
        </div>
      )}

      <Dialog open={confirmDelete} onOpenChange={(open) => !open && setConfirmDelete(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-heading text-xl">Delete “{dataset.name}”?</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2 text-base text-foreground">
                <p>This removes the uploaded file and our cleaned copy of it from storage straight away.</p>
                <p>Answers you already saved from it are kept. This cannot be undone.</p>
              </div>
            </DialogDescription>
          </DialogHeader>
          {remove.isError && <FormMessage>{errorMessage(remove.error)}</FormMessage>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate(undefined, { onSuccess: () => navigate('/datasets', { replace: true }) })}
            >
              {remove.isPending ? 'Deleting…' : 'Delete file'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </header>
  );
}
