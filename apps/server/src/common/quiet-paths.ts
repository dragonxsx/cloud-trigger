const QUIET_PATHS = ['/health', '/metrics'];

export const isQuietPath = (url: string | undefined): boolean =>
  url !== undefined &&
  QUIET_PATHS.some(
    (path) => url === path || url.startsWith(`${path}/`) || url.startsWith(`${path}?`),
  );
