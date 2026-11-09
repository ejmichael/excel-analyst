import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { errorMessage, isApiError } from '@/api/client';
import type { Me, PlanLimitDetails, Workspace } from '@/api/types';
import { FormMessage, TextField } from '@/components/FormField';
import { InlineLoading } from '@/components/PageStatus';
import { UpgradeDialog } from '@/components/UpgradeDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { PLAN_LABELS } from '@/lib/errors';
import { formatDate, formatNumber } from '@/lib/format';
import { useCreateWorkspace, useDeleteWorkspace, useRenameWorkspace } from './queries';
import { useActiveWorkspace } from './WorkspaceProvider';

// Same bounds as the API: 1 to 80 characters after trimming.
const nameSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(80, 'Use at most 80 characters.'),
});
type NameValues = z.infer<typeof nameSchema>;

export function WorkspacesSection({ me }: { me: Me }) {
  const { workspaces, active, isLoading, error, refetch } = useActiveWorkspace();
  const [renaming, setRenaming] = useState<Workspace | null>(null);
  const [deleting, setDeleting] = useState<Workspace | null>(null);
  const [planLimit, setPlanLimit] = useState<PlanLimitDetails | null>(null);

  return (
    <section id="workspaces" aria-labelledby="workspaces-heading" className="scroll-mt-20 rounded-xl border bg-card p-5 sm:p-6">
      <h2 id="workspaces-heading" className="text-xl font-semibold">
        Workspaces
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Keep each client or business in its own workspace. Your {PLAN_LABELS[me.plan]} plan includes{' '}
        <span className="tabular">{formatNumber(me.limits.max_workspaces, 0)}</span>{' '}
        {me.limits.max_workspaces === 1 ? 'workspace' : 'workspaces'}. You are using{' '}
        <span className="tabular">{formatNumber(workspaces.length || me.usage.workspaces, 0)}</span>.
      </p>

      <div className="mt-5">
        {isLoading ? (
          <InlineLoading label="Loading workspaces" />
        ) : error ? (
          <div className="space-y-3">
            <FormMessage>{errorMessage(error)}</FormMessage>
            <Button variant="outline" onClick={refetch}>
              Try again
            </Button>
          </div>
        ) : (
          <ul className="divide-y rounded-lg border">
            {workspaces.map((w) => (
              <li key={w.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{w.name}</span>
                    {w.is_default && <Badge variant="secondary">Default</Badge>}
                    {w.id === active?.id && (
                      <Badge variant="outline" className="border-primary/40">
                        In use
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">Created {formatDate(w.created_at)}</p>
                  {w.is_default && (
                    <p className="text-sm text-muted-foreground">The default workspace cannot be deleted.</p>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setRenaming(w)}>
                    <Pencil aria-hidden />
                    Rename<span className="sr-only"> {w.name}</span>
                  </Button>
                  {!w.is_default && (
                    <Button variant="outline" className="text-destructive" onClick={() => setDeleting(w)}>
                      <Trash2 aria-hidden />
                      Delete<span className="sr-only"> {w.name}</span>
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <CreateWorkspaceForm onPlanLimit={setPlanLimit} />

      <RenameDialog workspace={renaming} onClose={() => setRenaming(null)} />
      <DeleteDialog workspace={deleting} onClose={() => setDeleting(null)} />
      <UpgradeDialog details={planLimit} plan={me.plan} onClose={() => setPlanLimit(null)} />
    </section>
  );
}

function applyFieldErrors(error: unknown, setError: (name: 'name', e: { message: string }) => void): boolean {
  if (!isApiError(error)) return false;
  const message = error.fieldErrors.name;
  if (message) setError('name', { message });
  return Boolean(message);
}

function CreateWorkspaceForm({ onPlanLimit }: { onPlanLimit: (d: PlanLimitDetails) => void }) {
  const create = useCreateWorkspace();
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const form = useForm<NameValues>({ resolver: zodResolver(nameSchema), defaultValues: { name: '' } });

  const onSubmit = form.handleSubmit(({ name }) => {
    setFormError(null);
    setCreated(null);
    create.mutate(name, {
      onSuccess: (workspace) => {
        form.reset();
        setCreated(workspace.name);
      },
      onError: (error) => {
        if (isApiError(error) && error.planLimit) return onPlanLimit(error.planLimit);
        if (!applyFieldErrors(error, form.setError)) setFormError(errorMessage(error));
      },
    });
  });

  return (
    <form onSubmit={onSubmit} noValidate className="mt-6 space-y-3 border-t pt-5">
      <h3 className="text-base font-semibold">Create a workspace</h3>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <TextField
          label="Workspace name"
          placeholder="For example, Mokoena Bakery"
          className="flex-1"
          error={form.formState.errors.name?.message}
          {...form.register('name')}
        />
        <Button type="submit" className="sm:mt-[1.625rem]" disabled={create.isPending}>
          <Plus aria-hidden />
          {create.isPending ? 'Creating…' : 'Create workspace'}
        </Button>
      </div>
      {formError && <FormMessage>{formError}</FormMessage>}
      {created && <FormMessage tone="success">Workspace “{created}” created. Switch to it from the top bar.</FormMessage>}
    </form>
  );
}

function RenameDialog({ workspace, onClose }: { workspace: Workspace | null; onClose: () => void }) {
  const rename = useRenameWorkspace();
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<NameValues>({ resolver: zodResolver(nameSchema), values: { name: workspace?.name ?? '' } });

  const close = () => {
    setFormError(null);
    rename.reset();
    onClose();
  };

  const onSubmit = form.handleSubmit(({ name }) => {
    if (!workspace) return;
    setFormError(null);
    rename.mutate(
      { id: workspace.id, name },
      {
        onSuccess: close,
        onError: (error) => {
          if (!applyFieldErrors(error, form.setError)) setFormError(errorMessage(error));
        },
      },
    );
  });

  return (
    <Dialog open={workspace !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          <DialogHeader>
            <DialogTitle className="font-heading text-xl">Rename workspace</DialogTitle>
            <DialogDescription>Currently “{workspace?.name}”.</DialogDescription>
          </DialogHeader>
          <TextField label="New name" autoFocus error={form.formState.errors.name?.message} {...form.register('name')} />
          {formError && <FormMessage>{formError}</FormMessage>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={rename.isPending}>
              {rename.isPending ? 'Saving…' : 'Save name'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({ workspace, onClose }: { workspace: Workspace | null; onClose: () => void }) {
  const remove = useDeleteWorkspace();
  const close = () => {
    remove.reset();
    onClose();
  };
  return (
    <Dialog open={workspace !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-heading text-xl">Delete “{workspace?.name}”?</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-base text-foreground">
              <p>
                This permanently deletes the workspace together with its uploaded files, answers, reports and templates.
              </p>
              <p className="font-medium">This cannot be undone.</p>
            </div>
          </DialogDescription>
        </DialogHeader>
        {remove.isError && <FormMessage>{errorMessage(remove.error)}</FormMessage>}
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Keep it
          </Button>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => workspace && remove.mutate(workspace.id, { onSuccess: close })}
          >
            {remove.isPending ? 'Deleting…' : 'Delete workspace'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
