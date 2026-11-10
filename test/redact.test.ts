import { describe, expect, test } from "bun:test";
import {
  DEFAULT_REDACTION_RULES,
  REDACTION_HOLDBACK_BYTES,
  REDACTION_MAX_MATCH_BYTES,
  SecretRedactor,
  redactText,
} from "../src/redact.js";

const RULE_IDS = [
  "openai-key", "github-token", "github-pat", "aws-access-key", "google-api-key",
  "slack-token", "jwt", "auth-header", "bearer-token", "env-secret",
] as const;

interface RuleCase {
  id: string;
  text: string;
  expected: string;
}

const POSITIVE_CASES: readonly RuleCase[] = [
  { id: "openai-key", text: "sk-" + "a".repeat(20), expected: "[REDACTED:openai-key]" },
  { id: "github-token", text: "ghp_" + "A".repeat(36), expected: "[REDACTED:github-token]" },
  { id: "github-pat", text: "github_pat_" + "B".repeat(22), expected: "[REDACTED:github-pat]" },
  { id: "aws-access-key", text: "AKIA" + "C".repeat(16), expected: "[REDACTED:aws-access-key]" },
  { id: "google-api-key", text: "AIza" + "d".repeat(35), expected: "[REDACTED:google-api-key]" },
  { id: "slack-token", text: "xoxb-" + "e".repeat(10), expected: "[REDACTED:slack-token]" },
  {
    id: "jwt",
    text: "eyJ" + "a".repeat(10) + "." + "b".repeat(10) + "." + "c".repeat(10),
    expected: "[REDACTED:jwt]",
  },
  { id: "auth-header", text: "Authorization: hunter2", expected: "Authorization: [REDACTED:auth-header]" },
  { id: "bearer-token", text: "Bearer " + "f".repeat(16), expected: "Bearer [REDACTED:bearer-token]" },
  { id: "env-secret", text: "DEEPSEEK_API_KEY=abc123", expected: "DEEPSEEK_API_KEY=[REDACTED:env-secret]" },
];

const NEAR_MISS_CASES: readonly RuleCase[] = [
  { id: "openai-key", text: "sk-" + "a".repeat(19), expected: "sk-" + "a".repeat(19) },
  { id: "github-token", text: "ghp_" + "A".repeat(35), expected: "ghp_" + "A".repeat(35) },
  { id: "github-pat", text: "github_pat_" + "B".repeat(21), expected: "github_pat_" + "B".repeat(21) },
  { id: "aws-access-key", text: "AKIA" + "C".repeat(15), expected: "AKIA" + "C".repeat(15) },
  { id: "google-api-key", text: "AIza" + "d".repeat(34), expected: "AIza" + "d".repeat(34) },
  { id: "slack-token", text: "xoxb-" + "e".repeat(9), expected: "xoxb-" + "e".repeat(9) },
  {
    id: "jwt",
    text: "eyJ" + "a".repeat(10) + "." + "b".repeat(10) + "." + "c".repeat(9),
    expected: "eyJ" + "a".repeat(10) + "." + "b".repeat(10) + "." + "c".repeat(9),
  },
  { id: "auth-header", text: "Authorization:\n", expected: "Authorization:\n" },
  { id: "bearer-token", text: "Bearer " + "f".repeat(15), expected: "Bearer " + "f".repeat(15) },
  { id: "env-secret", text: "DEEPSEEK_API_KEY=", expected: "DEEPSEEK_API_KEY=" },
];

describe("default rules", () => {
  test("ids, order, flags and constants match the contract", () => {
    expect(DEFAULT_REDACTION_RULES.map((rule) => rule.id)).toEqual([...RULE_IDS]);
    for (const rule of DEFAULT_REDACTION_RULES) expect(rule.pattern.global).toBe(true);
    expect(DEFAULT_REDACTION_RULES.filter((rule) => rule.keepPrefix).map((rule) => rule.id))
      .toEqual(["auth-header", "bearer-token", "env-secret"]);
    expect(REDACTION_HOLDBACK_BYTES).toBe(1024);
    expect(REDACTION_MAX_MATCH_BYTES).toBe(600);
  });

  for (const { id, text, expected } of POSITIVE_CASES) {
    test(`${id}: redacts its sample and keeps any prefix`, () => {
      expect(redactText(text)).toBe(expected);
    });
  }

  for (const { id, text, expected } of NEAR_MISS_CASES) {
    test(`${id}: leaves a near miss unchanged`, () => {
      expect(redactText(text)).toBe(expected);
    });
  }
});

describe("overlap and counters", () => {
  test("Authorization: Bearer sk-… is one redaction that keeps the header name", () => {
    const secret = "sk-" + "a".repeat(30);
    const output = redactText(`Authorization: Bearer ${secret}\n`);
    expect(output).toBe("Authorization: [REDACTED:auth-header]\n");
    expect(output).not.toContain(secret);
  });

  test("heldBytes and redactionCount track release and matches", () => {
    const redactor = new SecretRedactor();
    expect(redactor.heldBytes).toBe(0);
    expect(redactor.redactionCount).toBe(0);

    const first = "sk-" + "a".repeat(24) + " and " + "sk-" + "b".repeat(24);
    expect(redactor.push(Buffer.from(first, "latin1"), "data").length).toBe(0);
    expect(redactor.heldBytes).toBe(first.length);

    const released = redactor.push(Buffer.from("\n"), "eof").toString("latin1");
    expect(released).toBe("[REDACTED:openai-key] and [REDACTED:openai-key]\n");
    expect(redactor.heldBytes).toBe(0);
    expect(redactor.redactionCount).toBe(2);
  });
});

describe("push modes", () => {
  test("data holds back the final 1024 bytes", () => {
    const redactor = new SecretRedactor();
    expect(redactor.push(Buffer.from("hello world", "latin1"), "data").length).toBe(0);
    expect(redactor.heldBytes).toBe(11);
  });

  test("tick releases through the last newline only", () => {
    const redactor = new SecretRedactor();
    redactor.push(Buffer.from("hello world", "latin1"), "data");
    expect(redactor.push(Buffer.from("\nsecond line", "latin1"), "data").length).toBe(0);

    expect(redactor.push(Buffer.alloc(0), "tick").toString("latin1")).toBe("hello world\n");
    expect(redactor.heldBytes).toBe("second line".length);

    expect(redactor.push(Buffer.alloc(0), "eof").toString("latin1")).toBe("second line");
    expect(redactor.heldBytes).toBe(0);
  });

  test("tick releases through a newline beyond the holdback zone", () => {
    const redactor = new SecretRedactor();
    const body = "a".repeat(2000);
    const tail = "tail";
    const firstCut = body.length + 1 + tail.length - REDACTION_HOLDBACK_BYTES;
    expect(redactor.push(Buffer.from(body + "\n" + tail, "latin1"), "data").toString("latin1"))
      .toBe(body.slice(0, firstCut));
    expect(redactor.push(Buffer.alloc(0), "tick").toString("latin1"))
      .toBe(body.slice(firstCut) + "\n");
    expect(redactor.heldBytes).toBe(tail.length);
    expect(redactor.push(Buffer.alloc(0), "eof").toString("latin1")).toBe(tail);
  });

  test("eof releases everything, including a crossed match", () => {
    const redactor = new SecretRedactor();
    const secret = "sk-" + "a".repeat(24);
    expect(redactor.push(Buffer.from("x " + secret, "latin1"), "data").length).toBe(0);
    expect(redactor.push(Buffer.alloc(0), "eof").toString("latin1"))
      .toBe("x [REDACTED:openai-key]");
    expect(redactor.heldBytes).toBe(0);
  });
});

describe("splits", () => {
  const LINE = "prefix sk-" + "a".repeat(24) + " suffix\n";
  const EXPECTED = redactText(LINE);

  function runSplit(parts: readonly string[]): string {
    const redactor = new SecretRedactor();
    let output = "";
    for (let i = 0; i < parts.length; i++) {
      const mode = i === parts.length - 1 ? "eof" : "data";
      output += redactor.push(Buffer.from(parts[i], "latin1"), mode).toString("latin1");
    }
    return output;
  }

  test("every two-way split of a secret-bearing line is fully redacted", () => {
    expect(EXPECTED).toContain("[REDACTED:openai-key]");
    for (let at = 0; at <= LINE.length; at++) {
      expect(runSplit([LINE.slice(0, at), LINE.slice(at)])).toBe(EXPECTED);
    }
  });

  test("every three-way split of a secret-bearing line is fully redacted", () => {
    for (let first = 0; first <= LINE.length; first++) {
      for (let second = first; second <= LINE.length; second++) {
        expect(runSplit([LINE.slice(0, first), LINE.slice(first, second), LINE.slice(second)]))
          .toBe(EXPECTED);
      }
    }
  });
});

describe("binary and performance", () => {
  test("all byte values pass through unchanged", () => {
    const bytes = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    expect(new SecretRedactor().push(bytes, "eof").equals(bytes)).toBe(true);
  });

  const MIB = 1 << 20;
  const build = (text: string): Buffer => Buffer.from(text.slice(0, MIB), "latin1");
  const ADVERSARIAL: ReadonlyArray<[string, Buffer]> = [
    ["A run", build("A".repeat(MIB))],
    ["sk- run", build("sk-".repeat(MIB))],
    ["AAAA_ run", build("AAAA_".repeat(MIB))],
    ["Authorization spaces", build("Authorization:" + " ".repeat(MIB))],
    ["eyJ + a.", build("eyJ" + "a.".repeat(MIB))],
  ];

  for (const [name, input] of ADVERSARIAL) {
    test(`adversarial 1 MiB (${name}) is processed in under 250 ms`, () => {
      expect(input.length).toBe(MIB);
      const redactor = new SecretRedactor();
      const start = performance.now();
      redactor.push(input, "eof");
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(250);
    });
  }

  test("ordinary log throughput is at least 20 MiB/s", () => {
    const line = "2026-01-01T00:00:00Z INFO worker completed step id=12345 status=ok\n";
    const size = 4 * MIB;
    const text = line.repeat(Math.ceil(size / line.length)).slice(0, size);
    const input = Buffer.from(text, "latin1");
    const chunk = 64 * 1024;

    const warm = new SecretRedactor();
    for (let at = 0; at < 2 * MIB; at += chunk) warm.push(input.subarray(at, at + chunk), "data");
    warm.push(Buffer.alloc(0), "eof");

    const redactor = new SecretRedactor();
    const start = performance.now();
    for (let at = 0; at < input.length; at += chunk) {
      redactor.push(input.subarray(at, Math.min(at + chunk, input.length)), "data");
    }
    redactor.push(Buffer.alloc(0), "eof");
    const seconds = (performance.now() - start) / 1000;
    const mibPerSecond = size / MIB / seconds;
    expect(mibPerSecond).toBeGreaterThanOrEqual(20);
  });
});
