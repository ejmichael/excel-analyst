import { useId, useRef, useState, type DragEvent } from 'react';
import { useNavigate } from 'react-router';
import { FileSpreadsheet, FileUp, X } from 'lucide-react';
import type { Me } from '@/api/types';
import { FormMessage, TextField } from '@/components/FormField';
import { UpgradeDialog } from '@/components/UpgradeDialog';
import { Button } from '@/components/ui/button';
import { formatBytes, formatNumber, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ACCEPT_ATTRIBUTE } from './uploadValidation';
import { useUpload } from './useUpload';

export const PRIVACY_SENTENCE =
  "Your file is stored privately and deleted automatically after your plan's retention period. The AI sees column names and a few sample rows with personal details hidden, never your whole file.";

export function UploadPanel({ me, workspaceId, compact = false }: { me: Me; workspaceId: string | undefined; compact?: boolean }) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [name, setName] = useState('');
  const headingId = useId();
  const upload = useUpload({
    workspaceId,
    limits: me.limits,
    onUploaded: (dataset) => navigate(`/datasets/${dataset.id}`),
  });
  const { state } = upload;

  const choose = (files: FileList | null) => {
    const file = files?.[0];
    if (file) {
      setName('');
      upload.select(file);
    }
    if (inputRef.current) inputRef.current.value = '';
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (state.phase !== 'uploading') choose(event.dataTransfer.files);
  };

  const file = state.phase === 'selected' || state.phase === 'uploading' ? state.file : null;

  return (
    <section aria-labelledby={headingId} className="rounded-xl border bg-card p-5 sm:p-6">
      <h2 id={headingId} className="text-lg font-semibold">
        Upload a file
      </h2>
      {!compact && (
        <p className="mt-1 text-sm text-muted-foreground">
          A CSV or Excel export of sales, costs, stock or a bank statement. One table per file works best.
        </p>
      )}

      {file ? (
        <div className="mt-4 space-y-4">
          <div className="flex items-start gap-3 rounded-lg border bg-background p-3">
            <FileSpreadsheet className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{file.name}</p>
              <p className="text-sm text-muted-foreground tabular">{formatBytes(file.size)}</p>
            </div>
            {state.phase === 'selected' && (
              <Button variant="ghost" size="icon" aria-label="Choose a different file" onClick={upload.reset}>
                <X aria-hidden />
              </Button>
            )}
          </div>

          {state.phase === 'uploading' ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span id="upload-progress-label">Uploading</span>
                <span className="tabular" aria-hidden>
                  {formatPercent(state.progress, 0)}
                </span>
              </div>
              <div
                role="progressbar"
                aria-labelledby="upload-progress-label"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(state.progress * 100)}
                aria-valuetext={formatPercent(state.progress, 0)}
                className="h-2.5 overflow-hidden rounded-full bg-secondary"
              >
                <div className="h-full bg-primary" style={{ width: `${state.progress * 100}%` }} />
              </div>
              <Button variant="outline" onClick={upload.cancel}>
                Cancel upload
              </Button>
            </div>
          ) : (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void upload.start(name);
              }}
            >
              <TextField
                label="Name (optional)"
                placeholder={file.name.replace(/\.[^.]+$/, '')}
                hint="How this file is listed. Leave empty to use the file name."
                value={name}
                maxLength={200}
                onChange={(event) => setName(event.target.value)}
              />
              <Button type="submit" disabled={!workspaceId}>
                <FileUp aria-hidden />
                Upload
              </Button>
            </form>
          )}
        </div>
      ) : (
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            'mt-4 flex flex-col items-center gap-3 rounded-lg border-2 border-dashed px-4 py-8 text-center',
            dragging ? 'border-primary bg-accent' : 'border-input bg-background',
          )}
        >
          <FileUp className="size-6 text-muted-foreground" aria-hidden />
          <p>
            Drag a file here, or
          </p>
          <Button type="button" onClick={() => inputRef.current?.click()} disabled={!workspaceId}>
            Choose a file
          </Button>
          <p className="text-sm text-muted-foreground">CSV, TXT or Excel (.xlsx), up to {formatNumber(me.limits.max_file_mb)} MB on your plan.</p>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT_ATTRIBUTE}
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(event) => choose(event.target.files)}
          />
        </div>
      )}

      {state.phase === 'error' && (
        <div className="mt-4">
          <FormMessage>{state.message}</FormMessage>
        </div>
      )}

      <p className="mt-4 text-sm text-muted-foreground">{PRIVACY_SENTENCE}</p>

      <UpgradeDialog details={upload.planLimit} plan={me.plan} onClose={upload.closePlanLimit} />
    </section>
  );
}
