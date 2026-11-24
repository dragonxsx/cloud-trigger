const WEBHOOK_PATH = /^(\/hooks\/[^/?#]*\/)([^/?#]+)/;
export const REDACTED_TOKEN = '***';

const decodedOrRaw = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

export const webhookTokenForms = (url: string): readonly string[] => {
  const segment = WEBHOOK_PATH.exec(url)?.[2];
  if (segment === undefined) {
    return [];
  }

  return [...new Set([segment, decodedOrRaw(segment)])];
};

export const redactWebhookToken = (url: string): string =>
  url.replace(WEBHOOK_PATH, `$1${REDACTED_TOKEN}`);
