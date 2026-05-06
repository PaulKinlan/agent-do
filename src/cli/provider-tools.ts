/**
 * Provider-native tool registry — the CLI surface for `--provider-tool`.
 *
 * Provider packages (`@ai-sdk/google`, `@ai-sdk/anthropic`,
 * `@ai-sdk/openai`) ship their own tool factories
 * (`google.tools.googleSearch()`, `anthropic.tools.webSearch_20260209()`,
 * etc.). These are different from in-process JS tools — the provider
 * runs them server-side as part of the model call. We expose them via
 * the CLI so users can flip them on without writing a script.
 *
 * Strategy: a small alias table for ergonomics (`--provider-tool
 * webSearch` resolves to the most recent versioned export) plus a
 * passthrough that accepts any name the installed provider package
 * actually exposes. Unknown names produce a clean error listing what
 * the installed SDK supports.
 */
import type { ToolSet } from 'ai';
import { tryImport, type ProviderPackage } from './resolve-model.js';
import type { ProviderOptions } from '../types.js';

/**
 * Short ergonomic names → canonical export names. Keep these biased
 * towards the latest dated/versioned tool, with the unversioned/short
 * name as the alias. When the SDK ships a newer dated version, bump
 * the target here so `--provider-tool webSearch` keeps meaning "the
 * current web-search tool".
 *
 * Aliases are matched only if the canonical export exists at runtime;
 * if a user is on an older SDK, the registry falls back to whatever
 * dated names that SDK does export.
 */
const ALIASES: Record<string, Record<string, string>> = {
  google: {
    // Google's tools aren't dated, so aliases mostly mirror the
    // canonical names; entry exists so the same listing path works
    // for all three providers.
  },
  anthropic: {
    webSearch: 'webSearch_20260209',
    webFetch: 'webFetch_20260209',
    bash: 'bash_20250124',
    textEditor: 'textEditor_20250728',
    computer: 'computer_20251124',
    codeExecution: 'codeExecution_20260120',
    memory: 'memory_20250818',
  },
  openai: {
    webSearch: 'webSearchPreview',
  },
};

const PROVIDER_PACKAGE: Record<string, ProviderPackage> = {
  google: '@ai-sdk/google',
  anthropic: '@ai-sdk/anthropic',
  openai: '@ai-sdk/openai',
};

const PROVIDER_NAMESPACE: Record<string, string> = {
  google: 'google',
  anthropic: 'anthropic',
  openai: 'openai',
};

/**
 * Whether the given provider has any provider-native tools registered.
 */
export function hasProviderTools(provider: string): boolean {
  return PROVIDER_PACKAGE[provider] !== undefined;
}

/**
 * Resolve a user-typed tool name to the canonical export name on
 * `provider.tools`. Tries the alias table first, then a direct match
 * against the installed SDK's actual exports. Returns `null` if
 * neither matches.
 */
function resolveToolName(
  provider: string,
  name: string,
  available: readonly string[],
): string | null {
  const alias = ALIASES[provider]?.[name];
  if (alias && available.includes(alias)) return alias;
  if (available.includes(name)) return name;
  // If the alias target isn't in the installed SDK but the alias
  // itself happens to exist (a user might type `webSearch` on a future
  // SDK that exposes it directly), accept that too.
  if (alias && available.includes(name)) return name;
  return null;
}

/**
 * Build a `ToolSet` of provider-native tools for the given provider
 * and list of tool names. Dynamically imports the provider SDK,
 * resolves names against the installed SDK's `<provider>.tools`
 * surface (with a small alias table on top), and instantiates each
 * with `factory({})`.
 *
 * Throws on the first unknown name with a list of valid names.
 *
 * The returned tool keys are namespaced as
 * `<provider>__<canonicalName>` so they can't collide with workspace
 * or memory tools and so the provenance is obvious in tool-call events.
 */
export async function buildProviderTools(
  provider: string,
  names: readonly string[],
): Promise<ToolSet> {
  if (names.length === 0) return {};
  const pkg = PROVIDER_PACKAGE[provider];
  const namespace = PROVIDER_NAMESPACE[provider];
  if (!pkg || !namespace) {
    const supported = Object.keys(PROVIDER_PACKAGE).sort().join(', ');
    throw new Error(
      `--provider-tool is not supported for provider "${provider}". ` +
      `Supported providers: ${supported}.`,
    );
  }

  const mod = await tryImport(pkg, provider, namespace);
  // Provider exports (e.g. `google`) are callable factories (function
  // values) that *also* carry a `.tools` property. `typeof` returns
  // `'function'` for those, not `'object'`, so accept both.
  const providerObj = mod[namespace] as
    | Record<string, unknown>
    | ((...a: unknown[]) => unknown)
    | undefined;
  const isObj = (v: unknown): v is Record<string, unknown> =>
    v !== null && (typeof v === 'object' || typeof v === 'function');
  const toolsObj = isObj(providerObj)
    ? (providerObj as { tools?: unknown }).tools
    : undefined;
  if (!isObj(toolsObj)) {
    throw new Error(
      `Provider SDK "${pkg}" does not expose a \`${namespace}.tools\` object. ` +
      `Update "${pkg}" to a version that includes provider-native tools.`,
    );
  }
  const available = Object.keys(toolsObj as Record<string, unknown>);

  // Validate all names up front so the user sees every typo at once
  // rather than one-at-a-time on successive invocations.
  const resolved: Array<{ canonical: string }> = [];
  for (const name of names) {
    const canonical = resolveToolName(provider, name, available);
    if (!canonical) {
      const aliases = Object.keys(ALIASES[provider] ?? {});
      const valid = [...new Set([...aliases, ...available])].sort().join(', ');
      throw new Error(
        `Unknown provider tool "${name}" for provider "${provider}". ` +
        `Valid names: ${valid}.`,
      );
    }
    resolved.push({ canonical });
  }

  const built: ToolSet = {};
  for (const { canonical } of resolved) {
    const fn = (toolsObj as Record<string, unknown>)[canonical];
    if (typeof fn !== 'function') {
      throw new Error(
        `Provider SDK "${pkg}" is missing the expected tool factory ` +
        `"${namespace}.tools.${canonical}". Verify the installed version supports it.`,
      );
    }
    const key = `${provider}__${canonical}`;
    (built as Record<string, unknown>)[key] = (
      fn as (args: Record<string, unknown>) => unknown
    )({});
  }
  return built;
}

/**
 * Parse a `--provider-options` JSON string into the typed shape
 * `AgentConfig.providerOptions` expects. Throws with a friendly
 * message on parse failure or if the top-level value isn't an object
 * keyed by string → object.
 */
export function parseProviderOptions(
  raw: string,
): ProviderOptions {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw, (key, value) => {
      // Belt-and-braces: drop prototype-pollution keys at any depth so
      // `--provider-options` can't reach `Object.prototype`.
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        return undefined;
      }
      return value;
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `--provider-options must be valid JSON. Parse error: ${msg}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `--provider-options must be a JSON object keyed by provider id ` +
      `(e.g. '{"google":{"useSearchGrounding":true}}').`,
    );
  }
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      throw new Error(
        `--provider-options.${k} must be a JSON object of provider-specific keys.`,
      );
    }
  }
  // Safe cast: `JSON.parse` produces only JSON-compatible values, which
  // is exactly what `ProviderOptions` (`Record<string, JSONValue>`)
  // accepts. The shape check above guarantees the two-level structure.
  return parsed as ProviderOptions;
}
