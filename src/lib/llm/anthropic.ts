import { logger } from "../logger";
import { RetryableError, withRetry } from "../retry";
import { claudeCliClient, isClaudeCliAvailable } from "./claude-cli";

const log = logger("anthropic");

export interface LlmClient {
  /** webSearch: let Claude search the web while answering (Claude Code only; ignored by the API client). */
  complete(input: { system: string; user: string; maxTokens?: number; webSearch?: boolean }): Promise<string>;
}

export class LlmNotConfiguredError extends Error {
  constructor() {
    super(
      "Claude API mode is selected but ANTHROPIC_API_KEY is not set. Add it to .env.local, or switch Settings > Generation mode to Template or Manual (both free).",
    );
    this.name = "LlmNotConfiguredError";
  }
}

export function isAnthropicConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim());
}

/**
 * Minimal Claude Messages API client using fetch (no SDK dependency).
 * Only used when Settings > Generation mode = "Claude API" and a key is present.
 */
export function anthropicClient(fetchImpl: typeof fetch = fetch): LlmClient {
  return {
    async complete({ system, user, maxTokens = 4000 }) {
      const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
      if (!apiKey) throw new LlmNotConfiguredError();
      const model = process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-5-5";

      return withRetry("anthropic.messages", async () => {
        let res: Response;
        try {
          res = await fetchImpl("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model,
              max_tokens: maxTokens,
              system,
              messages: [{ role: "user", content: user }],
            }),
          });
        } catch (err) {
          throw new RetryableError(`Network error calling Claude API: ${(err as Error).message}`);
        }

        if (res.status === 429 || res.status === 529 || res.status >= 500) {
          const retryAfter = Number(res.headers.get("retry-after"));
          throw new RetryableError(
            `Claude API returned ${res.status}`,
            Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
          );
        }
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          log.error("Claude API request failed", { status: res.status, body: body.slice(0, 500) });
          throw new Error(`Claude API returned ${res.status}. Check the API key, model name and account credits.`);
        }

        const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
        const text = (data.content ?? [])
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("");
        if (!text) throw new Error("Claude API returned no text content.");
        return text;
      });
    },
  };
}

/**
 * The Claude to use for "Claude" generation mode: the paid API when a key is
 * set, otherwise Claude Code signed in with the user's Claude subscription.
 */
export function isClaudeConfigured(): boolean {
  return isAnthropicConfigured() || isClaudeCliAvailable();
}

export function claudeClient(): LlmClient {
  return isAnthropicConfigured() ? anthropicClient() : claudeCliClient();
}

export function claudeSource(): "api" | "subscription" | null {
  return isAnthropicConfigured() ? "api" : isClaudeCliAvailable() ? "subscription" : null;
}
