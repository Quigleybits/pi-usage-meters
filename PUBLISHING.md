# Publishing

Releases publish from `.github/workflows/publish.yml` through npm Trusted Publishing. GitHub Actions exchanges its OIDC identity for a short-lived npm credential; this repository stores no npm publish token.

## Trust configuration

The npm package is configured with this Trusted Publisher:

- provider: GitHub Actions
- owner: `Quigleybits`
- repository: `pi-usage-meters`
- workflow: `publish.yml`
- environment: `npm`
- allowed action: `npm publish`

Package publishing access is set to **Require two-factor authentication and disallow tokens**. The GitHub `npm` environment contains no secrets.

The workflow grants only `contents: read` and `id-token: write`, checks out the release tag, verifies that the tag matches `package.json`, runs the test and syntax suites, and publishes with provenance.

## Release checklist

1. Update the version in `package.json` and make the intended release changes.

2. Verify the candidate locally:

   ```bash
   npm test
   npm run check
   npm publish --dry-run --json
   git diff --check
   git status --short
   ```

3. Commit and push the release candidate, then wait for CI to pass on Node 20 and Node 24:

   ```bash
   git push origin main
   gh run list --repo Quigleybits/pi-usage-meters --workflow CI --branch main --limit 1
   ```

4. Create a GitHub release whose tag exactly matches `v<package.json version>`:

   ```bash
   gh release create v0.1.1 \
     --repo Quigleybits/pi-usage-meters \
     --target main \
     --title "v0.1.1" \
     --generate-notes
   ```

5. Watch the release-triggered workflow:

   ```bash
   gh run list --repo Quigleybits/pi-usage-meters --workflow "Publish to npm" --limit 1
   gh run watch <run-id> --repo Quigleybits/pi-usage-meters --exit-status
   ```

6. Verify the immutable registry artifact and provenance:

   ```bash
   npm view pi-usage-meters@0.1.1 \
     name version dist.integrity dist.shasum dist.attestations repository.url \
     --json
   npm pack pi-usage-meters@0.1.1 --dry-run --json
   ```

7. Confirm the public surfaces:

   - `https://www.npmjs.com/package/pi-usage-meters`
   - `https://pi.dev/packages/pi-usage-meters`
   - `https://github.com/Quigleybits/pi-usage-meters/releases`

Search and recent-package catalogs are asynchronous. A live npm version and direct pi.dev package page are authoritative; do not republish because a search index is delayed.

### Note — v0.1.0 npm search-index lag (2026-07-27)

`pi-usage-meters@0.1.0` (published 2026-07-26 19:39 UTC) is live on the registry and installable, but after 24h+ it is still absent from npm's search index (`https://registry.npmjs.org/-/v1/search`) — which is exactly what pi.dev/packages queries (`?text=keywords:pi-package&size=250`, client-side). No npm incident is open; recently *updated* pi packages index within minutes, so this looks like npm's slow screening path for brand-new packages.

Decision: wait 72h from publish (until **2026-07-29 ~19:40 UTC**). If still unindexed, release the next version carrying the pending 1.1 additions — a real release, not an empty index-kick republish, consistent with the rule above. Check with:

```bash
curl "https://registry.npmjs.org/-/v1/search?text=pi-usage-meters"
```

## Failure recovery

Inspect only the failed workflow steps:

```bash
gh run view <run-id> \
  --repo Quigleybits/pi-usage-meters \
  --log-failed
```

If npm does not contain the version, fix the cause and rerun the failed workflow. Do not create another release or move the published tag. If npm already contains the version, never retry that version; investigate registry state and prepare a new semver version if a correction is required.

## Security invariants

- Never add an npm token to GitHub Secrets, repository files, shell history, or workflow environment variables.
- Keep `id-token: write` limited to the publish workflow.
- Keep actions pinned to immutable commit SHAs.
- Keep the npm repository URL and GitHub repository identity exact and case-correct for provenance.
- Keep package publishing access set to disallow traditional tokens.
- Review the packed file list before every release.
