import { randomUUID } from "node:crypto";
import type { AgentSessionRecord, BoxRecord, ThinkingLevel } from "../core/types.js";
import { badRequest } from "../core/errors.js";

export const PI_BIN_IN_CONTAINER = "/usr/local/bin/pi";

const FORBIDDEN_OPTIONS = new Set([
  "--mode",
  "--print",
  "--continue",
  "--resume",
  "--session",
  "--session-id",
  "--fork",
  "--session-dir",
  "--no-session",
  "--export",
  "--list-models",
  "--help",
  "--version",
  "-p",
  "-c",
  "-r",
  "-h",
  "-v"
]);

const OPTIONS_WITH_VALUES = new Set([
  "--extension",
  "-e",
  "--skill",
  "--prompt-template",
  "--theme",
  "--tools",
  "-t",
  "--exclude-tools",
  "-xt",
  "--models",
  "--system-prompt",
  "--append-system-prompt",
  "--api-key"
]);

const RESERVED_VALUE_OPTIONS = new Set([
  "--provider",
  "--model",
  "--thinking",
  "--name",
  "-n"
]);

export function shellSplitArgs(value?: string): string[] {
  const input = value?.trim() ?? "";
  if (!input) return [];
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const ch of input) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (escaped) current += "\\";
  if (quote) throw badRequest("custom pi args contain an unterminated quote");
  if (current) args.push(current);
  return args;
}

export function normalizeCustomPiArgs(value?: string[] | string): string[] {
  const args = Array.isArray(value) ? value : shellSplitArgs(value);
  const normalized = args.map((arg) => String(arg ?? "").trim()).filter(Boolean);
  validateCustomPiArgs(normalized);
  return normalized;
}

export function buildPiRuntimeArgs(session: AgentSessionRecord, box: BoxRecord, options: { mode: "rpc" | "tui" }): string[] {
  const args = [PI_BIN_IN_CONTAINER];
  if (options.mode === "rpc") {
    args.push("--mode", "rpc");
    if (session.sessionFile) args.push("--session", session.sessionFile);
    else args.push("--session-dir", "/workspace/.pi-sessions");
  } else {
    args.push("--session-id", session.piSessionId || createPiSessionId(), "--session-dir", "/workspace/.pi-sessions");
  }
  const provider = session.provider ?? box.pi.defaultProvider;
  const model = session.model ?? box.pi.defaultModel;
  const thinkingLevel = session.thinkingLevel ?? box.pi.defaultThinkingLevel;
  if (provider) args.push("--provider", provider);
  if (model) args.push("--model", model);
  if (thinkingLevel) args.push("--thinking", thinkingLevel);
  if (box.pi.extraArgs?.length) args.push(...normalizeCustomPiArgs(box.pi.extraArgs));
  if (session.launchArgs?.length) args.push(...normalizeCustomPiArgs(session.launchArgs));
  return args;
}

export function createPiSessionId(): string {
  return `boxedagent-${randomUUID()}`;
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function validateCustomPiArgs(args: string[]) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") throw badRequest("custom pi args cannot include -- message separator");
    if (arg.startsWith("@")) throw badRequest("custom pi args cannot include @file arguments");
    if (!arg.startsWith("-")) throw badRequest(`custom pi arg must be an option flag: ${arg}`);

    const option = optionName(arg);
    if (FORBIDDEN_OPTIONS.has(option)) throw badRequest(`custom pi arg is managed by BoxedAgent and cannot be used: ${option}`);
    if (RESERVED_VALUE_OPTIONS.has(option)) throw badRequest(`use the dedicated session field instead of custom pi arg: ${option}`);

    if (OPTIONS_WITH_VALUES.has(option)) {
      if (arg.includes("=")) {
        const value = arg.slice(arg.indexOf("=") + 1).trim();
        if (!value) throw badRequest(`custom pi arg requires a value: ${arg}`);
        continue;
      }
      const next = args[i + 1];
      if (!next || next.startsWith("-")) throw badRequest(`custom pi arg requires a value: ${arg}`);
      i += 1;
      continue;
    }

    if (arg.startsWith("--") && !arg.includes("=")) {
      const next = args[i + 1];
      if (next && !next.startsWith("-")) i += 1;
    }
  }
}

function optionName(arg: string): string {
  const idx = arg.indexOf("=");
  return idx >= 0 ? arg.slice(0, idx) : arg;
}
