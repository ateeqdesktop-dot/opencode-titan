/**
 * Persistence adapter interface (ADR-004).
 * Domain/orchestration logic depends ONLY on this — never on a concrete DB driver.
 *
 * SRS §8.4/§8.5: schemaVersion + migrations, transactions, atomic state changes,
 * append-only event journal, indexes, backup, corruption handling, retention.
 */
// ── Schema versioning ────────────────────────────────────────────────────────
export const SCHEMA_VERSION = 1;
export class StorageError extends Error {
    cause;
    constructor(message, cause) {
        super(message);
        this.cause = cause;
        this.name = "StorageError";
    }
}
