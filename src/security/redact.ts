/**
 * Secret hygiene (SRS §11 security, SEC IDs).
 *
 * TITAN persists prompts, task briefs, evidence and journal payloads. Anything
 * that looks like a credential must never reach durable state in plaintext —
 * even in a fully local install. This module is PURE: pattern detection +
 * masked replacement, unit-tested, used by the executor and journal writers.
 */
export interface SecretFinding {
  readonly kind: string
  readonly masked: string
}

interface Pattern {
  readonly kind: string
  readonly re: RegExp
}

const PATTERNS: readonly Pattern[] = [
  // OpenAI-style keys
  { kind: "api-key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  // AWS access keys
  { kind: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  // GitHub tokens (fine-grained/classic/PAT)
  { kind: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  // Generic bearer tokens in headers
  { kind: "bearer", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g },
  // Long hex secrets prefixed by typical names
  {
    kind: "password-assignment",
    re: /\b(password|passwd|secret|token|api[_-]?key)\b\s*[:=]\s*['"]?[A-Za-z0-9._~+/=-]{12,}/gi,
  },
  // OpenCode server passwords
  { kind: "server-password", re: /\bserver password\s+\S+/gi },
]

export function findSecrets(text: string): readonly string[] {
  const kinds: string[] = []
  for (const p of PATTERNS) {
    if (p.re.test(text)) kinds.push(p.kind)
    p.re.lastIndex = 0
  }
  return kinds
}

function mask(match: string): string {
  if (match.length <= 8) return "***"
  return `${match.slice(0, 3)}***${match.slice(-3)}`
}

/** Replace every detected secret with a stable mask; keeps surrounding text readable. */
export function redactSecrets(text: string): string {
  let out = text
  for (const p of PATTERNS) {
    out = out.replace(p.re, (m) => mask(m))
    p.re.lastIndex = 0
  }
  return out
}

/** Redact + classify in one pass, for evidence/journal writes. */
export function sanitizeForStore(text: string): { readonly text: string; readonly secrets: readonly string[] } {
  const found = findSecrets(text)
  return { text: found.length > 0 ? redactSecrets(text) : text, secrets: found }
}
