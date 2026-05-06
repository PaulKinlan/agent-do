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
 * Tools that the CLI knows are safe to instantiate with empty args
 * (`factory({})`) — the model can call them straight away and the
 * provider SDK is happy without per-tool config.
 *
 * Many SDK exports (`fileSearch`, `mcp`, `customTool`, ...) accept
 * `factory({})` without throwing but then fail at model-call time
 * because they need vector store IDs, MCP server URLs, etc. The CLI
 * can't supply that, so we reject those names early with a pointer
 * to script mode rather than letting the run blow up midway through.
 *
 * Anything not on this list (and not aliased to something on this
 * list) is rejected at `--provider-tool` validation. Adding a tool
 * here is an explicit promise that it works with empty args; bump
 * cautiously.
 */
const CLI_SAFE: Record<string, ReadonlySet<string>> = {
  google: new Set(['googleSearch', 'urlContext', 'codeExecution']),
  anthropic: new Set([
    'webSearch_20260209',
    'webSearch_20250305',
    'webFetch_20260209',
    'webFetch_20250910',
    'codeExecution_20260120',
    'codeExecution_20250825',
    'codeExecution_20250522',
    'bash_20250124',
    'bash_20241022',
    'textEditor_20250728',
    'textEditor_20250429',
    'textEditor_20250124',
    'textEditor_20241022',
    'computer_20251124',
    'computer_20250124',
    'computer_20241022',
    'memory_20250818',
  ]),
  openai: new Set([
    'webSearchPreview',
    'webSearch',
    'codeInterpreter',
    'imageGeneration',
    'applyPatch',
  ]),
};

/**
 * Short ergonomic names → ordered list of canonical export names.
 *
 * The resolver walks the list and picks the first entry that the
 * installed provider SDK actually exposes. This makes
 * `--provider-tool webSearch` keep working when a user is on an
 * older SDK that hasn't shipped the latest dated tool yet — the
 * alias falls back to the most recent installed variant rather than
 * being rejected outright.
 *
 * Order matters: list the latest dated/versioned export first.
 */
const ALIASES: Record<string, Record<string, readonly string[]>> = {
  google: {
    // Google's tools aren't dated, so aliases mostly mirror the
    // canonical names; entry exists so the same listing path works
    // for all three providers.
  },
  anthropic: {
    webSearch: ['webSearch_20260209', 'webSearch_20250305'],
    webFetch: ['webFetch_20260209', 'webFetch_20250910'],
    bash: ['bash_20250124', 'bash_20241022'],
    textEditor: [
      'textEditor_20250728',
      'textEditor_20250429',
      'textEditor_20250124',
      'textEditor_20241022',
    ],
    computer: ['computer_20251124', 'computer_20250124', 'computer_20241022'],
    codeExecution: [
      'codeExecution_20260120',
      'codeExecution_20250825',
      'codeExecution_20250522',
    ],
    memory: ['memory_20250818'],
  },
  openai: {
    webSearch: ['webSearchPreview'],
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
 * Sync pre-flight check for `--provider-tool` names. Validates that
 * the provider supports CLI provider tools at all, and that each
 * name is either a known alias or a CLI-safe canonical export. Used
 * by `create` to fail fast on `--provider ollama --provider-tool ...`
 * (and similar misconfigurations) without dynamically importing the
 * SDK — that final compatibility check still happens at run time
 * when `buildProviderTools` actually loads the package.
 */
export function validateCliProviderToolNames(
  provider: string,
  names: readonly string[],
): void {
  if (names.length === 0) return;
  const safeSet = CLI_SAFE[provider];
  if (!safeSet || !PROVIDER_PACKAGE[provider]) {
    const supported = Object.keys(CLI_SAFE).sort().join(', ');
    throw new Error(
      `Provider "${provider}" does not support --provider-tool. ` +
      `Supported providers: ${supported}.`,
    );
  }
  const aliases = ALIASES[provider] ?? {};
  for (const name of names) {
    const isAlias = Object.prototype.hasOwnProperty.call(aliases, name);
    const isSafe = safeSet.has(name);
    if (!isAlias && !isSafe) {
      const validNames = [
        ...new Set([
          ...Object.keys(aliases).filter((a) =>
            (aliases[a] ?? []).some((t) => safeSet.has(t)),
          ),
          ...safeSet,
        ]),
      ].sort();
      throw new Error(
        `Provider tool "${name}" is not a CLI-safe name for provider ` +
        `"${provider}". Valid CLI names: ${validNames.join(', ')}. ` +
        `For tools that need extra config, define them in a script export.`,
      );
    }
  }
}

/**
 * Resolve a user-typed tool name to the canonical export name on
 * `provider.tools`. Tries the alias table first (walking each
 * alternative in order so older SDKs fall back to whatever dated
 * variant they ship), then a direct match against the installed
 * SDK's actual exports. Returns `null` if neither matches.
 */
function resolveToolName(
  provider: string,
  name: string,
  available: readonly string[],
): string | null {
  const aliasTargets = ALIASES[provider]?.[name];
  if (aliasTargets) {
    for (const target of aliasTargets) {
      if (available.includes(target)) return target;
    }
  }
  if (available.includes(name)) return name;
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
  const safeSet = CLI_SAFE[provider] ?? new Set<string>();
  const aliases = ALIASES[provider] ?? {};
  const cliValidNames = [
    ...new Set([
      // An alias is a valid CLI name as long as *some* of its
      // ordered targets is in the safe set. Don't require the latest
      // target specifically — that would shadow the aliases on older
      // SDKs that only ship earlier dated variants.
      ...Object.keys(aliases).filter((a) =>
        (aliases[a] ?? []).some((t) => safeSet.has(t)),
      ),
      ...[...safeSet].filter((c) => available.includes(c)),
    ]),
  ].sort();
  const resolved: Array<{ canonical: string }> = [];
  for (const name of names) {
    const canonical = resolveToolName(provider, name, available);
    if (!canonical) {
      throw new Error(
        `Unknown provider tool "${name}" for provider "${provider}". ` +
        `Valid CLI names: ${cliValidNames.join(', ')}.`,
      );
    }
    if (!safeSet.has(canonical)) {
      // The SDK exports this name but it needs per-tool config the
      // CLI can't supply (vector store IDs, MCP server URL, etc.).
      // Point users at script mode where they can pass real args.
      throw new Error(
        `Provider tool "${name}" requires additional configuration that the ` +
        `CLI cannot supply. Configure it in a script export instead:\n` +
        `\n` +
        `  import { ${namespace} } from '${pkg}';\n` +
        `  export default {\n` +
        `    // ...\n` +
        `    tools: { ${canonical}: ${namespace}.tools.${canonical}({ /* args */ }) },\n` +
        `  };\n` +
        `\n` +
        `CLI-safe names for "${provider}": ${cliValidNames.join(', ')}.`,
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
    // Some provider tools take required config (OpenAI `fileSearch`
    // needs `vectorStoreIds`, `mcp` needs `serverLabel`+URL, etc.).
    // The CLI can only pass `{}`, so a missing-arg throw inside the
    // factory becomes a confusing failure later in the run. Catch it
    // here and surface a clear "use a script export" message instead.
    try {
      (built as Record<string, unknown>)[key] = (
        fn as (args: Record<string, unknown>) => unknown
      )({});
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Provider tool "${canonical}" for provider "${provider}" requires ` +
        `additional configuration that the CLI cannot supply ` +
        `(${detail}). Configure this tool in a script export instead:\n` +
        `\n` +
        `  import { ${namespace} } from '${pkg}';\n` +
        `  export default {\n` +
        `    // ...\n` +
        `    tools: { ${canonical}: ${namespace}.tools.${canonical}({ /* args */ }) },\n` +
        `  };`,
      );
    }
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
