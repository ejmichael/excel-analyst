import { formatNumber } from '@/lib/format';

export const LOGO_MAX_BYTES = 1024 * 1024;
export const LOGO_ACCEPT = '.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp';
const ALLOWED = ['png', 'jpg', 'jpeg', 'webp'];

/**
 * Checks done before sending a logo, to save a wasted upload. The server decides by the file's bytes and stays
 * authoritative (415, 413 and 422 are shown in words).
 */
export function checkLogoFile(file: File): string | null {
  const extension = file.name.toLowerCase().split('.').pop() ?? '';
  if (extension === 'svg' || extension === 'gif' || file.type === 'image/svg+xml' || file.type === 'image/gif') {
    return 'SVG and GIF logos are not accepted. Use a PNG, JPEG or WebP image.';
  }
  if (!ALLOWED.includes(extension)) return `“${file.name}” is not a PNG, JPEG or WebP image.`;
  if (file.size === 0) return `“${file.name}” is empty.`;
  if (file.size > LOGO_MAX_BYTES) {
    // Megabytes rounded up to 2 decimals, the same way the server counts them.
    const mb = Math.ceil((file.size / LOGO_MAX_BYTES) * 100) / 100;
    return `The logo must be 1 MB or smaller. This file is ${formatNumber(mb, 2)} MB.`;
  }
  return null;
}
