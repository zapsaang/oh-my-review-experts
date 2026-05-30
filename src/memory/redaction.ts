import type { RawFinding } from "./extractor/types.js";
import { redactSecrets } from "../tools/secret-scanner.js";

export interface RedactionRules {
  extraPatterns?: Array<{ pattern: RegExp; replacement: string }>;
}

export type RedactedRawFinding = RawFinding;

interface Span {
  start: number;
  end: number;
}

const REDACTION_MARKER_PATTERN = /\[REDACTED[^\]]*\]/g;

function collectRedactionMarkerSpans(text: string): Span[] {
  return [...text.matchAll(REDACTION_MARKER_PATTERN)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function overlapsAnySpan(start: number, end: number, spans: Span[]): boolean {
  return spans.some((span) => start < span.end && end > span.start);
}

function applyExtraPattern(text: string, pattern: RegExp, replacement: string): string {
  const protectedSpans = collectRedactionMarkerSpans(text);

  return text.replace(pattern, (match, ...args) => {
    const hasNamedGroups = typeof args.at(-1) === "object";
    const offset = args.at(hasNamedGroups ? -3 : -2) as number;

    if (match.length === 0 || overlapsAnySpan(offset, offset + match.length, protectedSpans)) {
      return match;
    }

    return replacement;
  });
}

export function redactText(text: string, rules?: RedactionRules): string {
  let redacted = redactSecrets(text);

  for (const extraPattern of rules?.extraPatterns ?? []) {
    redacted = applyExtraPattern(redacted, extraPattern.pattern, extraPattern.replacement);
  }

  return redacted;
}

export function redactPath(path: string): string {
  return path
    .split(/([\\/])/)
    .map((segment) => {
      if (segment === "/" || segment === "\\") {
        return segment;
      }

      return segment.replace(
        /[._-](?:[0-9a-f]{7,40}|v?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?)(?=(?:\.[^\\/.]+)?$)/gi,
        ""
      );
    })
    .join("");
}

export function redactRawFinding(finding: RawFinding, rules?: RedactionRules): RedactedRawFinding {
  const redacted: RedactedRawFinding = {
    ...finding,
    title: redactText(finding.title, rules),
    problem: redactText(finding.problem, rules),
    locations: finding.locations.map((location) => ({
      ...location,
      path: redactPath(location.path),
    })),
  };

  if (finding.evidence !== undefined) {
    redacted.evidence = redactText(finding.evidence, rules);
  }

  if (finding.recommendation !== undefined) {
    redacted.recommendation = redactText(finding.recommendation, rules);
  }

  return redacted;
}
