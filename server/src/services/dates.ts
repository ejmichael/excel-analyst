import type { ISODate, ISODateTime } from '../types/api.js';

/** Africa/Johannesburg is UTC+2 all year (no DST). */
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;

/** First day of the current month in SAST, as 'YYYY-MM-DD'. 22:30 UTC on the last day is already the 1st in SAST. */
export function monthStartSast(now: Date = new Date()): ISODate {
  const sast = new Date(now.getTime() + SAST_OFFSET_MS);
  const year = sast.getUTCFullYear();
  const month = String(sast.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}-01`;
}

/** The instant the current SAST month began, for filtering timestamptz columns. */
export function monthStartSastInstant(now: Date = new Date()): ISODateTime {
  return `${monthStartSast(now)}T00:00:00+02:00`;
}
