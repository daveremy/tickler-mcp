/**
 * Parse a human-readable duration string into milliseconds.
 * Supported units: m (minutes), h (hours), d (days), w (weeks)
 * Examples: "30m", "3h", "1d", "2w"
 * Returns null if the string is not a valid duration.
 */
export function parseDuration(s: string): number | null {
  const match = s.trim().match(/^(\d+(?:\.\d+)?)\s*([mhdw])$/i);
  if (!match) return null;

  const n = parseFloat(match[1]);
  const unit = match[2].toLowerCase();

  const multipliers: Record<string, number> = {
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
  };

  return n * multipliers[unit];
}
