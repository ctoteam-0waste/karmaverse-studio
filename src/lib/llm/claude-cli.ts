import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { LlmClient } from "./anthropic";

/**
 * Claude through the Claude Code program on this computer, signed in with the
 * user's Claude subscription (Pro/Max). No API key and no per-use billing; it
 * counts toward the subscription's usage limits.
 *
 * Finds claude.exe from CLAUDE_CLI in .env.local, else the newest copy bundled
 * with the VS Code extension, else ~/.local/bin (the standalone installer).
 */
export function findClaudeCli(): string | null {
  const set = process.env.CLAUDE_CLI?.trim().replace(/^"|"$/g, "");
  if (set) return existsSync(set) ? set : null;
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const ext = path.join(homedir(), ".vscode", "extensions");
  try {
    const found = readdirSync(ext)
      .filter((d) => d.startsWith("anthropic.claude-code-"))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((d) => path.join(ext, d, "resources", "native-binary", exe))
      .find((f) => existsSync(f));
    if (found) return found;
  } catch {
    /* no VS Code extensions folder */
  }
  const local = path.join(homedir(), ".local", "bin", exe);
  return existsSync(local) ? local : null;
}

export function isClaudeCliAvailable(): boolean {
  return findClaudeCli() !== null;
}

const TIMEOUT_MS = 4 * 60 * 1000;

export function claudeCliClient(bin = findClaudeCli()): LlmClient {
  return {
    async complete({ system, user, webSearch }) {
      if (!bin) throw new Error("Claude Code was not found on this computer. Install it, or set CLAUDE_CLI in .env.local to the path of claude.exe.");
      const model = process.env.CLAUDE_CLI_MODEL?.trim() || "sonnet";
      const tools = webSearch ? ["--tools", "WebSearch,WebFetch", "--allowedTools", "WebSearch,WebFetch"] : ["--tools", ""];
      const args = ["-p", "--output-format", "json", ...tools, "--system-prompt", system, "--setting-sources", "", "--no-session-persistence", "--model", model];
      // Without an API key in its environment, Claude Code uses the subscription sign-in.
      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY;
      const out = await new Promise<string>((resolve, reject) => {
        const p = spawn(/*turbopackIgnore: true*/ bin, args, { cwd: tmpdir(), env, windowsHide: true });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          p.kill();
          reject(new Error("Claude took longer than 4 minutes."));
        }, TIMEOUT_MS);
        p.stdout.on("data", (c) => (stdout += c));
        p.stderr.on("data", (c) => (stderr += c));
        p.on("error", (err) => {
          clearTimeout(timer);
          reject(new Error(`Could not start Claude Code: ${err.message}`));
        });
        p.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0 || stdout.trim()) resolve(stdout);
          else reject(new Error(`Claude Code exited with code ${code}: ${(stderr || stdout).trim().slice(0, 300)}`));
        });
        p.stdin.end(user);
      });
      let data: { result?: string; is_error?: boolean };
      try {
        data = JSON.parse(out.trim().split(/\r?\n/).pop() ?? "");
      } catch {
        throw new Error(`Claude Code returned something unexpected: ${out.trim().slice(0, 200)}`);
      }
      if (data.is_error || !data.result) throw new Error(`Claude Code: ${(data.result || "no answer").slice(0, 300)} (is it still signed in to your Claude subscription?)`);
      return data.result;
    },
  };
}

/**
 * Runs Claude Code as an agent inside a folder (e.g. a git worktree of the
 * website), allowed only to read and edit files there: no shell, no web.
 * Returns Claude's final message. Used by the Growth agent to prepare fixes
 * on a review branch.
 */
export async function runClaudeAgent(opts: { cwd: string; prompt: string; system?: string; timeoutMs?: number; bin?: string | null }): Promise<string> {
  const bin = opts.bin ?? findClaudeCli();
  if (!bin) throw new Error("Claude Code was not found on this computer.");
  const model = process.env.CLAUDE_AGENT_MODEL?.trim() || process.env.CLAUDE_CLI_MODEL?.trim() || "sonnet";
  const tools = "Read,Edit,Write,Glob,Grep";
  const args = ["-p", "--output-format", "json", "--tools", tools, "--allowedTools", tools, "--permission-mode", "acceptEdits", "--setting-sources", "", "--no-session-persistence", "--model", model];
  if (opts.system) args.push("--append-system-prompt", opts.system);
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const timeout = opts.timeoutMs ?? 20 * 60 * 1000;
  const out = await new Promise<string>((resolve, reject) => {
    const p = spawn(/*turbopackIgnore: true*/ bin, args, { cwd: opts.cwd, env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error(`Claude took longer than ${Math.round(timeout / 60000)} minutes.`));
    }, timeout);
    p.stdout.on("data", (c) => (stdout += c));
    p.stderr.on("data", (c) => (stderr += c));
    p.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not start Claude Code: ${err.message}`));
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || stdout.trim()) resolve(stdout);
      else reject(new Error(`Claude Code exited with code ${code}: ${(stderr || stdout).trim().slice(0, 300)}`));
    });
    p.stdin.end(opts.prompt);
  });
  let data: { result?: string; is_error?: boolean };
  try {
    data = JSON.parse(out.trim().split(/\r?\n/).pop() ?? "");
  } catch {
    throw new Error(`Claude Code returned something unexpected: ${out.trim().slice(0, 200)}`);
  }
  if (data.is_error || !data.result) throw new Error(`Claude Code: ${(data.result || "no answer").slice(0, 300)}`);
  return data.result;
}
