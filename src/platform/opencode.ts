/**
 * Shared OpenCode V2 plugin context type (ADR-001: typed from the INSTALLED
 * V2 SDK — `@opencode/plugin` — never from docs or memory).
 */
import { Plugin } from "@opencode/plugin"

export type PluginCtx = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]
