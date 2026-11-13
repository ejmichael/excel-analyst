import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// Page tests render the whole app; under the full parallel run they can take more than the default 1 s to settle.
configure({ asyncUtilTimeout: 5000 });

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
