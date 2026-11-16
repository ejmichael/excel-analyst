/**
 * The slug in a download's file name (`<slug>-<YYYY-MM-DD>.csv|.xlsx`): ASCII letters, digits and hyphens only,
 * at most 60 characters, never empty (accents are dropped, everything else becomes a hyphen).
 */
export function slugify(title: string, fallback: string): string {
  const s = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return s || fallback;
}
