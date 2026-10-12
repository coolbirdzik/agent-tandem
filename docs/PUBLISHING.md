# Publish AgentTandem on VS Code Marketplace

## 1. Create a publisher

1. Open [Visual Studio Marketplace publisher management](https://marketplace.visualstudio.com/manage/publishers/).
2. Sign in with the Microsoft account you want to own the extension.
3. Select **Create publisher**.
4. Choose an **ID**, for example a personal or studio identifier. This is the value the build needs; it is different from the display name. Marketplace publisher IDs cannot be changed after creation.
5. Enter the publisher's display name and complete the required fields. Save the publisher.

You can upload a VSIX manually through this page. The build workflow does not need a personal access token or an automated publishing credential. See [Microsoft's publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).

## 2. Put the project on GitHub

Push this repository to GitHub. The screenshots and documentation links must be publicly accessible to display on the public Marketplace listing.

Open **Settings → Secrets and variables → Actions → Variables**, and add:

| Variable | Value |
| --- | --- |
| `MARKETPLACE_PUBLISHER` | `coolbirdv` (already configured as the workflow default) |

The workflow derives content URLs from the GitHub repository and the branch or tag being built. Local builds default to `main`; pass `--branch YOUR_BRANCH` if needed. Commit the screenshots before submitting.

## 3. Build the upload package

### GitHub Actions

1. Open **Actions → Build Marketplace VSIX → Run workflow**.
2. Select the branch and keep **publisher** set to `coolbirdv`.
3. Run the workflow. It installs locked dependencies, typechecks, runs the unit suite, builds and packages the stable extension, then tests it in a separate VS Code profile.
4. Open the completed run and download **agent-tandem-vsix-…** from **Artifacts**.
5. Extract the downloaded ZIP. The `.vsix` inside is the extension package; keep its `.sha256` file for verification.

Pushes to `main` and pull requests targeting `main` create **preview** artifacts. A manual run on `main` builds an upload package without creating a GitHub Release. The configured publisher is `coolbirdv`; the repository variable can override it.

### Automatic GitHub Releases from main tags

Pushing a semantic version tag such as `v0.1.1` creates a GitHub Release after the unit tests and stable VS Code host tests pass. The tag must match the version in `package.json` and point to a commit reachable from `origin/main`. Tags on unmerged feature branches are rejected. The workflow never bumps versions or pushes commits on your behalf.

Start from a clean, up-to-date `main`, choose one bump command, then release:

```powershell
git switch main
git pull --ff-only
npm run bump:patch
npm run release
```

| Command | Example starting at `0.1.0` |
| --- | --- |
| `npm run bump:patch` | `0.1.1` — fixes |
| `npm run bump:minor` | `0.2.0` — features |
| `npm run bump:major` | `1.0.0` — breaking changes |

Each bump updates `package.json` and `package-lock.json`, creates a version commit and an annotated `vX.Y.Z` tag locally. `npm run release` checks that the tag points to HEAD and local main includes the latest remote main, then atomically pushes main and only that version tag to origin. Both commands require a clean `main`. Run release immediately after bump; do not insert another commit. If a network failure interrupts the push, run `npm run release` again without bumping again.

The workflow checks out the complete history and generates release notes from the preceding reachable version tag to the tagged commit, following the [CB-File-Hub release workflow](https://github.com/coolbirdzik/CB-File-Hub/blob/main/.github/workflows/release.yml). The first release includes the initial commit history. Merge commits, `ci:` housekeeping and release-version bump commits are omitted. Notes contain commit links and a full compare link when a preceding tag exists.

The GitHub Release includes the VSIX and its SHA-256 checksum. The same git-history notes are prepended to the packaged `CHANGELOG.md`; `dist/release.json` records the source commit and tags. Source files are unchanged. Re-running the release job updates the assets/notes for the same release.

Only the release job receives `contents: write`; test/build jobs remain read-only. GitHub Release creation uses the workflow's `GITHUB_TOKEN`, without a separate PAT. Marketplace submission is still manual.

Failed unit or host tests leave a downloadable **agent-tandem-test-diagnostics** artifact. It contains the unit JSON report and available VS Code logs/restart reports, so failures can be diagnosed even when packaging or release is skipped.

### Local PowerShell

```powershell
npm ci
npm run typecheck
npm test -- --maxWorkers=2 --testTimeout=15000
npm run package:marketplace -- --publisher coolbirdv --repository-url https://github.com/YOUR_ACCOUNT/YOUR_REPO
```

Output: `artifacts/agent-tandem-VERSION.vsix`, its checksum, and `artifacts/marketplace-build.json`. The metadata records the actual publisher and staging folder. The source manifest remains unchanged.

Before creating a publisher, validate the build with:

```powershell
npm run package:marketplace -- --preview
```

This creates `agent-tandem-VERSION-preview.vsix` with the local publisher. Rebuild with your real ID and repository URL before uploading. Renaming the file cannot change its embedded publisher.

## 4. Test and submit

1. Install the upload VSIX in a separate VS Code profile using **Extensions → … → Install from VSIX…**.
2. Open a trusted test project, verify Review, native diffs, CodeLens block actions, next/previous navigation, History and the usage dashboard. Connect an authenticated CLI to check live chat.
3. Return to [publisher management](https://marketplace.visualstudio.com/manage/publishers/), select your publisher and choose **New extension → Visual Studio Code**.
4. Upload the `.vsix`, review the listing and complete submission. For later releases, update the existing extension with a higher version.

Marketplace performs its own validation. A successful local package build does not mean the listing has been accepted or published.

## Why there are two build paths

`npm run dev` / `npm run package` retain experimental editor controls for local development. They must not be uploaded to Marketplace.

`npm run package:marketplace` stages a stable manifest, removes proposed API declarations and experimental menu locations, defaults review actions to CodeLens, and uses editor-title navigation plus the status-bar file picker. It includes runtime bundles, product assets, docs and license notices, writes a SHA-256 checksum, and never installs or publishes the package.

Reference: [VS Code's proposed API restrictions](https://code.visualstudio.com/api/advanced-topics/using-proposed-api).
