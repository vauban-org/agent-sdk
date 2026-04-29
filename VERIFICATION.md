# Verifying @vauban-org/agent-sdk Supply-Chain Signatures

Every published tarball at GHCR (`https://npm.pkg.github.com`) has a
matching Sigstore bundle attached as a GitHub release asset at the
corresponding `sdk-v*` tag. The bundle certifies:

- **Who built it**: GitHub Actions workflow run URL, commit SHA.
- **From what source**: `git+https://github.com/seritalien/command-center@<commit>`.
- **With what OIDC identity**: `https://token.actions.githubusercontent.com`.

The signature is also recorded in the public Sigstore Rekor transparency
log (`https://rekor.sigstore.dev`), so verification succeeds even
offline from GitHub as long as Rekor is reachable.

---

## Install cosign

```bash
# macOS
brew install cosign

# Linux
curl -sL "https://github.com/sigstore/cosign/releases/latest/download/cosign-linux-amd64" \
  -o cosign && chmod +x cosign && sudo mv cosign /usr/local/bin/
```

## Download artifact + signature

```bash
# Pick the version you want to verify (example: 0.3.2).
VERSION="0.3.2"
PKG="vauban-org-agent-sdk-${VERSION}"

# Download from the GitHub release (public download of release assets
# does not require repo read permission).
gh release download "sdk-v${VERSION}" \
  --repo seritalien/command-center \
  --pattern "${PKG}.tgz" \
  --pattern "${PKG}.tgz.sigstore"
```

## Verify

```bash
cosign verify-blob \
  --bundle "${PKG}.tgz.sigstore" \
  --certificate-identity-regexp '.*seritalien/command-center.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "${PKG}.tgz"
```

Expected output: `Verified OK`.

## What the certificate attests

- `san_uri`: URL of the workflow run that signed the tarball.
- `issuer`: GitHub Actions OIDC provider.
- `build_config_digest`: commit SHA of `.github/workflows/sdk-publish.yml`
  at signing time.
- `source_repository`: `seritalien/command-center`.

## Verify the SBOM (CycloneDX)

Each release ships a `<name>.sbom.cdx.json` listing every transitive
dependency with version, hash, and license.

```bash
# Install the CycloneDX CLI (optional — Node alt: `npx @cyclonedx/cdxgen`)
brew install cyclonedx/cyclonedx/cyclonedx-cli

# Download
gh release download "sdk-v${VERSION}" \
  --repo seritalien/command-center \
  --pattern "${PKG}.sbom.cdx.json"

# Validate shape
cyclonedx validate --input-file "${PKG}.sbom.cdx.json" --fail-on-errors

# Inspect components
jq '.components | length' "${PKG}.sbom.cdx.json"
jq '.components[] | {name, version, purl}' "${PKG}.sbom.cdx.json" | head
```

## Verify the SLSA v1 build provenance

Each release ships a `<name>.provenance.intoto.json` (in-toto v1
statement, predicateType `https://slsa.dev/provenance/v1`) and a
matching `<name>.provenance.sigstore` bundle signed by the same OIDC
identity as the tarball.

```bash
gh release download "sdk-v${VERSION}" \
  --repo seritalien/command-center \
  --pattern "${PKG}.provenance.intoto.json" \
  --pattern "${PKG}.provenance.sigstore"

# Verify the attestation authenticates the tarball
cosign verify-blob-attestation \
  --bundle "${PKG}.provenance.sigstore" \
  --certificate-identity-regexp '.*seritalien/command-center.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --type slsaprovenance1 \
  "${PKG}.tgz"

# Inspect the predicate
jq '.predicate.buildDefinition.resolvedDependencies' "${PKG}.provenance.intoto.json"
jq '.predicate.runDetails.builder.id' "${PKG}.provenance.intoto.json"
```

## Attested packages

All seven @vauban-org/* packages follow the same pattern:

| Package | Release tag |
|---------|-------------|
| `@vauban-org/agent-sdk` | `sdk-v<version>` |
| `@vauban-org/agent-sources` | same |
| `@vauban-org/forecast-utils` | same |
| `@vauban-org/echo-agent` | same |
| `@vauban-org/forecaster` | same |
| `@vauban-org/market-radar` | same |
| `@vauban-org/narrator` | same |

Each tag release has one `.tgz` + one `.sigstore` file per package.

## Why not the GitHub Attestation API?

GitHub's native Attestation API (`gh attestation verify`) requires the
source repository to be either public or owned by a GitHub org. This
repo is user-owned and private, so the Attestation API rejects
persistence. The Sigstore signature itself is still produced and
recorded in Rekor — it just lives in the release assets instead of the
GitHub attestation store. Verification via `cosign verify-blob` is the
canonical Sigstore path and does not depend on GitHub's Attestation
API.

## Exit plan

If Sigstore/Rekor becomes unavailable, consumers can fall back to the
plain `sha256sum` of each tarball, cross-checked against the release's
`digest:` metadata in the GHCR package page. The supply-chain claim
weakens (no non-repudiable signature) but integrity remains provable.
