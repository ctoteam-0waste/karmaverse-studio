type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN: Level = (process.env.LOG_LEVEL as Level) || "info";

const SECRET_KEYS = /key|token|secret|password|authorization/i;

/** Removes anything that looks like a credential before it reaches the log. */
function redact(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEYS.test(k) ? "[redacted]" : redact(v);
  }
  return out;
}

function write(level: Level, scope: string, message: string, data?: Record<string, unknown>) {
  if (ORDER[level] < ORDER[MIN]) return;
  const line = {
    t: new Date().toISOString(),
    level,
    scope,
    message,
    ...(data ? { data: redact(data) } : {}),
  };
  const text = JSON.stringify(line);
  if (level === "error") console.error(text);
  else if (level === "warn") console.warn(text);
  else console.log(text);
}

export function logger(scope: string) {
  return {
    debug: (m: string, d?: Record<string, unknown>) => write("debug", scope, m, d),
    info: (m: string, d?: Record<string, unknown>) => write("info", scope, m, d),
    warn: (m: string, d?: Record<string, unknown>) => write("warn", scope, m, d),
    error: (m: string, d?: Record<string, unknown>) => write("error", scope, m, d),
  };
}
