/** "488 MB", "1.6 GB": decimal units, as Finder shows them. */
export function formatSize(bytes: number): string {
  return bytes >= 1e9
    ? `${(bytes / 1e9).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`
    : `${Math.round(bytes / 1e6)} MB`;
}
