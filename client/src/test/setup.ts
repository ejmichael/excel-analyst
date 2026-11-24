import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// Page tests render the whole app; under the full parallel run (with lazy chart bundles) they can take several seconds
// to settle. Tests themselves time out at 30 s (vite.config.ts).
configure({ asyncUtilTimeout: 10_000 });

// jsdom has no ResizeObserver; Recharts' ResponsiveContainer needs one. Charts then render at size 0, which is
// enough for tests that check labels, roles and the table view.
if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver = ResizeObserverStub;
}
