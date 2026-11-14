const PATTERNS = [
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
];
export function findSecrets(text) {
    const kinds = [];
    for (const p of PATTERNS) {
        if (p.re.test(text))
            kinds.push(p.kind);
        p.re.lastIndex = 0;
    }
    return kinds;
}
function mask(match) {
    if (match.length <= 8)
        return "***";
    return `${match.slice(0, 3)}***${match.slice(-3)}`;
}
/** Replace every detected secret with a stable mask; keeps surrounding text readable. */
export function redactSecrets(text) {
    let out = text;
    for (const p of PATTERNS) {
        out = out.replace(p.re, (m) => mask(m));
        p.re.lastIndex = 0;
    }
    return out;
}
/** Redact + classify in one pass, for evidence/journal writes. */
export function sanitizeForStore(text) {
    const found = findSecrets(text);
    return { text: found.length > 0 ? redactSecrets(text) : text, secrets: found };
}
