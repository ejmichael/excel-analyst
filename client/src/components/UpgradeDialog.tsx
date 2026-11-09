import type { Plan, PlanLimitDetails } from '@/api/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { describePlanLimit, describeUpgrade } from './planLimit';

interface UpgradeDialogProps {
  /** From ApiError.planLimit (402 plan_limit). The dialog is open while this is set. */
  details: PlanLimitDetails | null;
  plan: Plan;
  onClose: () => void;
}

/** Reusable dialog for 402 plan_limit: says in plain words what was hit and which plan includes more. */
export function UpgradeDialog({ details, plan, onClose }: UpgradeDialogProps) {
  return (
    <Dialog open={details !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-heading text-xl">You have reached a plan limit</DialogTitle>
          {details && (
            <DialogDescription asChild>
              <div className="space-y-2 text-base text-foreground">
                <p>{describePlanLimit(details, plan)}</p>
                <p>{describeUpgrade(details.upgrade_to)}</p>
              </div>
            </DialogDescription>
          )}
        </DialogHeader>
        <DialogFooter className="flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-end">
          <div className="flex flex-col gap-1 sm:items-end">
            <Button disabled aria-describedby="plans-soon-note">
              See plans
            </Button>
            <p id="plans-soon-note" className="text-sm text-muted-foreground">
              Plans open soon.
            </p>
          </div>
          <Button variant="outline" onClick={onClose} className="sm:self-start">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
