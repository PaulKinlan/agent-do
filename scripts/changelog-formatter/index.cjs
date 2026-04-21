/**
 * Changelog formatter for `@changesets/cli`.
 *
 * Wraps `@changesets/changelog-github` with a fallback: when the GitHub
 * GraphQL lookup fails (missing token, commit not yet indexed, PR not
 * discoverable, etc.), we emit the changeset's summary line as a plain
 * bullet instead of crashing the whole release.
 *
 * Why: the upstream plugin throws `Cannot read properties of null
 * (reading 'author')` if `object(expression: <sha>)` returns null,
 * which is common for commits that were pushed seconds ago (GitHub
 * GraphQL indexes slower than REST). The failure mode of a locally-
 * driven release shouldn't be "changelog generation explodes"; it
 * should be "slightly less rich changelog line."
 *
 * See: `scripts/release.sh`, `.changeset/config.json`.
 */

const githubChangelog = require('@changesets/changelog-github').default;

/**
 * Render a plain summary line when the GitHub-aware formatter errors.
 * Matches the shape the upstream plugin emits on the happy path
 * (`- summary`), just without the PR / commit / author links.
 */
function plainSummary(changeset) {
  const firstLine = (changeset.summary || '').split('\n')[0].trimEnd();
  return `\n\n- ${firstLine}`;
}

module.exports = {
  async getReleaseLine(changeset, type, options) {
    try {
      return await githubChangelog.getReleaseLine(changeset, type, options);
    } catch (err) {
      // Emit a warning so operators notice something's off, but don't
      // fail the release. Common triggers: fresh commit not yet indexed
      // by GH GraphQL, missing GITHUB_TOKEN scope, rate limit.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[changelog] GitHub enrichment failed for changeset "${changeset.id ?? '<unknown>'}" — falling back to plain summary. (${msg})`,
      );
      return plainSummary(changeset);
    }
  },

  async getDependencyReleaseLine(changesets, dependenciesUpdated, options) {
    try {
      return await githubChangelog.getDependencyReleaseLine(
        changesets,
        dependenciesUpdated,
        options,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[changelog] GitHub enrichment failed for dependency update — falling back to plain line. (${msg})`,
      );
      if (dependenciesUpdated.length === 0) return '';
      const updates = dependenciesUpdated
        .map((d) => `  - ${d.name}@${d.newVersion}`)
        .join('\n');
      return `\n\n- Updated dependencies:\n${updates}`;
    }
  },
};
