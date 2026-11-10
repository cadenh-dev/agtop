/**
 * Streaming secret redaction (contracts 6.1).
 *
 * The redactor works on a latin1 view of the input bytes: one byte maps to one
 * character, so offsets are exact and arbitrary binary data survives unchanged.
 * Every rule is ASCII and bounded, so all offsets are also byte offsets.
 */

/** Bytes held back at the end of each push so a split secret can still match. */
export const REDACTION_HOLDBACK_BYTES = 1024;

/** Longest match any rule may produce; a straddling match releases at most this extra. */
export const REDACTION_MAX_MATCH_BYTES = 600;

export interface RedactionRule {
  id: string;
  /** Must have the g flag, must never match "\n", and no match may exceed REDACTION_MAX_MATCH_BYTES. */
  pattern: RegExp;
  /** When true, capture group 1 is a prefix that is kept; only the rest of the match is replaced. */
  keepPrefix?: boolean;
}

export const DEFAULT_REDACTION_RULES: readonly RedactionRule[] = [
  { id: "openai-key", pattern: /sk-[A-Za-z0-9_-]{20,200}/g },
  { id: "github-token", pattern: /gh[pousr]_[A-Za-z0-9]{36,200}/g },
  { id: "github-pat", pattern: /github_pat_[A-Za-z0-9_]{22,200}/g },
  { id: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "google-api-key", pattern: /AIza[0-9A-Za-z_-]{35}/g },
  { id: "slack-token", pattern: /xox[abprs]-[A-Za-z0-9-]{10,200}/g },
  { id: "jwt", pattern: /eyJ[A-Za-z0-9_-]{10,180}\.[A-Za-z0-9_-]{10,180}\.[A-Za-z0-9_-]{10,180}/g },
  { id: "auth-header", pattern: /(Authorization:[ \t]*)[^\r\n]{1,400}/gi, keepPrefix: true },
  { id: "bearer-token", pattern: /(Bearer[ \t]+)[A-Za-z0-9._~+\/=-]{16,400}/g, keepPrefix: true },
  { id: "env-secret", pattern: /([A-Z][A-Z0-9_]{0,60}(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD)=)[^\s'"]{1,400}/g, keepPrefix: true },
];

/**
 * Exact literals that every match of a default rule must contain. Skipping a
 * rule when none is present is a pure prefilter: it cannot change the matches,
 * and it keeps long runs of unrelated uppercase text cheap to scan.
 */
const RULE_ANCHORS: ReadonlyMap<RegExp, readonly string[]> = new Map<RegExp, readonly string[]>([
  [DEFAULT_REDACTION_RULES[0].pattern, ["sk-"]],
  [DEFAULT_REDACTION_RULES[1].pattern, ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"]],
  [DEFAULT_REDACTION_RULES[2].pattern, ["github_pat_"]],
  [DEFAULT_REDACTION_RULES[3].pattern, ["AKIA", "ASIA"]],
  [DEFAULT_REDACTION_RULES[4].pattern, ["AIza"]],
  [DEFAULT_REDACTION_RULES[5].pattern, ["xox"]],
  [DEFAULT_REDACTION_RULES[6].pattern, ["eyJ"]],
  // auth-header is case-insensitive, so it has no exact-case anchor; it is cheap anyway.
  [DEFAULT_REDACTION_RULES[8].pattern, ["Bearer"]],
  [DEFAULT_REDACTION_RULES[9].pattern, ["API_KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD"]],
]);

/** One match as [matchStart, redactStart, end, id]; redactStart is after a kept prefix. */
interface Span {
  start: number;
  from: number;
  end: number;
  id: string;
}

const replacement = (id: string): string => `[REDACTED:${id}]`;

export class SecretRedactor {
  private carry = "";
  private count = 0;
  private readonly rules: readonly RedactionRule[];

  constructor(rules: readonly RedactionRule[] = DEFAULT_REDACTION_RULES) {
    this.rules = rules;
  }

  /** Returns the bytes that are now safe to release. */
  push(chunk: Buffer, mode: "data" | "tick" | "eof"): Buffer {
    // 1. Latin1 view: one byte per character, so binary data and offsets are exact.
    const s = this.carry + chunk.toString("latin1");

    // 2. Collect every match. Global regexes are shared, so reset lastIndex first.
    const spans: Span[] = [];
    for (const rule of this.rules) {
      const { pattern, id } = rule;
      const anchors = RULE_ANCHORS.get(pattern);
      if (anchors !== undefined && !anchors.some((anchor) => s.includes(anchor))) continue;
      pattern.lastIndex = 0;
      for (let match = pattern.exec(s); match !== null; match = pattern.exec(s)) {
        const prefix = rule.keepPrefix ? match[1]?.length ?? 0 : 0;
        spans.push({ start: match.index, from: match.index + prefix, end: match.index + match[0].length, id });
        // A zero-length match cannot advance lastIndex on its own; keep the scan moving.
        if (match[0].length === 0) pattern.lastIndex++;
      }
    }
    spans.sort((a, b) => a.start - b.start);

    // 3. Choose the release point for this mode.
    let cut = mode === "eof" ? s.length : Math.max(0, s.length - REDACTION_HOLDBACK_BYTES);
    if (mode === "tick") cut = Math.max(cut, s.lastIndexOf("\n") + 1);

    // 4. A match is never split: move the cut to the end of any match that straddles it.
    for (const span of spans) {
      if (span.start < cut && span.end > cut) cut = span.end;
    }

    // 5. Emit s[0..cut) with matches replaced; carry the rest, unredacted, for the next push.
    let out = "";
    let pos = 0;
    for (const span of spans) {
      if (span.start >= cut || span.end <= pos) continue;
      // A later match that starts inside an earlier one only extends the redacted range.
      if (span.start < pos) {
        pos = Math.max(pos, span.end);
        continue;
      }
      out += s.slice(pos, span.from) + replacement(span.id);
      this.count++;
      pos = span.end;
    }
    out += s.slice(pos, cut);
    this.carry = s.slice(cut);

    // 6. Write the latin1 view back as bytes.
    return Buffer.from(out, "latin1");
  }

  get heldBytes(): number {
    return this.carry.length;
  }

  get redactionCount(): number {
    return this.count;
  }
}

/**
 * One-shot helper for short strings. Equivalent to
 * `new SecretRedactor().push(Buffer.from(text), "eof")`, read back as UTF-8,
 * because the redactor preserves every byte outside a replacement.
 */
export function redactText(text: string): string {
  return new SecretRedactor().push(Buffer.from(text), "eof").toString("utf8");
}
