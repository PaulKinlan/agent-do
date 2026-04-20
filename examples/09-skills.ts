/**
 * Example 9: Skills System
 *
 * Skills are instructions that extend an agent's capabilities. They're
 * injected into the system prompt (in `full` mode) or surfaced via a
 * `load_skill(id)` tool on demand (in `manifest` mode).
 *
 * This example covers both:
 *   Part 1 — Full mode: one skill, full body inlined (pre-#74 behaviour).
 *   Part 2 — Manifest mode: many skills, compact metadata in the prompt,
 *            bodies fetched on demand with `triggers:` phrases helping
 *            the model match user intent. See issue #74.
 *
 * Run: npx tsx examples/09-skills.ts
 */

import { createAgent, InMemorySkillStore, parseSkillMd } from 'agent-do';
import { createAnthropic } from '@ai-sdk/anthropic';

console.log('═══════════════════════════════════════');
console.log('  Example 9: Skills System');
console.log('═══════════════════════════════════════\n');

console.log('Skills are markdown documents that get injected into the system prompt.');
console.log('They give the agent domain-specific instructions without changing its code.\n');

// ── Setup: Install a code review skill ──
console.log('── Setup: Installing a "Code Review" skill ──');
console.log('   The skill teaches the agent to check for:');
console.log('     - Security vulnerabilities (SQL injection, XSS, etc.)');
console.log('     - Common bugs (off-by-one, null checks, race conditions)');
console.log('     - Readability and naming conventions');
console.log('     - Constructive suggestions\n');

const model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })('claude-sonnet-4-6');

const skills = new InMemorySkillStore();

const codeReviewSkill = parseSkillMd(`---
id: code-review
name: Code Review
description: Expert code reviewer that checks for bugs, security issues, and best practices
author: example
version: 1.0.0
---

# Code Review Skill

When reviewing code:
1. Check for security vulnerabilities (SQL injection, XSS, etc.)
2. Look for common bugs (off-by-one, null checks, race conditions)
3. Evaluate readability and naming conventions
4. Suggest improvements with specific examples
5. Note what's done well — be constructive
`);

await skills.install(codeReviewSkill);
console.log('   Skill installed: code-review v1.0.0\n');

const agent = createAgent({
  id: 'reviewer',
  name: 'Code Reviewer',
  model: model as any,
  systemPrompt: 'You are a code review assistant.',
  skills,
  maxIterations: 5,
});

// ── Task: Review a snippet with a SQL injection vulnerability ──
console.log('── Task: Review a code snippet ──');
console.log('   Sending a Node.js route handler with an obvious SQL injection bug.');
console.log('   The skill should guide the agent to catch it.\n');

const codeSnippet = `app.get('/user/:id', (req, res) => {
  const query = "SELECT * FROM users WHERE id = " + req.params.id;
  db.query(query, (err, result) => res.json(result));
});`;

console.log('   Code to review:');
codeSnippet.split('\n').forEach(line => console.log(`   | ${line}`));
console.log('');

const result = await agent.run(`Review this code:\n\`\`\`js\n${codeSnippet}\n\`\`\``);

console.log('   Agent review:\n');
result.split('\n').forEach(line => console.log(`   ${line}`));
console.log('');

console.log('Done — the agent reviewed the code using its installed skill.\n');

// ── Part 2: Manifest mode + triggers ──
console.log('═══════════════════════════════════════');
console.log('  Part 2: Manifest mode + triggers (#74)');
console.log('═══════════════════════════════════════\n');

console.log('When you have many skills, dumping every body into every prompt');
console.log('is wasteful. `skillsMode: "manifest"` emits only id/name/description');
console.log('+ triggers, and adds a `load_skill(id)` tool the model can call');
console.log('on demand. `skillsMode: "auto"` (default) flips to manifest once');
console.log('the combined bodies exceed `skillsManifestThreshold` (32 KB).\n');

const manyStore = new InMemorySkillStore();

await manyStore.install(parseSkillMd(`---
name: Inbox Triage
description: Use when the user asks to triage inbox, classify emails, or prioritise unread messages. NOT for composing replies.
triggers:
  - triage my inbox
  - classify my emails
  - prioritise unread messages
---

# Inbox Triage

1. Search inbox for unread messages
2. Classify each into: urgent / response-needed / informational / spam
3. Write a summary with counts and the top 3 items in each bucket
`));

await manyStore.install(parseSkillMd(`---
name: Weekly Report
description: Use when the user asks for a weekly summary, status update, or week-in-review.
triggers:
  - weekly report
  - what did I do this week
  - weekly rollup
---

# Weekly Report

1. Read the last 7 daily entries
2. Extract themes across Events / People / Decisions / Open Threads
3. Write a markdown file with sections for each theme
`));

await manyStore.install(parseSkillMd(`---
name: Meeting Notes
description: Use when the user asks to turn meeting notes into action items or structured summary.
triggers:
  - summarise my meeting
  - turn this into action items
  - extract decisions from the meeting
---

# Meeting Notes

1. Identify attendees, decisions, and action items
2. Group action items by owner
3. Flag follow-up dates
`));

console.log(`Installed 3 skills with triggers:, into a manifest-mode agent.\n`);

const manifestAgent = createAgent({
  id: 'assistant',
  name: 'Assistant',
  model: model as any,
  systemPrompt: 'You are a personal assistant.',
  skills: manyStore,
  skillsMode: 'manifest',
  maxIterations: 5,
});

console.log('Task: "Can you summarise my meeting from this morning?"');
console.log('The manifest-mode agent should call `load_skill({ skillId: "meeting-notes" })`');
console.log('before acting — the prompt only shows each skill\'s description,');
console.log('not the full body.\n');

const manifestResult = await manifestAgent.run(
  'Can you summarise my meeting from this morning? Here are the raw notes:\n\n' +
    '- Alice, Bob, Carol attended. Quick sync on Q2 planning.\n' +
    '- Decision: ship v2 of the payments API by May 15.\n' +
    '- Alice to write the spec by April 25.\n' +
    '- Bob to scope the migration; follow up next Monday.\n',
);

console.log('Agent output:\n');
manifestResult.split('\n').forEach((line) => console.log(`   ${line}`));
console.log('');

console.log('Done — the manifest-mode agent found the right skill from the');
console.log('manifest, called load_skill to retrieve the body, then applied it.');
