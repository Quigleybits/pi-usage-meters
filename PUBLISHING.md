# Publishing

Releases publish from `.github/workflows/publish.yml`, never from a developer shell. The workflow runs tests and syntax checks, verifies that the release tag matches `package.json`, and publishes with npm provenance.

## Bootstrap release (`0.1.0`)

The npm package must exist before npm Trusted Publishing can be configured. Bootstrap the first release with a short-lived granular access token, then revoke it.

1. Confirm the package name is still available and the committed tree is clean:

   ```bash
   npm view pi-usage-meters version
   git status --short
   npm test
   npm run check
   npm publish --dry-run
   ```

   Name availability returns npm `E404` until the first successful publication.

2. On npmjs.com, create a granular access token with:

   - shortest practical expiry
   - read/write package access
   - no organization access
   - IP restriction if practical
   - **Bypass 2FA** enabled

   Never paste the token into chat, a command argument, or a tracked file.

3. Create the protected GitHub environment and send the token to GitHub Secrets through concealed input:

   ```bash
   gh api --method PUT repos/Quigleybits/pi-usage-meters/environments/npm
   read -rsp "npm token: " NPM_TOKEN; echo
   printf '%s' "$NPM_TOKEN" | gh secret set NPM_TOKEN --env npm --repo Quigleybits/pi-usage-meters
   unset NPM_TOKEN
   ```

4. Create the release. Publishing the release triggers the workflow:

   ```bash
   gh release create v0.1.0 --repo Quigleybits/pi-usage-meters --target main --title "v0.1.0" --generate-notes
   gh run watch --repo Quigleybits/pi-usage-meters
   ```

5. Verify the registry artifact:

   ```bash
   npm view pi-usage-meters name version dist.integrity repository.url
   npm pack pi-usage-meters@0.1.0 --dry-run
   ```

6. Immediately delete the GitHub secret and revoke the granular token on npmjs.com:

   ```bash
   gh secret delete NPM_TOKEN --env npm --repo Quigleybits/pi-usage-meters
   ```

## Configure trusted publishing

After `0.1.0` exists, configure npm Trusted Publishing for:

- provider: GitHub Actions
- owner: `Quigleybits`
- repository: `pi-usage-meters`
- workflow: `publish.yml`
- environment: `npm`
- allowed action: `npm publish`

Then set package publishing access to **Require two-factor authentication and disallow tokens**. The unchanged workflow will use npm's short-lived OIDC credentials and generate provenance automatically.

## Later releases

1. Update `package.json` version and release notes.
2. Run `npm test`, `npm run check`, and `npm publish --dry-run`.
3. Commit and push the version change.
4. Create a matching `v<version>` GitHub release.
5. Watch the workflow and verify the npm artifact.
