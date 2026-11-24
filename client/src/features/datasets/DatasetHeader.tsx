import { useState } from 'react';
import { useNavigate } from 'react-router';
import { ChevronDown, Pencil, Trash2 } from 'lucide-react';
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { formatBytes, formatNumber, formatShortDate } from '@/lib/format';
import { expirySentence, rowCountLabel } from './DatasetList';
import { useDeleteDataset, useUpdateDataset } from './queries';
import { StatusBadge } from './StatusBadge';

export function excludedRowsNote(excluded: number): string | null {
  if (excluded <= 0) return null;
  return `We left out ${formatNumber(excluded, 0)} ${excluded === 1 ? 'row that looked' : 'rows that looked'} like a total or a blank line.`;
}

/**
 * Every fact about the file on one line: "115 rows, 10 columns, Booking app.xlsx, 44,4 kB, uploaded 23 Nov 2026."
 * then the left-out rows and the deletion date as sentences. Counts as the server gives them.
 */
export function headerSummary(dataset: DatasetDetail): string {
  const columns = dataset.columns.length;
  const facts = [
    dataset.row_count !== null && dataset.status !== 'failed' ? rowCountLabel(dataset.row_count) : null,
    columns > 0 ? `${formatNumber(columns, 0)} ${columns === 1 ? 'column' : 'columns'}` : null,
    dataset.original_filename,
    formatBytes(dataset.size_bytes),
    `uploaded ${formatShortDate(dataset.created_at)}`,
  ].filter(Boolean);
  const excluded = dataset.status === 'ready' ? excludedRowsNote(dataset.excluded_rows) : null;
  // An expired file has its own panel saying when it was deleted.
  const expiry = dataset.status === 'expired' ? null : expirySentence(dataset);
  const first = facts.join(', ').replace(/^./, (c) => c.toUpperCase());
  return [`${first}.`, excluded, expiry].filter(Boolean).join(' ');
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

  const summary = headerSummary(dataset);

  return (
    <header className="space-y-1.5">
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
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="min-w-0 text-2xl font-semibold break-words sm:text-3xl">{dataset.name}</h1>
            <StatusBadge status={dataset.status} />
          </div>
          {/* Not modal: the Delete dialog opens straight after the menu closes. */}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="shrink-0 bg-card" aria-label="More actions for this file">
                More
                <ChevronDown aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem
                onSelect={() => {
                  setName(dataset.name);
                  setEditing(true);
                }}
              >
                <Pencil aria-hidden />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
                <Trash2 aria-hidden />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      <p className="max-w-[80ch] text-sm text-muted-foreground tabular break-words" data-file-summary>
        {summary}
      </p>

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
