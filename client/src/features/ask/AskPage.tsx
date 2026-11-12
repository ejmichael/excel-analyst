import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { ArrowLeft, CircleAlert, Info, MessageSquareText } from 'lucide-react';
import { errorMessage, isApiError } from '@/api/client';
import type { AskRequest, Block, ChartType, DatasetDetail } from '@/api/types';
import { useMe } from '@/auth/useMe';
import { FormMessage } from '@/components/FormField';
import { InlineLoading } from '@/components/PageStatus';
import { UpgradeDialog } from '@/components/UpgradeDialog';
import { Button } from '@/components/ui/button';
import { env } from '@/env';
import { formatDate, formatNumber } from '@/lib/format';
import { useDatasetPolling } from '@/features/datasets/queries';
import { AnswerCard } from './AnswerCard';
import { AnswerHistory } from './AnswerHistory';
import { describeAskError, type AskErrorView } from './askErrors';
import { AskForm, questionError } from './AskForm';
import { AskWaiting } from './AskWaiting';
import type { DatasetState } from './HowCalculated';
import { useAsk } from './queries';

function BackLink({ id, name }: { id: string; name?: string }) {
  return (
    <Link
      to={`/datasets/${id}`}
      className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
    >
      <ArrowLeft className="size-4" aria-hidden />
      {name ? `Back to ${name}` : 'Back to the file'}
    </Link>
  );
}

export function AskPage() {
  const { id = '' } = useParams();
  const dataset = useDatasetPolling(id);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <BackLink id={id} name={dataset.data?.name} />
      {dataset.isPending ? (
        <InlineLoading label="Loading the file" />
      ) : dataset.isError ? (
        <FormMessage>
          {isApiError(dataset.error) && dataset.error.code === 'not_found'
            ? 'We could not find this file. It may have been deleted.'
            : errorMessage(dataset.error)}
        </FormMessage>
      ) : (
        <AskView dataset={dataset.data} />
      )}
    </div>
  );
}

function AskView({ dataset }: { dataset: DatasetDetail }) {
  const me = useMe();
  const ask = useAsk(dataset.id);
  const [params, setParams] = useSearchParams();
  const [question, setQuestion] = useState('');
  const [hint, setHint] = useState<'' | ChartType>('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [errorView, setErrorView] = useState<AskErrorView | null>(null);
  const [latest, setLatest] = useState<Block | null>(null);
  const latestHeading = useRef<HTMLHeadingElement>(null);
  const askedFromUrl = useRef(false);

  const state: DatasetState = { exists: true, status: dataset.status, expires_at: dataset.expires_at, columns: dataset.columns };
  const suggestions = dataset.suggestions;

  const submit = (text: string, source: AskRequest['source']) => {
    const problem = questionError(text);
    setFieldError(problem);
    if (problem || ask.isPending) return;
    setErrorView(null);
    ask.mutate(
      { question: text.trim(), source, ...(hint ? { chart_hint: hint } : {}) },
      {
        onSuccess: (block) => {
          setLatest(block);
          setQuestion('');
        },
        onError: (error) => {
          const view = describeAskError(error, dataset);
          if (view.kind === 'field') setFieldError(view.message);
          else setErrorView(view);
        },
      },
    );
  };

  const askText = (text: string, source: AskRequest['source']) => {
    setQuestion(text);
    submit(text, source);
  };

  // Arriving with ?q= (a suggestion card): ask once, then drop q so a reload does not ask again.
  useEffect(() => {
    const q = params.get('q');
    if (!q || askedFromUrl.current) return;
    askedFromUrl.current = true;
    const next = new URLSearchParams(params);
    next.delete('q');
    setParams(next, { replace: true });
    askText(q, suggestions.some((s) => s.question === q.trim()) ? 'suggested' : 'user');
    // Runs once per arrival on purpose (empty deps); askedFromUrl also guards StrictMode's double effect.
  }, []);

  // Show the newest answer: scroll to it and move focus to its heading.
  useEffect(() => {
    if (!latest) return;
    latestHeading.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    latestHeading.current?.focus({ preventScroll: true });
  }, [latest]);

  const used = me.data?.usage.questions;
  const limit = me.data?.limits.max_questions_per_month;
  const disabledReason =
    dataset.status === 'expired'
      ? null
      : dataset.status === 'ready'
        ? null
        : dataset.status === 'failed'
          ? 'This file could not be read, so it cannot answer questions. Open the file to try other options.'
          : 'This file is still being read. You can ask as soon as it is ready.';

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold break-words sm:text-3xl">Ask about {dataset.name}</h1>
        {used !== undefined && limit !== undefined && (
          <p className="text-sm text-muted-foreground tabular">
            {formatNumber(used, 0)} of {formatNumber(limit, 0)} questions used this month
          </p>
        )}
      </header>

      {env.useMocks && (
        <p className="rounded-md border border-dashed bg-card/60 px-3 py-2 text-sm text-muted-foreground">
          Mock mode: answers are example data, not calculated from your file. Questions with “slow”, “weather”, “busy” or
          “fail” show the waiting state and the errors.
        </p>
      )}

      {dataset.status === 'expired' && (
        <p className="flex items-start gap-2 rounded-xl border bg-card p-4 text-sm">
          <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          {dataset.expires_at
            ? `The original file was deleted on ${formatDate(dataset.expires_at)}. You can still read your earlier answers.`
            : 'The original file was deleted. You can still read your earlier answers.'}
        </p>
      )}

      <AskForm
        question={question}
        hint={hint}
        asking={ask.isPending}
        error={fieldError}
        disabledReason={disabledReason}
        onQuestionChange={(value) => {
          setQuestion(value);
          if (fieldError) setFieldError(null);
        }}
        onHintChange={setHint}
        onSubmit={() => submit(question, 'user')}
      />

      {!latest && !ask.isPending && suggestions.length > 0 && !errorView && (
        <Suggestions suggestions={suggestions} disabled={Boolean(disabledReason)} onAsk={(q) => askText(q, 'suggested')} />
      )}

      {ask.isPending && <AskWaiting />}

      {errorView && <AskErrorPanel view={errorView} dataset={dataset} onAsk={(q) => askText(q, 'suggested')} />}

      {me.data && (
        <UpgradeDialog
          details={errorView?.kind === 'plan_limit' ? errorView.details : null}
          plan={me.data.plan}
          onClose={() => setErrorView(null)}
        />
      )}

      {latest && (
        <section aria-label="Newest answer">
          {/* Keyed by answer: a new answer gets a fresh card (closed panels, chart view), not the last one's state. */}
          <AnswerCard
            key={latest.id}
            block={latest}
            dataset={state}
            newest
            headingRef={latestHeading}
            asking={ask.isPending}
            onFollowUp={(q) => askText(q, 'user')}
            onDeleted={() => setLatest(null)}
          />
        </section>
      )}

      <AnswerHistory
        datasetId={dataset.id}
        dataset={state}
        excludeId={latest?.id ?? null}
        asking={ask.isPending}
        onFollowUp={(q) => askText(q, 'user')}
      />
    </div>
  );
}

function Suggestions({ suggestions, disabled, onAsk }: { suggestions: DatasetDetail['suggestions']; disabled: boolean; onAsk: (q: string) => void }) {
  return (
    <section aria-labelledby="ask-suggestions" className="space-y-2">
      <h2 id="ask-suggestions" className="text-base font-semibold">
        Questions you could ask
      </h2>
      <div className="grid gap-2 sm:grid-cols-2">
        {suggestions.slice(0, 5).map((s) => (
          <Button
            key={s.question}
            variant="outline"
            disabled={disabled}
            className="h-auto min-h-11 justify-start gap-2 py-3 text-left whitespace-normal"
            onClick={() => onAsk(s.question)}
          >
            <MessageSquareText className="mt-0.5 shrink-0 self-start text-primary" aria-hidden />
            <span>{s.question}</span>
          </Button>
        ))}
      </div>
    </section>
  );
}

function AskErrorPanel({ view, dataset, onAsk }: { view: AskErrorView; dataset: DatasetDetail; onAsk: (q: string) => void }) {
  if (view.kind === 'plan_limit' || view.kind === 'field') return null;

  if (view.kind === 'cannot_answer') {
    return (
      <div role="alert" className="space-y-3 rounded-xl border border-warning/50 bg-warning-bg p-4">
        <div className="flex items-start gap-2">
          <CircleAlert className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden />
          <div className="space-y-1">
            <p className="font-medium">Analyst can't answer that from this file</p>
            <p>{view.message}</p>
            <p className="text-sm">Tip: ask about the columns this file has, or say it in other words.</p>
          </div>
        </div>
        {dataset.suggestions.length > 0 && <Suggestions suggestions={dataset.suggestions} disabled={false} onAsk={onAsk} />}
      </div>
    );
  }

  return (
    <div role="alert" className="space-y-2 rounded-xl border border-destructive/40 bg-card p-4">
      <div className="flex items-start gap-2">
        <CircleAlert className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />
        <p>{view.message}</p>
      </div>
      {view.kind === 'not_ready' && (
        <Link to={`/datasets/${dataset.id}`} className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4">
          Open the file
        </Link>
      )}
    </div>
  );
}
