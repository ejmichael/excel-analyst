import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { ApiError } from '@/api/client';
import { AskForm, questionError } from './AskForm';
import { ASK_SLOW_MS, ASK_STAGE_MS, AskWaiting } from './AskWaiting';
import { describeAskError } from './askErrors';

function Harness({ onSubmit, asking = false }: { onSubmit: (q: string) => void; asking?: boolean }) {
  const [question, setQuestion] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <AskForm
      question={question}
      hint=""
      asking={asking}
      error={error}
      onQuestionChange={setQuestion}
      onHintChange={() => {}}
      onSubmit={() => {
        const problem = questionError(question);
        setError(problem);
        if (!problem) onSubmit(question);
      }}
    />
  );
}

describe('AskForm', () => {
  it('needs 3 to 500 characters, with a live count and a written error', async () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    const box = screen.getByLabelText('Your question');
    await userEvent.type(box, 'hi');
    expect(screen.getByText('2 of 500 characters')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(screen.getByText('Write at least 3 characters.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(box).toHaveAttribute('maxLength', '500');
    expect(questionError('x'.repeat(501))).toMatch(/500 characters or fewer/);
  });

  it('Enter asks; Shift+Enter makes a new line', async () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    const box = screen.getByLabelText('Your question');
    await userEvent.type(box, 'Total sales{Shift>}{Enter}{/Shift}by store');
    expect(box).toHaveValue('Total sales\nby store');
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.type(box, '{Enter}');
    expect(onSubmit).toHaveBeenCalledWith('Total sales\nby store');
  });

  it('is disabled while asking', () => {
    render(<Harness onSubmit={vi.fn()} asking />);
    expect(screen.getByLabelText('Your question')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Asking…' })).toBeDisabled();
    expect(screen.getByLabelText('Show it as')).toBeDisabled();
  });

  it('offers every "Show it as" choice in words', () => {
    render(<Harness onSubmit={vi.fn()} />);
    const options = Array.from(screen.getByLabelText('Show it as').querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toEqual(['Let Analyst choose', 'Table', 'Bar chart', 'Line chart', 'Area chart', 'Pie chart', 'One big number']);
  });
});

describe('AskWaiting', () => {
  afterEach(() => vi.useRealTimers());

  it('moves through the stages on a timer and says when it is taking longer', () => {
    vi.useFakeTimers();
    render(<AskWaiting />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Reading your question');
    expect(status).toHaveTextContent('You can leave this page; the answer will be in your history.');
    act(() => vi.advanceTimersByTime(ASK_STAGE_MS));
    expect(status).toHaveTextContent('Running the numbers');
    act(() => vi.advanceTimersByTime(ASK_STAGE_MS * 2));
    expect(status).toHaveTextContent('Writing it up');
    expect(status).not.toHaveTextContent('longer than usual');
    act(() => vi.advanceTimersByTime(ASK_SLOW_MS));
    expect(status).toHaveTextContent('This is taking longer than usual');
    expect(status).toHaveAttribute('aria-live', 'polite');
  });
});

describe('describeAskError', () => {
  const dataset = { expires_at: '2026-12-02T10:00:00+02:00' };
  const err = (status: number, code: ConstructorParameters<typeof ApiError>[1], over: { details?: unknown; serverMessage?: string; retry?: number } = {}) => {
    const e = new ApiError(status, code, 'x', over.details, over.serverMessage ?? null);
    e.retryAfterSeconds = over.retry ?? null;
    return e;
  };

  it('402 plan_limit opens the upgrade dialog with its details', () => {
    const details = { limit_key: 'max_questions_per_month', limit: 20, used: 20, upgrade_to: 'solo' };
    expect(describeAskError(err(402, 'plan_limit', { details }), dataset)).toEqual({ kind: 'plan_limit', details });
  });

  it('409 dataset_not_ready points to the dataset page', () => {
    expect(describeAskError(err(409, 'dataset_not_ready'), dataset)).toMatchObject({ kind: 'not_ready' });
  });

  it('410 dataset_expired names the date', () => {
    expect(describeAskError(err(410, 'dataset_expired'), dataset)).toEqual({
      kind: 'expired',
      message: 'The original file was deleted on 2 December 2026. You can still read your earlier answers.',
    });
  });

  it("422 cannot_answer shows the server's message", () => {
    expect(describeAskError(err(422, 'cannot_answer', { serverMessage: 'This file has no weather data.' }), dataset)).toEqual({
      kind: 'cannot_answer',
      message: 'This file has no weather data.',
    });
  });

  it('422 validation_failed shows beside the question box', () => {
    const e = err(422, 'validation_failed', { details: { fields: [{ location: 'body', path: 'question', message: 'Too short' }] } });
    expect(describeAskError(e, dataset)).toEqual({ kind: 'field', message: 'Too short' });
  });

  it('429 says how long to wait when Retry-After is known, else "a moment"', () => {
    expect(describeAskError(err(429, 'rate_limited', { retry: 12 }), dataset).kind === 'general' && describeAskError(err(429, 'rate_limited', { retry: 12 }), dataset)).toMatchObject({
      message: "You're asking quickly; wait 12 seconds and try again.",
    });
    expect(describeAskError(err(429, 'rate_limited'), dataset)).toMatchObject({ message: "You're asking quickly; wait a moment and try again." });
  });

  it('502 llm_failed says nothing was used from the allowance', () => {
    expect(describeAskError(err(502, 'llm_failed'), dataset)).toMatchObject({
      message: "We couldn't get an answer just now. Nothing was used from your allowance. Try again.",
    });
  });

  it("a 500 never shows the server's own text (it could contain SQL errors)", () => {
    const view = describeAskError(err(500, 'internal', { serverMessage: 'Binder Error: column "x" not found' }), dataset);
    expect(view).toEqual({ kind: 'general', message: 'Something went wrong on our side. Please try again.' });
  });

  it('a dropped connection says the answer may be in the history', () => {
    expect(describeAskError(new ApiError(0, 'internal', 'network'), dataset)).toMatchObject({ kind: 'network' });
  });
});
