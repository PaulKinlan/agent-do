import { describe, it, expect, vi } from 'vitest';
import { createAgent } from '../src/agent.js';
import { runAgentLoop, streamAgentLoop } from '../src/loop.js';
import { createMockModel } from '../src/testing/index.js';
import {
  parseSlashCommand,
  tryRouteSlashCommandRun,
  unknownSlashCommandMessage,
  validateSlashCommands,
} from '../src/slash-commands.js';
import { parseArgs } from '../src/cli/args.js';
import { UsageTracker } from '../src/usage.js';
import type { Agent, AgentConfig, ProgressEvent } from '../src/types.js';

// Helper to cast a mock model into the AgentConfig['model'] slot. The AI
// SDK's LanguageModel type is structural; the mock satisfies it at runtime
// but TS wants the cast for assignment.
function mockModel(
  ...args: Parameters<typeof createMockModel>
): AgentConfig['model'] {
  return createMockModel(...args) as unknown as AgentConfig['model'];
}

// ── parseSlashCommand unit tests ─────────────────────────────────────

describe('parseSlashCommand', () => {
  it('extracts name + remainder', () => {
    expect(parseSlashCommand('/research quantum cryptography')).toEqual({
      name: 'research',
      rest: 'quantum cryptography',
    });
  });

  it('returns empty remainder when no args are given', () => {
    expect(parseSlashCommand('/review')).toEqual({ name: 'review', rest: '' });
  });

  it('preserves inner whitespace in the remainder', () => {
    expect(parseSlashCommand('/triage  a   b')).toEqual({
      name: 'triage',
      rest: 'a   b',
    });
  });

  it('tolerates leading whitespace before the slash', () => {
    expect(parseSlashCommand('   /go now')).toEqual({
      name: 'go',
      rest: 'now',
    });
  });

  it.each([
    ['non-slash input', 'hello world'],
    ['empty string', ''],
    ['bare slash', '/'],
    ['slash then space only', '/   '],
    ['a file path (not a command)', '/etc/hosts'],
    ['mid-string slash is not a command', 'run /research'],
  ])('returns null for: %s', (_label, input) => {
    expect(parseSlashCommand(input)).toBeNull();
  });

  it('accepts underscore and hyphen in command names', () => {
    expect(parseSlashCommand('/deep-dive topic')).toEqual({
      name: 'deep-dive',
      rest: 'topic',
    });
    expect(parseSlashCommand('/ship_it')).toEqual({ name: 'ship_it', rest: '' });
  });
});

// ── createAgent config-time validation ───────────────────────────────

describe('createAgent — slashCommands validation', () => {
  it('accepts a valid slashCommands map', () => {
    expect(() =>
      createAgent({
        id: 'parent',
        name: 'Parent',
        model: mockModel({ responses: [{ text: 'ok' }] }),
        slashCommands: {
          research: createAgent({
            id: 'research',
            name: 'Research',
            model: mockModel({ responses: [{ text: 'researched' }] }),
          }),
        },
      }),
    ).not.toThrow();
  });

  it('rejects an invalid command-name key', () => {
    expect(() =>
      createAgent({
        id: 'parent',
        name: 'Parent',
        model: mockModel({ responses: [{ text: 'ok' }] }),
        // slashCommands keys must match /^[a-zA-Z0-9_-]+$/
        slashCommands: {
          'bad/key': createAgent({
            id: 'x',
            name: 'X',
            model: mockModel({ responses: [{ text: 'ok' }] }),
          }),
        },
      }),
    ).toThrow(/slashCommands key "bad\/key"/);
  });

  it('rejects a non-Agent value', () => {
    expect(() =>
      createAgent({
        id: 'parent',
        name: 'Parent',
        model: mockModel({ responses: [{ text: 'ok' }] }),
        slashCommands: { research: { not: 'an agent' } as unknown as never },
      }),
    ).toThrow(/slashCommands\["research"\] must be an Agent instance/);
  });

  it('rejects nested slash commands on a sub-agent', () => {
    // A sub-agent that itself defines slashCommands is a nested-dispatch
    // agent — disallowed because /a/b routing isn't supported.
    const nested = createAgent({
      id: 'nested',
      name: 'Nested',
      model: mockModel({ responses: [{ text: 'ok' }] }),
      slashCommands: {
        inner: createAgent({
          id: 'inner',
          name: 'Inner',
          model: mockModel({ responses: [{ text: 'ok' }] }),
        }),
      },
    });

    expect(() =>
      createAgent({
        id: 'parent',
        name: 'Parent',
        model: mockModel({ responses: [{ text: 'ok' }] }),
        slashCommands: { nested },
      }),
    ).toThrow(/Nested slash commands .* are not supported/);
  });

  it('does not stamp the marker on agents without slashCommands', () => {
    // A plain agent (no slashCommands) must remain usable as a sub-agent
    // of a slash-command parent — the marker only flags dispatch-capable
    // agents.
    const plain = createAgent({
      id: 'plain',
      name: 'Plain',
      model: mockModel({ responses: [{ text: 'ok' }] }),
    });
    expect(() =>
      createAgent({
        id: 'parent',
        name: 'Parent',
        model: mockModel({ responses: [{ text: 'ok' }] }),
        slashCommands: { plain },
      }),
    ).not.toThrow();
  });

  it('rejects a duck-typed value without runWithResult (agent-do-5oz)', () => {
    // A slash sub-agent without usage telemetry would silently report
    // zeroed spend, defeating the parent's usage accounting. Failing at
    // construction is louder and cheaper than a wrong number.
    const fake = {
      id: 'fake',
      name: 'Fake',
      run: async () => 'x',
      stream: async function* () {},
      abort: () => {},
      // no runWithResult
    } as unknown as Agent;
    expect(validateSlashCommands({ fake })).toMatch(/runWithResult|must be an Agent instance/);
  });
});

// ── runAgentLoop dispatch ────────────────────────────────────────────

describe('runAgentLoop — slash-command dispatch', () => {
  it('routes /<name> <rest> to the sub-agent with the remainder', async () => {
    const research = createAgent({
      id: 'research',
      name: 'Research',
      model: mockModel({ responses: [{ text: 'research-result' }] }),
    });
    const runSpy = vi.spyOn(research, 'runWithResult');

    const parent: AgentConfig = {
      id: 'parent',
      name: 'Parent',
      // Parent mock would produce 'PARENT-RAN' if it were called.
      model: mockModel({ responses: [{ text: 'PARENT-RAN' }] }),
      slashCommands: { research },
    };

    const result = await runAgentLoop(parent, '/research quantum cryptography');

    // Sub-agent ran with the remainder (not the slash prefix).
    expect(runSpy).toHaveBeenCalledWith('quantum cryptography', undefined);
    // Parent's text never reached the caller.
    expect(result.text).toBe('research-result');
    expect(result.text).not.toBe('PARENT-RAN');
    // One sub-agent turn.
    expect(result.steps).toBe(1);
    expect(result.aborted).toBe(false);
  });

  it('forwards context to the sub-agent but not history', async () => {
    const research = createAgent({
      id: 'research',
      name: 'Research',
      model: mockModel({ responses: [{ text: 'ok' }] }),
    });
    const runSpy = vi.spyOn(research, 'runWithResult');

    const parent: AgentConfig = {
      id: 'parent',
      name: 'Parent',
      model: mockModel({ responses: [{ text: 'PARENT-RAN' }] }),
      slashCommands: { research },
    };

    await runAgentLoop(parent, '/research X', 'ctx', [
      { role: 'user', content: 'old turn' },
    ]);

    // context forwarded, history NOT forwarded (3rd arg undefined).
    expect(runSpy).toHaveBeenCalledWith('X', 'ctx');
  });

  it('returns a listing for an unknown command and does NOT call the parent model', async () => {
    const parent: AgentConfig = {
      id: 'parent',
      name: 'Parent',
      // If the parent model ran, the caller would see 'PARENT-RAN'.
      model: mockModel({ responses: [{ text: 'PARENT-RAN' }] }),
      slashCommands: {
        research: createAgent({
          id: 'research',
          name: 'Research',
          model: mockModel({ responses: [{ text: 'x' }] }),
        }),
        review: createAgent({
          id: 'review',
          name: 'Review',
          model: mockModel({ responses: [{ text: 'y' }] }),
        }),
      },
    };

    const result = await runAgentLoop(parent, '/nonexistent thing');

    // Listing surfaces the available commands (sorted, deterministic).
    expect(result.text).toBe(
      'Unknown slash command "/nonexistent". Available commands: /research, /review.',
    );
    expect(result.text).not.toBe('PARENT-RAN');
    // steps === 0 is the structural proof no model iteration ran.
    expect(result.steps).toBe(0);
  });

  it('dispatches with empty args when /<name> has no remainder', async () => {
    const research = createAgent({
      id: 'research',
      name: 'Research',
      model: mockModel({ responses: [{ text: 'empty-arg-result' }] }),
    });
    const runSpy = vi.spyOn(research, 'runWithResult');

    const parent: AgentConfig = {
      id: 'parent',
      name: 'Parent',
      model: mockModel({ responses: [{ text: 'PARENT-RAN' }] }),
      slashCommands: { research },
    };

    const result = await runAgentLoop(parent, '/research');

    // Sub-agent still dispatched, with the empty string as its task.
    expect(runSpy).toHaveBeenCalledWith('', undefined);
    expect(result.text).toBe('empty-arg-result');
  });

  it('bypasses the router for non-slash input and runs the parent model', async () => {
    const research = createAgent({
      id: 'research',
      name: 'Research',
      model: mockModel({ responses: [{ text: 'SUB-RAN' }] }),
    });
    const runSpy = vi.spyOn(research, 'runWithResult');

    const parent: AgentConfig = {
      id: 'parent',
      name: 'Parent',
      model: mockModel({ responses: [{ text: 'parent-result' }] }),
      slashCommands: { research },
    };

    const result = await runAgentLoop(parent, 'just a normal question');

    // Parent handled the turn; sub-agent never invoked.
    expect(runSpy).not.toHaveBeenCalled();
    expect(result.text).toBe('parent-result');
    expect(result.steps).toBeGreaterThanOrEqual(1);
  });

  it('treats a path-shaped task as non-slash (falls through to the parent)', async () => {
    // /etc/hosts is not a valid command name, so it must NOT be routed.
    const parent: AgentConfig = {
      id: 'parent',
      name: 'Parent',
      model: mockModel({ responses: [{ text: 'parent-result' }] }),
      slashCommands: {
        etc: createAgent({
          id: 'etc',
          name: 'Etc',
          model: mockModel({ responses: [{ text: 'SUB-RAN' }] }),
        }),
      },
    };

    const result = await runAgentLoop(parent, '/etc/hosts');
    expect(result.text).toBe('parent-result');
  });
});

// ── usage accounting across the dispatch boundary (agent-do-5oz) ────

describe('slash-command dispatch — usage accounting', () => {
  it("returns the sub-agent's real usage, not zeros", async () => {
    // $1 input / $2 output per 1M tokens; the mock spends 10 in / 20 out
    // per model call, so one sub-agent call costs 0.00005.
    const pricing = { 'mock-model': { input: 1, output: 2 } }; // cents-free USD rates
    const research = createAgent({
      id: 'research',
      name: 'Research',
      model: mockModel({ responses: [{ text: 'research-result' }] }),
      usage: { pricing },
    });

    const parent: AgentConfig = {
      id: 'parent',
      name: 'Parent',
      model: mockModel({ responses: [{ text: 'PARENT-RAN' }] }),
      slashCommands: { research },
    };

    const result = await runAgentLoop(parent, '/research topic');

    expect(result.text).toBe('research-result');
    expect(result.usage.totalInputTokens).toBe(10);
    expect(result.usage.totalOutputTokens).toBe(20);
    expect(result.usage.totalCost).toBeCloseTo(0.00005, 10);
    expect(result.usage.records).toHaveLength(1);
    // Still one parent-level dispatch hop.
    expect(result.steps).toBe(1);
    expect(result.aborted).toBe(false);
  });

  it('propagates the sub-agent\'s aborted flag', async () => {
    // A pre-aborted signal on the sub's config makes its own loop end
    // with aborted: true deterministically (the run never starts an
    // iteration).
    const controller = new AbortController();
    controller.abort();
    const research = createAgent({
      id: 'research',
      name: 'Research',
      model: mockModel({ responses: [{ text: 'partial' }] }),
      signal: controller.signal,
    });
    const parent: AgentConfig = {
      id: 'parent',
      name: 'Parent',
      model: mockModel({ responses: [{ text: 'PARENT-RAN' }] }),
      slashCommands: { research },
    };

    const aborted = await runAgentLoop(parent, '/research topic');
    expect(aborted.aborted).toBe(true);
  });

  it('falls back to zeroed usage for a duck-typed sub without runWithResult', async () => {    // Direct tryRouteSlashCommandRun call with a hand-built config that
    // never went through createAgent validation: the router must not
    // crash, and must say (via zeroed usage) that it could not see the
    // sub's spend.
    const sub = {
      id: 'legacy',
      name: 'Legacy',
      run: async () => 'legacy-result',
      stream: async function* () {},
      abort: () => {},
    } as unknown as Agent;

    const result = await tryRouteSlashCommandRun(
      { id: 'p', name: 'P', model: mockModel({ responses: [{ text: 'x' }] }), slashCommands: { legacy: sub } },
      '/legacy hi',
    );

    expect(result).not.toBeNull();
    expect(result!.text).toBe('legacy-result');
    expect(result!.usage.totalInputTokens).toBe(0);
    expect(result!.usage.totalCost).toBe(0);
    expect(result!.steps).toBe(1);
  });

  // agent-do-tpp: reporting the sub's usage is not the same as enforcing the
  // parent's limits on it. The dispatch must reach checkLimits().
  it('consults the parent’s spending guard for what the dispatch spent', async () => {
    const pricing = { 'mock-model': { input: 1, output: 2 } };
    const onLimitExceeded = vi.fn().mockResolvedValue(false);
    const research = createAgent({
      id: 'research',
      name: 'Research',
      model: mockModel({ responses: [{ text: 'research-result' }] }),
      usage: { pricing },
    });
    const parent: AgentConfig = {
      id: 'parent',
      name: 'Parent',
      model: mockModel({ responses: [{ text: 'PARENT-RAN' }] }),
      slashCommands: { research },
      // One sub-agent call costs $0.00005 — 5 × the parent's perRun.
      usage: { pricing, limits: { perRun: 0.00001 }, onLimitExceeded },
    };

    const result = await runAgentLoop(parent, '/research topic');

    expect(onLimitExceeded).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'perRun' }),
    );
    // The guard refused, so the dispatch is reported as aborted rather than
    // as a clean, unguarded run.
    expect(result.aborted).toBe(true);
    expect(result.text).toBe('research-result');
  });

  it('records the dispatch into an injected parent tracker, without double counting', async () => {
    const pricing = { 'mock-model': { input: 1, output: 2 } };
    const ledger = new UsageTracker({ pricing });
    const research = createAgent({
      id: 'research',
      name: 'Research',
      model: mockModel({ responses: [{ text: 'research-result' }] }),
      usage: { pricing, tracker: ledger },
    });
    const parent: AgentConfig = {
      id: 'parent',
      name: 'Parent',
      model: mockModel({ responses: [{ text: 'PARENT-RAN' }] }),
      slashCommands: { research },
      usage: { pricing, tracker: ledger },
    };

    await runAgentLoop(parent, '/research topic');

    // The sub already recorded into this tracker; the dispatch must not
    // record the same step a second time.
    expect(ledger.getSummary().steps).toBe(1);
    expect(ledger.getSummary().totalCost).toBeCloseTo(0.00005, 10);
  });
});

// ── streamAgentLoop dispatch ─────────────────────────────────────────

describe('streamAgentLoop — slash-command dispatch', () => {
  async function collect(stream: AsyncIterable<ProgressEvent>): Promise<ProgressEvent[]> {
    const events: ProgressEvent[] = [];
    for await (const ev of stream) events.push(ev);
    return events;
  }

  it('forwards the sub-agent stream after a dispatch announcement', async () => {
    const research = createAgent({
      id: 'research',
      name: 'Research',
      model: mockModel({ responses: [{ text: 'streamed-research' }] }),
    });
    const streamSpy = vi.spyOn(research, 'stream');

    const parent: AgentConfig = {
      id: 'parent',
      name: 'Parent',
      model: mockModel({ responses: [{ text: 'PARENT-RAN' }] }),
      slashCommands: { research },
    };

    const events = await collect(streamAgentLoop(parent, '/research X'));

    // Sub-agent stream was invoked with the remainder.
    expect(streamSpy).toHaveBeenCalledWith('X', undefined);

    const types = events.map((e) => e.type);
    // The sub-agent's own stream yields a done event; the dispatch
    // announcement is a thinking event that precedes it.
    expect(types[0]).toBe('thinking');
    expect(types).toContain('done');
    const done = events.find((e) => e.type === 'done');
    expect(done?.content).toBe('streamed-research');
  });

  it('yields the listing as final text for an unknown command (no parent model)', async () => {
    const parent: AgentConfig = {
      id: 'parent',
      name: 'Parent',
      model: mockModel({ responses: [{ text: 'PARENT-RAN' }] }),
      slashCommands: {
        review: createAgent({
          id: 'review',
          name: 'Review',
          model: mockModel({ responses: [{ text: 'x' }] }),
        }),
      },
    };

    const events = await collect(streamAgentLoop(parent, '/nope'));

    const types = events.map((e) => e.type);
    // No model ran: just the listing text + done.
    expect(types).toEqual(['text', 'done']);
    const done = events.find((e) => e.type === 'done');
    expect(done?.content).toBe(
      'Unknown slash command "/nope". Available commands: /review.',
    );
  });

  it('bypasses the router for non-slash input', async () => {
    const research = createAgent({
      id: 'research',
      name: 'Research',
      model: mockModel({ responses: [{ text: 'SUB-RAN' }] }),
    });
    const streamSpy = vi.spyOn(research, 'stream');

    const parent: AgentConfig = {
      id: 'parent',
      name: 'Parent',
      model: mockModel({ responses: [{ text: 'parent-result' }] }),
      slashCommands: { research },
    };

    const events = await collect(streamAgentLoop(parent, 'hello'));

    expect(streamSpy).not.toHaveBeenCalled();
    const done = events.find((e) => e.type === 'done');
    expect(done?.content).toBe('parent-result');
  });
});

// ── unknownSlashCommandMessage helper ────────────────────────────────

// ── CLI input path (#76, criterion: CLI respects slash commands) ────

describe('CLI argument parsing preserves slash commands', () => {
  // The CLI (prompt.ts / script.ts) builds the task from args.prompt via
  // buildTask (pure string concat — no transformation that would strip a
  // leading '/'), then passes it unchanged into agent.stream(task). The
  // loop handles routing. So verifying parseArgs preserves the slash input
  // is sufficient to confirm the CLI path routes correctly end-to-end.
  it('keeps a leading slash intact through parseArgs in prompt mode', () => {
    const args = parseArgs(['/research', 'quantum', 'cryptography']);
    expect(args.command).toBe('prompt');
    expect(args.prompt).toBe('/research quantum cryptography');
    // And the loop's parser then sees it as a command.
    expect(parseSlashCommand(args.prompt!)).toEqual({
      name: 'research',
      rest: 'quantum cryptography',
    });
  });

  it('keeps a slash prompt intact through parseArgs in run mode', () => {
    // npx agent-do run <agent> "/research quantum cryptography"
    const args = parseArgs(['run', 'my-agent.ts', '/research quantum cryptography']);
    expect(args.command).toBe('run');
    expect(args.file).toBe('my-agent.ts');
    expect(args.prompt).toBe('/research quantum cryptography');
  });
});

describe('unknownSlashCommandMessage', () => {
  it('lists configured commands deterministically (sorted)', () => {
    const msg = unknownSlashCommandMessage('foo', {
      zebra: createAgent({
        id: 'zebra',
        name: 'Z',
        model: mockModel({ responses: [{ text: 'x' }] }),
      }),
      apple: createAgent({
        id: 'apple',
        name: 'A',
        model: mockModel({ responses: [{ text: 'x' }] }),
      }),
    });
    // Sorted so the message is stable regardless of insertion order.
    expect(msg).toBe('Unknown slash command "/foo". Available commands: /apple, /zebra.');
  });

  it('reports none-configured when the map is empty', () => {
    expect(unknownSlashCommandMessage('foo', {})).toBe(
      'Unknown slash command "/foo". Available commands: (none configured).',
    );
  });
});
