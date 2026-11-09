import { describe, expect, test } from "bun:test"
import { findSecrets, redactSecrets, sanitizeForStore } from "../../src/security/redact.js"

describe("secret redaction (SRS §11)", () => {
  test("detects common secret shapes", () => {
    expect(findSecrets("plain text")).toEqual([])
    expect(findSecrets("sk-1234567890abcdefghij123456")).toContain("api-key")
    expect(findSecrets("AKIAIOSFODNN7EXAMPLE")).toContain("aws-key")
    expect(findSecrets("ghp_abcdefghijklmnopqrstuvwxyz012345")).toContain("github-token")
    expect(findSecrets("Bearer abcdefghijklmnopqrstuvwxyz0123456789")).toContain("bearer")
    expect(findSecrets("password: supersecretpassword123")).toContain("password-assignment")
  })

  test("redactSecrets masks detected secrets but keeps surrounding text", () => {
    const input = "key=sk-1234567890abcdefghij123456 and hello"
    const out = redactSecrets(input)
    expect(out).toContain("and hello")
    expect(out).toContain("***")
    expect(out).not.toContain("sk-1234567890abcdefghij123456")
  })

  test("sanitizeForStore reports found kinds + redacted text", () => {
    const r = sanitizeForStore("token=abcdefghij1234567890")
    expect(r.secrets.length).toBeGreaterThan(0)
    expect(r.text).not.toContain("abcdefghij1234567890")
  })

  test("sanitizeForStore leaves clean text untouched", () => {
    const r = sanitizeForStore("no secrets here")
    expect(r.secrets).toEqual([])
    expect(r.text).toBe("no secrets here")
  })
})