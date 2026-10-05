# Release guide

Glad publishes both standalone binaries and npm packages from the same tag.

## Package layout

- `glad-web`: small Node launcher
- `glad-web-linux-x64`
- `glad-web-linux-arm64`
- `glad-web-darwin-x64`
- `glad-web-darwin-arm64`
- `glad-web-windows-x64`

The launcher resolves the matching platform package and forwards arguments, stdio, signals and the child exit code. Platform packages also depend on the matching native ccusage engine.

## First publication

New platform package names must be bootstrapped once:

1. Add a short-lived granular npm automation token as the `NPM_TOKEN` GitHub secret.
2. Push the first release tag so the platform packages are created.
3. Configure `release.yml` as the npm Trusted Publisher for every package, with publish permission.
4. Remove the `NODE_AUTH_TOKEN` environment from the workflow and verify an OIDC release.
5. Delete the `NPM_TOKEN` secret and revoke the bootstrap token after all packages publish through OIDC.

Normal releases are tokenless. The workflow uses npm 11.16 or newer, a GitHub-hosted runner and `id-token: write`; npm exchanges the workflow identity for short-lived publishing credentials and generates provenance automatically.

The repository URL in every package manifest must exactly match `https://github.com/Next2012/Glad` for provenance generation.

## Release order

The workflow deliberately publishes in this order:

1. Build and smoke-test native artifacts.
2. Stage npm packages with one exact version.
3. Publish every platform package.
4. Publish `glad-web` last.
5. Publish the GitHub release and SHA-256 checksums.

Publishing the main package last prevents users from installing a version before its platform binary exists.

## Local package validation

Build artifacts into a temporary directory, then stage packages without modifying source templates:

```bash
node scripts/stage-npm-packages.js 1.2.3 /path/to/artifacts /tmp/glad-npm-stage
npm pack /tmp/glad-npm-stage/main --dry-run
for package in /tmp/glad-npm-stage/platforms/*; do
  npm pack "$package" --dry-run
done
```

Confirm that:

- the main package contains only the launcher, README and notices;
- each platform package contains one native binary and notices;
- versions are identical and exact in `optionalDependencies`;
- Unix binaries retain execute permission;
- the launcher works with directory-before-option syntax such as `glad . --port 3001`.

## Candidate validation and tagging

Freeze the version, changelog, dependencies, and source in a clean commit before building a candidate. The Release workflow uses pinned Go, Node, and npm versions and checks binary VCS identity. A `workflow_dispatch` build only produces candidate artifacts; it does not publish npm packages or create a GitHub release.

1. Push the candidate branch and dispatch **Release** with its exact version and `verify_approved=false`.
2. Download `release-assets` and `candidate-checksums` from that run. Validate those artifacts, including native builds and all six npm packages, and record the accepted run ID in `APPROVED_CANDIDATE_RUN_ID`.
3. Dispatch **Release** again on the same frozen commit with `verify_approved=true`. Wait for the entire run to succeed; this rebuild checks the complete asset set against the accepted candidate without publishing.
4. Download the fresh preflight artifacts. In a clean checkout of the same commit, run `scripts/release_gate.py check-tag` with the accepted checksums and the full required asset list.
5. Only after these checks succeed, create and push the formal `vX.Y.Z` tag. The tag workflow repeats the approved-byte comparison before npm or GitHub publication.

A source change invalidates candidate acceptance and requires a new candidate. Do not push the local version tag created inside a candidate checkout, and do not change approval metadata to bypass a failed check.

See [the full release gate procedure](../scripts/RELEASE_GATE.md) for the exact asset list and `check-tag` command. Local cross-compilation and `npm pack --dry-run` are useful preparation checks; they do not replace CI candidate acceptance.

Do not run `npm publish` from the private repository-root package. The release workflow publishes only approved staged package archives.
