import { describe, expect, test } from "bun:test"
import {
  CommandParseError,
  TITAN_SUBCOMMANDS,
  helpText,
  parseTitanCommand,
} from "../../src/application/commands.js"

describe("/titan command parsing (FR-110)", () => {
  test("empty input → help", () => {
    expect(parseTitanCommand("")).toEqual({ subcommand: "help", args: [], rest: "" })
    expect(parseTitanCommand("   ")).toEqual({ subcommand: "help", args: [], rest: "" })
  })

  test("bare subcommand", () => {
    const p = parseTitanCommand("status")
    expect(p.subcommand).toBe("status")
    expect(p.args).toEqual([])
  })

  test("subcommand with args — args only, command name already stripped by OpenCode", () => {
    const p = parseTitanCommand("run --goal \"fix bug\"")
    expect(p.subcommand).toBe("run")
    expect(p.args[0]).toBe("--goal")
    expect(p.rest).toBe("--goal \"fix bug\"")
  })

  test("case-insensitive subcommand", () => {
    expect(parseTitanCommand("DOCTOR").subcommand).toBe("doctor")
    expect(parseTitanCommand("Help").subcommand).toBe("help")
  })

  test("unknown subcommand throws CommandParseError listing valid options", () => {
    expect(() => parseTitanCommand("frobnicate")).toThrow(CommandParseError)
    try {
      parseTitanCommand("frobnicate")
      expect.unreachable?.()
    } catch (e) {
      expect(e).toBeInstanceOf(CommandParseError)
      expect((e as Error).message).toContain("frobnicate")
      expect((e as Error).message).toContain("plan") // lists known commands
    }
  })

  test("every SRS FR-110 subcommand is accepted by the parser", () => {
    // FR-110: plan, run, status, pause, resume, cancel, review, doctor
    const srsCommands = ["plan", "run", "status", "pause", "resume", "cancel", "review", "doctor"] as const
    for (const c of srsCommands) {
      expect(() => parseTitanCommand(c)).not.toThrow()
      expect(parseTitanCommand(c).subcommand).toBe(c)
    }
    // and they are all in the declared subcommand set
    for (const c of srsCommands) {
      expect(TITAN_SUBCOMMANDS as readonly string[]).toContain(c)
    }
  })

  test("multi-arg parsing splits on whitespace but keeps rest intact", () => {
    const p = parseTitanCommand("approve task-1 because reason")
    expect(p.subcommand).toBe("approve")
    expect(p.args).toEqual(["task-1", "because", "reason"])
    expect(p.rest).toBe("task-1 because reason")
  })
})

describe("help text (FR-110)", () => {
  test("lists all SRS-mandated subcommands", () => {
    const h = helpText()
    for (const c of ["plan", "run", "status", "pause", "resume", "cancel", "review", "doctor"]) {
      expect(h).toContain(c)
    }
  })

  test("mentions the /titan entry point", () => {
    expect(helpText()).toContain("/titan")
  })
})
