import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { PlanLimitDetails } from '@/api/types';
import { UpgradeDialog } from './UpgradeDialog';

describe('UpgradeDialog', () => {
  it('explains a max_workspaces limit in plain words', () => {
    const details: PlanLimitDetails = { limit_key: 'max_workspaces', limit: 1, used: 1, upgrade_to: 'practice' };
    render(<UpgradeDialog details={details} plan="free" onClose={vi.fn()} />);

    expect(screen.getByText('Your Free plan includes 1 workspace. You are using 1.')).toBeInTheDocument();
    expect(screen.getByText('The Practice plan includes more.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'See plans' })).toBeDisabled();
    expect(screen.getByText('Plans open soon.')).toBeInTheDocument();
  });

  it('explains a branding refusal (feature flag off)', () => {
    const details: PlanLimitDetails = { limit_key: 'branding', limit: 0, used: 0, upgrade_to: 'solo' };
    render(<UpgradeDialog details={details} plan="free" onClose={vi.fn()} />);

    expect(screen.getByText('Your own logo and brand colour are not included in your Free plan.')).toBeInTheDocument();
    expect(screen.getByText('The Solo plan includes more.')).toBeInTheDocument();
  });

  it('says so when no plan offers more', () => {
    const details: PlanLimitDetails = { limit_key: 'max_workspaces', limit: 30, used: 30, upgrade_to: null };
    render(<UpgradeDialog details={details} plan="practice_plus" onClose={vi.fn()} />);

    expect(screen.getByText('Your Practice Plus plan includes 30 workspaces. You are using 30.')).toBeInTheDocument();
    expect(screen.getByText('No plan includes more of this at the moment.')).toBeInTheDocument();
  });

  it('explains a row-limit failure from Dataset.error_details and names the plan', () => {
    const details: PlanLimitDetails = { limit_key: 'max_rows', limit: 20000, used: 20001, upgrade_to: 'solo' };
    render(<UpgradeDialog details={details} plan="free" onClose={vi.fn()} />);
    const n = (v: number) => new Intl.NumberFormat('en-ZA', { maximumFractionDigits: 0 }).format(v);
    // en-ZA groups with a no-break space, which the default text matcher normalises; compare raw text.
    const sentence = `Your Free plan allows files of up to ${n(20000)} rows. This file has ${n(20001)}.`;
    expect(screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === sentence)).toBeInTheDocument();
    expect(screen.getByText('The Solo plan includes more.')).toBeInTheDocument();
  });

  it('shows max_file_mb sizes as megabytes with up to 2 decimals', () => {
    const details: PlanLimitDetails = { limit_key: 'max_file_mb', limit: 5, used: 5.72, upgrade_to: 'solo' };
    render(<UpgradeDialog details={details} plan="free" onClose={vi.fn()} />);
    expect(screen.getByText('Your Free plan allows files of up to 5 MB. This file is 5,72 MB.')).toBeInTheDocument();
  });

  it('names no plan for a limit the client found itself', () => {
    render(<UpgradeDialog details={{ limit_key: 'max_file_mb', limit: 5, used: 6.01 }} plan="free" onClose={vi.fn()} />);
    expect(screen.queryByText(/plan includes more/)).not.toBeInTheDocument();
  });

  it('is closed when there are no details', () => {
    render(<UpgradeDialog details={null} plan="free" onClose={vi.fn()} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
