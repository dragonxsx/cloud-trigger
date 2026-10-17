import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import prettyMilliseconds from 'pretty-ms';

dayjs.extend(relativeTime);

export const fromNow = (iso: string | null | undefined): string =>
  iso ? dayjs(iso).fromNow() : '—';
export const dateTime = (iso: string | null | undefined): string =>
  iso ? dayjs(iso).format('MMM D, HH:mm:ss') : '—';

export const duration = (ms: number | null | undefined): string =>
  ms === null || ms === undefined ? '—' : prettyMilliseconds(ms);

export const percent = (ratio: number | null): string =>
  ratio === null ? '—' : `${(ratio * 100).toFixed(ratio > 0.999 && ratio < 1 ? 2 : 1)}%`;
