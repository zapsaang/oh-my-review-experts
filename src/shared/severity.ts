export const SEVERITY_VALUES = ["critical", "high", "medium", "low"] as const;
export type SeverityLevel = (typeof SEVERITY_VALUES)[number];
export const severityRank: Record<SeverityLevel, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};
export function compareSeverity(a: string, b: string): number {
  return (severityRank[a as SeverityLevel] ?? 4) - (severityRank[b as SeverityLevel] ?? 4);
}
