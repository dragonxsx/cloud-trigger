const formatters = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  const existing = formatters.get(timeZone);
  if (existing) {
    return existing;
  }
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  formatters.set(timeZone, created);

  return created;
};

export function toWallClock(instant: Date, timeZone: string): Date {
  const field = (type: Intl.DateTimeFormatPartTypes) =>
    Number(
      formatterFor(timeZone)
        .formatToParts(instant)
        .find((p) => p.type === type)?.value ?? 0,
    );

  return new Date(
    Date.UTC(
      field('year'),
      field('month') - 1,
      field('day'),
      field('hour'),
      field('minute'),
      field('second'),
      instant.getUTCMilliseconds(),
    ),
  );
}

export const utcOffsetMs = (instant: Date, timeZone: string): number =>
  toWallClock(instant, timeZone).getTime() - instant.getTime();

export function fromWallClock(wall: Date, timeZone: string): Date {
  const guess = wall.getTime();
  const offsetAt = (instant: number) => utcOffsetMs(new Date(instant), timeZone);
  const first = guess - offsetAt(guess);
  const corrected = guess - offsetAt(first);
  if (toWallClock(new Date(corrected), timeZone).getTime() === guess) {
    return new Date(corrected);
  }
  const pastDstGap = Math.max(first, corrected);

  return new Date(pastDstGap);
}
