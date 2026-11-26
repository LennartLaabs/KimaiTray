/** "70" → "1 h 10 min", "45" → "45 min", "120" → "2 h". */
export function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** "9:05" for a time field. */
export function clockText(date: Date): string {
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * Reads a time typed into a field ("9", "9:30", "0930", "9.30") as that time
 * on the day of `day`; `null` when it is none.
 */
export function parseClock(text: string, day: Date): Date | null {
  const match = /^(\d{1,2})(?:[:.]?(\d{2}))?$/.exec(text.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (hour > 23 || minute > 59) return null;
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
}
