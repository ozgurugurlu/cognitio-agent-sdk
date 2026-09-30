# Publishing Cognitio Agent SDK

The public npm package is `cognitio-agent-sdk`. It depends on eight platform packages at the same exact SDK version. Publish those first and the main SDK last, using the canonical script below. The runtime's own version is tracked separately in `runtimeVersion`.

Use a machine with Node.js 22+, the pinned Bun version, git, tar, and npm access. Registry publication requires an npm account authorized for all nine package names. npm requires [two-factor authentication or a granular access token with bypass 2FA enabled](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/) to create and publish packages. Run `npm login` interactively when `npm whoami` reports `ENEEDAUTH`; a successful login alone does not satisfy publish-time 2FA. Never put tokens in source files.

## 1. Validate the release candidate

From the repository root:

```sh
bun install --frozen-lockfile
bun run --cwd packages/agent-sdk check:openapi
bun run --cwd packages/agent-sdk check:client
bun run --cwd packages/agent-sdk check:models
bun run --cwd packages/sdk/js check:client
bun run --cwd packages/agent-sdk typecheck
bun run --cwd packages/runtime typecheck
bun run --cwd packages/sdk/js typecheck
bun run --cwd packages/agent-sdk test
bun run --cwd packages/runtime test:sharded
bun run --cwd packages/sdk/js test
bun run --cwd packages/docs check
bun run --cwd packages/docs validate
bun run --cwd packages/agent-sdk test:examples
```

The drift checks come before any generation or workspace build. A build must not repair a stale committed specification and thereby hide the drift. Review the changelog, public API, installation instructions, migration guide, version, and attribution files. Set the SDK version in `packages/agent-sdk/package.json`; platform versions are derived from it. Update the runtime version marker whenever runtime behavior changes.

Commit the reviewed source before building release binaries. Internal notes may stay in the private GitLab repository. Keep them out of the public export described below.

## 2. Build immutable artifacts

```sh
bun run --cwd packages/agent-sdk build:binaries
bun run --cwd packages/agent-sdk pack:release
bun run --cwd packages/agent-sdk verify:release
bun run --cwd packages/agent-sdk release:check
```

`build:binaries` compiles all supported targets with the pinned runtime version. Artifacts land in `packages/agent-sdk/dist-binaries`; tarballs land in `packages/agent-sdk/dist-pack`. `manifest.json` records the source commit, clean-source status, compilation status, SDK/runtime versions, and binary hashes and sizes. LICENSE and NOTICE are included in every package.

`release:check` is a strict dry run: missing platforms, stale source, dirty release inputs, restaged `--skip-build` artifacts, missing attribution, mismatched checksums, incompatible host binaries, or failed packed-install checks fail the command. The default script invocation is also a dry run. No registry package is uploaded during these commands.

Local verification executes only the host binary. Cross-building and hashing another platform does not prove that binary runs there. Run the GitHub matrix on macOS, Linux, and Windows; validate additional architectures and musl in matching runners before claiming execution coverage for all eight targets. Record which checks actually ran.

Rebuild after changing the release source or committing again. Do not manually edit staged manifests or copy old binaries into a new release.

GitLab provides an optional `release_dry_run` job after the normal verification stage. Run it manually for a release candidate, or add `COGNITIO_RELEASE_DRY_RUN=1` to a pipeline schedule targeting the release branch. Other scheduled pipelines omit this expensive job. It compiles all eight targets, packs them, and runs `release:check`; it neither logs in to npm nor uploads packages. A scheduled dry-run failure fails the pipeline; the manual job is optional, so inspect its own result before publishing.

The job uses the existing Node 22/Bun runner setup and requests a two-hour timeout; the runner must permit that timeout and have sufficient disk space for workspace dependencies plus all eight binaries and tarballs. It retains the small binary provenance manifest for 14 days, with validation output in the job log. Large release payloads are not uploaded as GitLab artifacts. This cross-build still executes only the runner's host binary.

## 3. Publish public packages

```sh
npm whoami --registry=https://registry.npmjs.org/
bun run --cwd packages/agent-sdk release:publish
```

Run the publish command directly in an interactive terminal, preserving stdin and stdout; do not pipe or redirect its output. npm may require browser authentication or a one-time code while publishing. If npm rejects the first upload with `E403` and a two-factor authentication requirement, check account security settings and [configure 2FA](https://docs.npmjs.com/configuring-two-factor-authentication/) before retrying. Credentials, recovery codes, and one-time codes belong in npm’s own authentication flow.

This command performs strict preflight and installed-package verification again, checks authentication, then publishes the platform packages followed by `cognitio-agent-sdk` with `--access public`. Stable versions use `latest`; prerelease versions use their prerelease label. The committed package has a `prepublishOnly` guard: a raw `npm publish` bypasses staging and is unsupported.

If an upload is interrupted, rerun the same command against the unchanged artifacts and source commit. Existing exact versions are skipped only when their registry integrity matches the staged tarball. All nine names are checked for collisions before the first upload. Investigate registry errors before retrying; do not change artifact contents for a version already published. Any change to published package contents, including bundled documentation, needs a new version.

Verify the actual registry installation from a fresh directory after publication. The example uses the published `2.0.1`; use the exact version being verified for later releases:

```sh
mkdir cognitio-registry-smoke
cd cognitio-registry-smoke
npm init -y
npm install cognitio-agent-sdk@2.0.1
node --input-type=module -e 'import { createAgentClient } from "cognitio-agent-sdk"; const client = await createAgentClient(); try { const session = await client.sessions.create({}); console.log(session.id); await session.close() } finally { await client.close() }'
```

Repeat the documented quickstart with an explicitly supplied provider credential to verify a real model request. The local deterministic example harness does not establish that your provider account has model access.

## 4. Push the private development repository to GitLab

This step applies only to the original private development checkout, where `origin` points to GitLab. The clean GitHub checkout uses `origin` for GitHub. From the private checkout, push the reviewed branch using its actual branch name:

```sh
git remote get-url origin
git push -u origin HEAD
```

Do not push the private development repository's history to a public remote: earlier commits contain internal planning and local reference sources. Adding `.gitignore` entries cannot erase them from history.

## 5. Create a clean public GitHub repository

Export only the committed release tree to a new directory:

```sh
bun run --cwd packages/agent-sdk export:source --out=/tmp/cognitio-agent-sdk-public
```

The destination must not already exist. The export contains no `.git` history and removes internal `docs`, research/insight/spec directories, local agent instructions and configuration, reference source checkouts, deploy-only infrastructure, and upstream automation. Public documentation remains under `packages/docs`. `SOURCE-MANIFEST.json` lists the exported files and records their source commit. Uncommitted and untracked work is never exported.

The clean GitHub repository is [ozgurugurlu/cognitio-agent-sdk](https://github.com/ozgurugurlu/cognitio-agent-sdk), on `main`. The following initialization commands are for a new empty destination only.

Inspect the snapshot and rerun the installation and validation commands from step 1 inside it. Preserve the GitHub `repository` metadata when importing a private release snapshot. Record any public-checkout adaptations in `SOURCE-MANIFEST.json`. Then initialize a fresh repository. Before committing, confirm the intended public author identity with `git var GIT_AUTHOR_IDENT`; set a different email with `git config user.email "your-public-email@example.com"` in this checkout if needed:

```sh
cd /tmp/cognitio-agent-sdk-public
git init -b main
git var GIT_AUTHOR_IDENT
git add .
git commit -m "Release Cognitio Agent SDK v2"
```

For a new empty destination, add its GitHub URL as `origin` and push this fresh `main` branch. Do not add the original private checkout as a remote, copy its `.git` directory, or merge its history into this repository. Future public updates should copy reviewed release snapshots into the public checkout and create new public commits, preserving the documented public-checkout adaptations and validating the result.

## 6. Deploy documentation

The documentation site is [cognitio-agent.mintlify.site](https://cognitio-agent.mintlify.site). Its source is this repository's `main` branch, under `packages/docs`.

Preview the existing documentation from the repository root with Node.js 22+ and the pinned Bun version:

```sh
bun install --frozen-lockfile
bun run --cwd packages/docs dev
```

Open http://localhost:3333. The preview watches local edits; stop it with Ctrl+C. The committed API reference is ready to preview. To validate content changes, build the SDK declarations, then run the docs checks:

```sh
bun run --cwd packages/agent-sdk build
bun run --cwd packages/docs check
bun run --cwd packages/docs validate
```

To deploy the prepared site:

1. Create a project at [Mintlify](https://mintlify.com/start) and connect the existing GitHub repository.
2. From the Mintlify dashboard's **Git Settings**, install the Mintlify GitHub App. Choose **Only select repositories** and grant access to `ozgurugurlu/cognitio-agent-sdk`.
3. Select owner `ozgurugurlu`, repository `cognitio-agent-sdk`, and branch `main`.
4. Enable **docs.json is in a subdirectory**, enter `/packages/docs` without a trailing slash, and save. The configuration file is `packages/docs/docs.json`.
5. Check the deployment in the dashboard and open the site URL shown in **Overview**. Future pushes to the configured branch trigger automatic deployments.

See Mintlify's [GitHub integration](https://www.mintlify.com/docs/deploy/github) and [monorepo setup](https://www.mintlify.com/docs/deploy/monorepo) guides. The package homepage points to the documentation site. Manage GitHub integration and domain settings in the Mintlify project. Documentation files and generated references are committed; hosting does not require regenerating the SDK during deployment.

## 7. Maintain models and provider dependencies

The public repository includes a monthly `cognitio-maintenance.yml` workflow. Enable **Allow GitHub Actions to create and approve pull requests** in repository Actions settings so it can open reviewable update PRs. Each update validates the model snapshot or provider package pins and runs relevant checks before opening a PR; no update is merged or published automatically. The model catalog is pinned in source for ordinary builds. Review upstream model metadata and provider changes before merging, then run the normal release gates.
