export const REVIEWER_PREFIX = "omre-reviewer-";

export function canonicalReviewerName(reviewer: string): string {
  return reviewer.startsWith(REVIEWER_PREFIX) ? reviewer.slice(REVIEWER_PREFIX.length) : reviewer;
}
