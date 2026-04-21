/**
 * CLI handlers for pack management (#78).
 *
 *   agent-do install <pack> [--force] [--from <dir>]
 *   agent-do uninstall <pack>
 *   agent-do list-packs
 *
 * Each handler is a thin wrapper over the programmatic API in
 * `src/packs/install.ts`. Errors propagate up to `cli.ts` which
 * prints them and exits non-zero.
 */

import { installPack, uninstallPack, listPacks } from '../packs/install.js';
import type { ParsedArgs } from './args.js';

export async function runInstallCommand(args: ParsedArgs): Promise<void> {
  if (!args.packName) {
    throw new Error('Usage: npx agent-do install <pack> [--force] [--from <dir>]');
  }
  const manifest = await installPack(args.packName, {
    cwd: args.workingDir,
    from: args.fromPath,
    force: args.force,
  });
  console.log(`Installed pack "${manifest.name}" v${manifest.version}`);
  console.log(`  ${manifest.description}`);
  console.log();
  console.log(`  Location: ${args.workingDir}/.agent-do/packs/${manifest.name}/`);
  const parts: string[] = [];
  if (manifest.skills?.length) parts.push(`${manifest.skills.length} skill${manifest.skills.length === 1 ? '' : 's'}`);
  if (manifest.routines?.length) parts.push(`${manifest.routines.length} routine${manifest.routines.length === 1 ? '' : 's'}`);
  if (manifest.policies?.length) parts.push(`${manifest.policies.length} polic${manifest.policies.length === 1 ? 'y' : 'ies'}`);
  if (manifest.mcpServers?.length) parts.push(`${manifest.mcpServers.length} MCP server binding${manifest.mcpServers.length === 1 ? '' : 's'}`);
  if (parts.length) console.log(`  Includes: ${parts.join(', ')}`);
  if (manifest.mcpServers?.length) {
    console.log();
    console.log(`  This pack expects the following MCP servers at runtime:`);
    for (const name of manifest.mcpServers) console.log(`    - ${name}`);
    console.log(`  Configure them via \`createTemplatePack('${manifest.name}', { mcpServers: { ... } })\`.`);
  }
}

export async function runUninstallCommand(args: ParsedArgs): Promise<void> {
  if (!args.packName) {
    throw new Error('Usage: npx agent-do uninstall <pack>');
  }
  const removed = await uninstallPack(args.packName, { cwd: args.workingDir });
  if (removed) {
    console.log(`Uninstalled pack "${args.packName}".`);
  } else {
    console.log(`Pack "${args.packName}" is not installed.`);
  }
}

export async function runListPacksCommand(args: ParsedArgs): Promise<void> {
  const entries = await listPacks({ cwd: args.workingDir });
  if (entries.length === 0) {
    console.log('No packs available.');
    return;
  }
  const bundled = entries.filter((e) => e.source === 'bundled');
  const user = entries.filter((e) => e.source === 'user');

  if (user.length > 0) {
    console.log('Installed packs:\n');
    for (const e of user) {
      console.log(`  ${padName(e.manifest.name)} v${e.manifest.version}  ${truncate(e.manifest.description, 60)}`);
    }
    console.log();
  }
  if (bundled.length > 0) {
    console.log('Available bundled packs:\n');
    for (const e of bundled) {
      const marker = e.shadowed ? ' (shadowed by installed version)' : '';
      console.log(`  ${padName(e.manifest.name)} v${e.manifest.version}  ${truncate(e.manifest.description, 60)}${marker}`);
    }
    console.log();
    console.log('Install with:  npx agent-do install <pack>');
  }
}

function padName(name: string): string {
  return name.padEnd(24);
}
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
