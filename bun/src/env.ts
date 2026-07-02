/**
 * Tiny environment reader. `EnvVar.read` runs the whole spec, collecting every problem,
 * and throws once with the full list if anything required is missing or malformed.
 * A second argument makes a var optional and becomes its default (pass `undefined` for
 * an optional value with no default).
 */
class EnvReader {
  readonly errors: string[] = [];

  private read<T>(name: string, def: unknown[], parse: (raw: string) => T): T | undefined {
    const raw = process.env[name];
    if (raw === undefined || raw === "") {
      if (def.length > 0) return def[0] as T | undefined;
      this.errors.push(`${name} is required but not set`);
      return undefined;
    }
    try {
      return parse(raw);
    } catch (err) {
      this.errors.push(`${name}: ${(err as Error).message}`);
      return undefined;
    }
  }

  String<D extends string | undefined = never>(name: string, ...def: [D?]): string | D {
    return this.read(name, def, (s) => s) as string | D;
  }

  Number<D extends number | undefined = never>(name: string, ...def: [D?]): number | D {
    return this.read(name, def, (s) => {
      const n = globalThis.Number(s);
      if (globalThis.Number.isNaN(n)) throw new Error(`"${s}" is not a number`);
      return n;
    }) as number | D;
  }

  Boolean<D extends boolean | undefined = never>(name: string, ...def: [D?]): boolean | D {
    return this.read(name, def, (s) => s === "true" || s === "1") as boolean | D;
  }

  Base64<D extends string | undefined = never>(name: string, ...def: [D?]): string | D {
    return this.read(name, def, (s) => Buffer.from(s, "base64").toString("utf8")) as string | D;
  }
}

export class Env {
  public static read<T>(spec: (e: EnvReader) => T): T {
    const e = new EnvReader();
    const env = spec(e);
    if (e.errors.length > 0) {
      throw new Error(`invalid environment:\n${e.errors.map((m) => `  - ${m}`).join("\n")}`);
    }
    return env;
  }
}

/**
 * Promise resolves when any of the given signals is received.
 * @param signals - List of signals to listen for (e.g., "SIGINT", "SIGTERM")
 * @returns Promise that resolves when any of the given signals is received
 */
export function signal(...signals: NodeJS.Signals[]): Promise<void> {
  return new Promise<void>((resolve) => {
    const handlers = new Map<NodeJS.Signals, () => void>();
    const cleanup = () => {
      for (const [sig, handler] of handlers) {
        process.removeListener(sig, handler);
      }
    };
    for (const sig of signals) {
      const handler = () => { cleanup(); resolve(); };
      handlers.set(sig, handler);
      process.once(sig, handler);
    }
  });
}
