# Release guide

Glad publishes both standalone binaries and npm packages from the same tag.

## Package layout

- `glad-web`: small Node launcher
- `glad-web-linux-x64`
- `glad-web-linux-arm64`
- `glad-web-darwin-x64`
- `glad-web-darwin-arm64`
- `glad-web-win32-x64`

The launcher resolves the matching platform package and forwards arguments, stdio, signals and the child exit code. Platform packages also depend on the matching native ccusage engine.

## First publication

New platform package names must be bootstrapped once:

1. Add a granular npm automation token as the `NPM_TOKEN` GitHub secret.
2. Push the first release tag so the platform packages are created.
3. Configure `.github/workflows/release.yml` as the npm Trusted Publisher for every package.
4. Verify an OIDC release.
5. Remove `NPM_TOKEN` after all packages publish through OIDC.

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

## Tagging

Update `package.json` and the changelog, run all checks, then create a semantic version tag:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

Do not run `npm publish` from the private repository-root package. The release workflow publishes only staged packages under `npm/`.
