import type { IsoDate } from "./types.js";

const DAY_MS = 86_400_000;

export function toIsoDate(d: Date): IsoDate {
  return d.toISOString().slice(0, 10);
}

/** Parses YYYY-MM-DD as midnight UTC. */
export function parseIsoDate(date: IsoDate): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid ISO date: ${date}`);
  return new Date(`${date}T00:00:00.000Z`);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return toIsoDate(new Date(parseIsoDate(date).getTime() + days * DAY_MS));
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((parseIsoDate(b).getTime() - parseIsoDate(a).getTime()) / DAY_MS);
}

/** Inclusive list of dates from start to end. */
export function dateRange(start: IsoDate, end: IsoDate): IsoDate[] {
  const n = daysBetween(start, end);
  return Array.from({ length: n + 1 }, (_, i) => addDays(start, i));
}

/** 0 = Sunday ... 6 = Saturday, in UTC. */
export function dayOfWeek(date: IsoDate): number {
  return parseIsoDate(date).getUTCDay();
}

export function isWeekend(date: IsoDate): boolean {
  const d = dayOfWeek(date);
  return d === 0 || d === 6;
}
