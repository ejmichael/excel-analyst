import { Link, useParams, useSearchParams } from 'react-router';
import { ArrowLeft, Construction } from 'lucide-react';
import { PageHeader } from '@/features/shell/pages';

/** Asking arrives in the next part; suggested questions link here so the flow can be seen. */
export function AskPlaceholderPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const question = params.get('q');
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link
        to={`/datasets/${id}`}
        className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Back to the file
      </Link>
      <PageHeader title="Ask a question" />
      <div className="flex items-start gap-3 rounded-xl border bg-card p-6">
        <Construction className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="space-y-2">
          <p className="font-medium">Asking opens in the next part.</p>
          {question && (
            <p>
              Your question: <q className="font-medium">{question}</q>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
