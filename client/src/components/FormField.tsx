import { useId, useState, type ComponentProps, type ReactNode } from 'react';
import { AlertCircle, Eye, EyeOff } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

interface FieldProps extends ComponentProps<'input'> {
  label: string;
  error?: string;
  hint?: ReactNode;
}

/** A labelled input with its hint and error written out in words (never colour alone). */
export function TextField({ label, error, hint, id, className, ref, ...props }: FieldProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={inputId}>{label}</Label>
      <Input
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
        {...props}
      />
      {hint && !error && (
        <p id={hintId} className="text-sm text-muted-foreground">
          {hint}
        </p>
      )}
      <FieldError id={errorId} message={error} />
    </div>
  );
}

export function FieldError({ id, message }: { id?: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="flex items-start gap-1.5 text-sm text-destructive">
      <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{message}</span>
    </p>
  );
}

/** Password input with a show/hide toggle. */
export function PasswordField({ label, error, hint, id, className, ref, ...props }: Omit<FieldProps, 'type'>) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const [visible, setVisible] = useState(false);
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={inputId}>{label}</Label>
      <div className="relative">
        <Input
          ref={ref}
          id={inputId}
          type={visible ? 'text' : 'password'}
          className="pr-12"
          aria-invalid={error ? true : undefined}
          aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
          {...props}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          aria-controls={inputId}
          className="absolute top-0 right-0 inline-flex size-11 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {visible ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
        </button>
      </div>
      {hint && !error && (
        <p id={hintId} className="text-sm text-muted-foreground">
          {hint}
        </p>
      )}
      <FieldError id={errorId} message={error} />
    </div>
  );
}

/** A form-level message: an error, or a neutral notice. */
export function FormMessage({ tone = 'error', children }: { tone?: 'error' | 'success' | 'info'; children: ReactNode }) {
  if (!children) return null;
  const styles = {
    error: 'border-destructive/40 bg-destructive/5 text-destructive',
    success: 'border-primary/40 bg-accent text-foreground',
    info: 'border-border bg-secondary text-foreground',
  }[tone];
  const prefix = { error: 'Error: ', success: '', info: '' }[tone];
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cn('rounded-md border px-3 py-2.5 text-sm', styles)}>
      {prefix && <span className="font-medium">{prefix}</span>}
      {children}
    </div>
  );
}
