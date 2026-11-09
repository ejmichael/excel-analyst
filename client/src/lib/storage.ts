/**
 * localStorage for per-viewer conveniences only. Every access is wrapped because storage can be
 * missing or throw (private windows, blocked site data). The app must work when these return null.
 */
export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Not fatal: the value just will not be remembered.
  }
}
