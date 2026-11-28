import { describe, expect, it } from 'vitest';
import { fmtLocalDateInput, followupUrgency, localDateInputToIso, relTime } from '../format.js';

describe('format helpers', () => {
  it('formats relTime by local calendar day and time', () => {
    const now = new Date(2026, 10, 28, 10, 0, 0);
    const sameDay = new Date(2026, 10, 28, 9, 42, 0).toISOString();
    const yesterdayLessThan24h = new Date(2026, 10, 27, 18, 5, 0).toISOString();
    const yesterdayLateNight = new Date(2026, 10, 27, 23, 59, 0).toISOString();
    const justAfterMidnight = new Date(2026, 10, 28, 0, 1, 0);
    const earlierThisYear = new Date(2026, 10, 25, 14, 20, 0).toISOString();
    const crossYear = new Date(2025, 11, 20, 16, 10, 0).toISOString();

    expect(relTime(sameDay, now)).toBe('今天 09:42');
    expect(relTime(yesterdayLessThan24h, now)).toBe('昨天 18:05');
    expect(relTime(yesterdayLateNight, justAfterMidnight)).toBe('昨天 23:59');
    expect(relTime(earlierThisYear, now)).toBe('11-25 14:20');
    expect(relTime(crossYear, now)).toBe('2025-12-20');
    expect(relTime(null, now)).toBe('');
    expect(relTime(undefined, now)).toBe('');
    expect(relTime('not-a-date', now)).toBe('');
  });

  it('round-trips local date input and ISO timestamp', () => {
    const iso = localDateInputToIso('2026-11-28');
    expect(iso).not.toBeNull();
    expect(fmtLocalDateInput(iso)).toBe('2026-11-28');
    expect(localDateInputToIso('')).toBeNull();
    expect(fmtLocalDateInput(null)).toBe('');
    expect(fmtLocalDateInput('2026-11-28')).toBe('2026-11-28');
  });

  it('classifies followupUrgency accurately against local day boundaries', () => {
    const now = new Date(2026, 10, 28, 10, 0, 0);
    const overdue = new Date(2026, 10, 27, 23, 59, 59).toISOString();
    const todayEarly = new Date(2026, 10, 28, 0, 0, 0).toISOString();
    const todayLate = new Date(2026, 10, 28, 23, 59, 0).toISOString();
    const upcoming = new Date(2026, 10, 29, 0, 0, 0).toISOString();

    expect(followupUrgency(overdue, now)).toBe('overdue');
    expect(followupUrgency(todayEarly, now)).toBe('today');
    expect(followupUrgency(todayLate, now)).toBe('today');
    expect(followupUrgency(upcoming, now)).toBe('upcoming');
    expect(followupUrgency(null, now)).toBeNull();
  });
});
