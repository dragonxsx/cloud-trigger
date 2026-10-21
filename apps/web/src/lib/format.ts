import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import prettyMilliseconds from 'pretty-ms';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(relativeTime);

type Instant = string | number | Date;

export const localTimeZone = (): string => dayjs.tz.guess();

const isValidZone = (zone: string): boolean => {
  try {
    return Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone !== '';
  } catch {
    return false;
  }
};

const resolveZone = (zone: string | undefined): string =>
  zone !== undefined && isValidZone(zone) ? zone : localTimeZone();

export const zoneAbbreviation = (instant: Instant, zone?: string): string => {
  const resolved = resolveZone(zone);
  const part = new Intl.DateTimeFormat('en-US', { timeZone: resolved, timeZoneName: 'short' })
    .formatToParts(new Date(instant))
    .find((p) => p.type === 'timeZoneName');

  return part?.value ?? resolved;
};

const inZone = (instant: Instant, zone: string | undefined) => dayjs(instant).tz(resolveZone(zone));

const datePattern = (instant: Instant, zone: string | undefined): string =>
  inZone(instant, zone).year() === dayjs().tz(resolveZone(zone)).year() ? 'MMM D' : 'MMM D, YYYY';

export const fromNow = (iso: string | null | undefined): string =>
  iso ? dayjs(iso).fromNow() : '—';

export const dateTime = (iso: Instant | null | undefined, zone?: string): string =>
  iso === null || iso === undefined || iso === ''
    ? '—'
    : `${inZone(iso, zone).format(`${datePattern(iso, zone)}, HH:mm:ss`)} ${zoneAbbreviation(iso, zone)}`;

export const timeOfDay = (iso: Instant | null | undefined, zone?: string): string =>
  iso === null || iso === undefined || iso === ''
    ? '—'
    : `${inZone(iso, zone).format('HH:mm')} ${zoneAbbreviation(iso, zone)}`;

export const dateTimeWithLocal = (iso: Instant | null | undefined, zone: string): string => {
  if (iso === null || iso === undefined || iso === '') {
    return '—';
  }
  const primary = dateTime(iso, zone);
  if (resolveZone(zone) === localTimeZone()) {
    return primary;
  }

  return `${primary} · ${inZone(iso, undefined).format('HH:mm')} your time`;
};

export const chartTime = (instant: Instant): string =>
  `${inZone(instant, undefined).format(`${datePattern(instant, undefined)}, HH:mm`)} ${zoneAbbreviation(instant)}`;

export const duration = (ms: number | null | undefined): string =>
  ms === null || ms === undefined ? '—' : prettyMilliseconds(ms);

export const percent = (ratio: number | null): string =>
  ratio === null ? '—' : `${(ratio * 100).toFixed(ratio > 0.999 && ratio < 1 ? 2 : 1)}%`;
