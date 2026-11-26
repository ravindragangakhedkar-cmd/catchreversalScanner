/** India-market date helpers. Dates are always derived in Asia/Kolkata, never from the Vercel host timezone. */
export function getIstDateParts(now: Date = new Date()): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: read('year'), month: read('month'), day: read('day') };
}

export function getIstTradingDate(now: Date = new Date()): string {
  const { year, month, day } = getIstDateParts(now);
  return `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
}

export function getIstIsoDate(now: Date = new Date()): string {
  const value = getIstTradingDate(now);
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

export function getLastCompletedWeekdayDate(now: Date = new Date()): string {
  const { year, month, day } = getIstDateParts(now);
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
  const weekday = parts.find((part) => part.type === 'weekday')?.value ?? 'Mon';
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
  let date = new Date(Date.UTC(year, month - 1, day));
  // Before the cash session opens, the prior weekday is the latest completed session.
  if (['Sat', 'Sun'].includes(weekday) || hour * 60 + minute < 9 * 60 + 15) date.setUTCDate(date.getUTCDate() - 1);
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() - 1);
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
}

function normalizeExpiry(value: unknown): string | null {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length !== 8) return null;
  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) return null;
  return digits;
}

function lastTuesday(year: number, monthIndex: number): string {
  const date = new Date(Date.UTC(year, monthIndex + 1, 0));
  while (date.getUTCDay() !== 2) date.setUTCDate(date.getUTCDate() - 1);
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
}

/** Select the nearest future monthly expiry from Nubra's actual contract calendar. */
export function getNextMonthlyExpiry(expiries: unknown[] = [], now: Date = new Date()): string {
  const today = getIstTradingDate(now);
  const monthlyByMonth = new Map<string, string>();
  const nowParts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
  const nowMinutes = Number(nowParts.find((part) => part.type === 'hour')?.value ?? '0') * 60 + Number(nowParts.find((part) => part.type === 'minute')?.value ?? '0');
  for (const raw of expiries) {
    const expiry = normalizeExpiry(raw);
    if (!expiry || expiry < today || (expiry === today && nowMinutes > 15 * 60 + 30)) continue;
    const monthKey = expiry.slice(0, 6);
    const previous = monthlyByMonth.get(monthKey);
    if (!previous || expiry > previous) monthlyByMonth.set(monthKey, expiry);
  }
  const candidates = [...monthlyByMonth.values()].sort();
  if (candidates.length) return candidates[0];

  // Fallback when the broker omits all_expiries. NSE/BSE monthly contracts currently
  // use Tuesday expiries; the next available broker calendar should override this fallback.
  const { year, month } = getIstDateParts(now);
  for (let offset = 0; offset < 3; offset += 1) {
    const targetMonth = month - 1 + offset;
    const targetYear = year + Math.floor(targetMonth / 12);
    const monthIndex = ((targetMonth % 12) + 12) % 12;
    const fallback = lastTuesday(targetYear, monthIndex);
    if (fallback > today || (fallback === today && nowMinutes <= 15 * 60 + 30)) return fallback;
  }
  throw new Error('Unable to determine the next monthly expiry from Nubra contract data.');
}

/** Convert a date-only IST trading date to the UTC timestamps used by Nubra chart queries. */
export function getIstSessionUtcRange(yyyymmdd: string): { start: string; end: string; nextDay: string } {
  const year = Number(yyyymmdd.slice(0, 4));
  const month = Number(yyyymmdd.slice(4, 6));
  const day = Number(yyyymmdd.slice(6, 8));
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const nextDay = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
  const iso = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
  return { start: `${iso}T03:45:00.000Z`, end: `${iso}T10:00:00.000Z`, nextDay };
}
