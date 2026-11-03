## Changelog

- Update `CHANGELOG.md` with user-visible changes; docs, tests, and refactors need entries only when users are affected. Preserve unrelated edits.
- Review the diff and existing entries. For catch-ups, inspect commits since the last changelog update, verify behavior in code, and add only missing changes.
- Follow Keep a Changelog 1.1.0 and SemVer. Write concise, user-facing bullets describing practical effects and useful settings/commands. Group related changes; omit duplicates, placeholders, and implementation details.
- Add entries under `## [Unreleased]`, using only populated `###` categories in this order: Added, Changed, Deprecated, Removed, Fixed, Security.
- Check `package.json`, both root versions in `package-lock.json`, and git version history. Use `## [X.Y.Z] - YYYY-MM-DD`; assign changes to their version boundary and leave later changes unreleased. Verify dates or label them as reconstructed from version commits.
- Maintain bottom reference links in the repository containing the commits: Unreleased compares the latest version to HEAD; each version compares its predecessor; the initial version links to its release/tree. Use actual tags, falling back to commit hashes.
- Change package versions or historical attribution only for requested releases/reconciliation. Before a release commit/tag, move its unreleased entries into the dated version section and update links.
