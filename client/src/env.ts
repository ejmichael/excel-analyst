/** Public build-time config. Everything here ships to the browser, so it must never hold a secret. */
export const env = {
  apiUrl: (import.meta.env.VITE_API_URL ?? 'http://localhost:4000').replace(/\/+$/, ''),
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL ?? '',
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY ?? '',
  appName: import.meta.env.VITE_APP_NAME || 'Analyst',
  useMocks: import.meta.env.VITE_USE_MOCKS === 'true',
};

export const API_BASE = `${env.apiUrl}/api/v1`;
