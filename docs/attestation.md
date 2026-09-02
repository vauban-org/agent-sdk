---
classification: C0
product: command-center
status: active
owner: founder
review_due: 2026-12-12
source_repo: command-center
---
# Run Certificate Verification (Standalone)

**Module:** `@vauban-org/agent-sdk/proof/cert-verify` · **Since:** CC v3.1 sprint-562 (Livrable D, 2026-05-14)

The standalone verifier in `src/proof/cert-verify.ts` verifies a `SignedRunProofCertificate` without any database or network dependency. It is the verification counterpart to the CC server's signing surface (`src/proof/ed25519-signer.ts`) and implements [draft-vauban-skill-attestation-00 §5](https://datatracker.ietf.org/doc/draft-vauban-skill-attestation/).

Suitable for: CI pipelines, third-party integrators, audits, and the `preste attest verify` CLI command.

## Quick start

```typescript
import { verifyRunCertificate } from "@vauban-org/agent-sdk/proof/cert-verify";
import { readFileSync } from "node:fs";

const cert = JSON.parse(readFileSync("cert.json", "utf-8"));

const result = verifyRunCertificate(cert);

if (!result.valid) {
  console.error(`Verification failed: ${result.reason} — ${result.details}`);
  process.exit(1);
}

console.log("Certificate valid. hash:", result.recomputed_cert_hash_felt252);
```

---

## Imports

```typescript
import {
  verifyRunCertificate,
  computeCertHashFelt252,
  publicKeyFromSpkiB64,
  CERT_MARKER_FELT,
} from "@vauban-org/agent-sdk/proof/cert-verify";

import type {
  CertVerifyResult,
  CertVerifyFailReason,
  CertVerifyOptions,
  SignedRunProofCertificateLike,
  SignaturePayload,
} from "@vauban-org/agent-sdk/proof/cert-verify";
```

---

## Types

```typescript
interface CertVerifyResult {
  valid: boolean;
  reason?: CertVerifyFailReason;          // only when valid === false
  details?: string;                       // human-readable context
  recomputed_cert_hash_felt252: string;   // always present — useful for debug
}

type CertVerifyFailReason =
  | "missing_signature"    // cert.signature field absent
  | "wrong_alg"            // alg !== "Ed25519"
  | "hash_mismatch"        // embedded cert_hash_felt252 != recomputed
  | "kid_mismatch"         // expectedKid set and does not match
  | "pubkey_unresolvable"  // SPKI base64 malformed or not Ed25519
  | "signature_invalid"    // Ed25519 verify returns false
  | "malformed_signature"; // signature.value is not valid base64 / wrong length

interface CertVerifyOptions {
  expectedPublicKey?: KeyObject;  // Node.js KeyObject (bypass embedded SPKI)
  expectedKid?: string;           // pin to a specific key ID
}
```

---

## `verifyRunCertificate(cert, opts?)`

```typescript
function verifyRunCertificate(
  cert: SignedRunProofCertificateLike,
  opts?: CertVerifyOptions
): CertVerifyResult
```

Returns synchronously — all crypto is Node.js built-in `node:crypto`. Never throws on verification failure; only throws when `cert` is not a plain object.

`recomputed_cert_hash_felt252` is always returned regardless of outcome — use it to debug `hash_mismatch` failures without a separate call.

### Basic verification

```typescript
const result = verifyRunCertificate(cert);
if (!result.valid) {
  console.error(`Invalid: ${result.reason} — ${result.details}`);
}
```

### Pin to a known public key (recommended for production)

```typescript
import { publicKeyFromSpkiB64, verifyRunCertificate } from "@vauban-org/agent-sdk/proof/cert-verify";

const pubkey = publicKeyFromSpkiB64(process.env["CC_ATTEST_PUBKEY_SPKI_B64"]!);

const result = verifyRunCertificate(cert, { expectedPublicKey: pubkey });
```

`publicKeyFromSpkiB64` throws if the base64 is malformed or the key is not Ed25519. Call it once at startup and cache the `KeyObject`.

### Pin to a key ID

```typescript
const result = verifyRunCertificate(cert, {
  expectedKid: "cc-attest-2026-05",
});
// → reason: "kid_mismatch" if cert was signed with a different key
```

### CI pipeline — exit code gate

```typescript
import { verifyRunCertificate } from "@vauban-org/agent-sdk/proof/cert-verify";
import { readFileSync } from "node:fs";

const cert = JSON.parse(readFileSync("cert.json", "utf-8"));
const { valid, reason, recomputed_cert_hash_felt252 } = verifyRunCertificate(cert);

console.log(`hash: ${recomputed_cert_hash_felt252}`);
process.exit(valid ? 0 : 1);
```

---

## Verification algorithm

Implements draft-vauban-skill-attestation-00 §5. Seven sequential checks — the first failure stops the chain:

| Step | Check | Failure reason |
|------|-------|----------------|
| 1 | `cert.signature` field is present | `missing_signature` |
| 2 | `signature.alg === "Ed25519"` | `wrong_alg` |
| 3 | Strip `signature`, JCS-canonicalize (RFC 8785 subset: sorted keys, `-0 → 0`), SHA-256 first 31 bytes → felt252, Poseidon(`[0x1, sha_felt, CERT_MARKER_FELT]`) — compare with `signature.cert_hash_felt252` | `hash_mismatch` |
| 4 | If `opts.expectedKid` set, compare with `signature.kid` | `kid_mismatch` |
| 5 | Resolve public key: `opts.expectedPublicKey` if provided, else `publicKeyFromSpkiB64(signature.pubkey_spki_b64)` | `pubkey_unresolvable` |
| 6 | Decode `signature.value` from base64, assert 64 bytes | `malformed_signature` |
| 7 | Ed25519 verify: `crypto.verify(null, felt252Bytes(recomputed), pubkey, sigBytes)` | `signature_invalid` |

**`CERT_MARKER_FELT`** is the domain separator — UTF-8 `"run_cert"` encoded as a felt252 (right-aligned, zero-padded). It prevents cross-context signature reuse: a signature over a different cert type cannot satisfy the Poseidon preimage.

---

## `computeCertHashFelt252(cert)`

Standalone hash computation — useful for debugging `hash_mismatch` failures.

```typescript
import { computeCertHashFelt252 } from "@vauban-org/agent-sdk/proof/cert-verify";

const expected = cert.signature?.cert_hash_felt252;
const recomputed = computeCertHashFelt252(cert);

if (expected !== recomputed) {
  console.error("Hash mismatch:");
  console.error("  embedded  :", expected);
  console.error("  recomputed:", recomputed);
}
```

`computeCertHashFelt252` strips the embedded `signature` field before hashing — calling it on a signed cert and on the pre-signature cert produces the same result.

---

## Security considerations

!!! warning "Treat embedded `pubkey_spki_b64` as a key-discovery hint, not a security guarantee"
    The `pubkey_spki_b64` field in `signature` helps resolve the signing key for display and debugging, but an attacker can substitute it with their own public key and produce a valid self-consistent signature.

    For production use, always pin to a known public key via `opts.expectedPublicKey` (loaded from a trusted source such as an environment variable, K8s secret, or a JWKS registry keyed on `signature.kid`). Never accept a certificate as authoritative based solely on its embedded public key.

---

## `preste attest verify` CLI

The standalone verifier is the engine behind the CLI command:

```bash
preste attest verify cert.json
# Exit 0: certificate valid
# Exit 1: verification failed — reason printed to stderr

preste attest verify cert.json --kid cc-attest-2026-05
# Adds kid pinning

preste attest verify cert.json --pubkey "$CC_ATTEST_PUBKEY_SPKI_B64"
# Pins to an explicit SPKI base64 public key
```

The CLI sets `process.exitCode` to `1` on failure so it composes naturally with `&&` in shell scripts and CI steps.
