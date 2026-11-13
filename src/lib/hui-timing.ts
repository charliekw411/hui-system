export function getHuiArchiveCutoff(now = Date.now()): string {
  return new Date(now - 6 * 60 * 60 * 1000).toISOString();
}
