# Publish AgentDock on VS Code Marketplace

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
4. Open the completed run and download **agent-dock-vsix-…** from **Artifacts**.
5. Extract the downloaded ZIP. The `.vsix` inside is the extension package; keep its `.sha256` file for verification.

Pushes to `main`/`master` and pull requests create **preview** artifacts. Use a manual run or a matching version tag for an upload artifact. For a tag release, bump `package.json` and `package-lock.json` first, then push a tag such as `v0.1.1`. The tag must match the manifest version. The configured publisher is `coolbirdv`; the repository variable can override it.

### Local PowerShell

```powershell
npm ci
npm run typecheck
npm test -- --maxWorkers=2 --testTimeout=15000
npm run package:marketplace -- --publisher coolbirdv --repository-url https://github.com/YOUR_ACCOUNT/YOUR_REPO
```

Output: `artifacts/agent-dock-VERSION.vsix`, its checksum, and `artifacts/marketplace-build.json`. The metadata records the actual publisher and staging folder. The source manifest remains unchanged.

Before creating a publisher, validate the build with:

```powershell
npm run package:marketplace -- --preview
```

This creates `agent-dock-VERSION-preview.vsix` with the local publisher. Rebuild with your real ID and repository URL before uploading. Renaming the file cannot change its embedded publisher.

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
