/** The small square logo mark. Decorative: the app name always sits next to it. */
export function BrandMark({ className = 'size-8' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden focusable="false">
      <rect width="32" height="32" rx="8" fill="var(--primary)" />
      <path d="M9 22V14M16 22V9M23 22v-5" stroke="var(--background)" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
