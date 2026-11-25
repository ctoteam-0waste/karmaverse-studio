import type { z } from "zod";

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

/**
 * Pulls the first JSON object or array out of model output (which may be
 * wrapped in prose or a ```json fence) and validates it against a schema.
 */
export function parseJsonResult<T extends z.ZodTypeAny>(text: string, schema: T): z.infer<T> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();

  const start = candidate.search(/[[{]/);
  if (start === -1) throw new ParseError("No JSON found. Paste the JSON block exactly as Claude returned it.");
  const open = candidate[start]!;
  const close = open === "{" ? "}" : "]";
  const end = candidate.lastIndexOf(close);
  if (end <= start) throw new ParseError("The JSON looks incomplete. Make sure you copied the whole block.");

  let raw: unknown;
  try {
    raw = JSON.parse(candidate.slice(start, end + 1));
  } catch (err) {
    throw new ParseError(`The JSON could not be read: ${(err as Error).message}`);
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ParseError(`The JSON does not match the expected shape: ${issues}`);
  }
  return result.data;
}
