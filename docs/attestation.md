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
  ML_DSA44_CONTEXT, // FIPS 204 `ctx` for ML-DSA-44 certs — see below
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
  | "missing_signature"       // cert.signature field absent
  | "wrong_alg"               // alg !== "Ed25519" && alg !== "ML-DSA-44"
  | "hash_mismatch"           // embedded cert_hash_felt252 != recomputed
  | "kid_mismatch"            // expectedKid set and does not match
  | "pubkey_unresolvable"     // key malformed, wrong length, or not Ed25519
  | "signature_invalid"       // signature verify returns false
  | "malformed_signature"     // signature.value is not valid base64 / wrong length
  | "pq_verifier_unavailable"; // ML-DSA-44 cert, but @noble/post-quantum is not installed

interface CertVerifyOptions {
  expectedPublicKey?: KeyObject;               // Ed25519: Node.js KeyObject (bypass embedded SPKI)
  expectedMlDsa44PublicKey?: Uint8Array | Buffer; // ML-DSA-44: raw 1312-byte key (bypass embedded pubkey_b64)
  expectedKid?: string;                        // pin to a specific key ID — applies to both algorithms
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

Implements draft-vauban-skill-attestation-00 §5. Seven sequential checks (Ed25519 v2 path) — the first failure stops the chain:

| Step | Check | Failure reason |
|------|-------|----------------|
| 1 | `cert.signature` field is present | `missing_signature` |
| 2 | `signature.alg === "Ed25519"` (or `"ML-DSA-44"` — see below) | `wrong_alg` |
| 3 | Strip `signature`, JCS-canonicalize (RFC 8785 subset: sorted keys, `-0 → 0`), SHA-256 first 31 bytes → felt252, Poseidon(`[0x1, sha_felt, CERT_MARKER_FELT]`) — compare with `signature.cert_hash_felt252` | `hash_mismatch` |
| 4 | If `opts.expectedKid` set, compare with `signature.kid` | `kid_mismatch` |
| 5 | Resolve public key: `opts.expectedPublicKey` if provided, else `publicKeyFromSpkiB64(signature.pubkey_spki_b64)` | `pubkey_unresolvable` |
| 6 | Decode `signature.value` from base64, assert 64 bytes | `malformed_signature` |
| 7 | Ed25519 verify: `crypto.verify(null, felt252Bytes(recomputed), pubkey, sigBytes)` | `signature_invalid` |

**`CERT_MARKER_FELT`** is the domain separator — UTF-8 `"run_cert"` encoded as a felt252 (right-aligned, zero-padded). It prevents cross-context signature reuse: a signature over a different cert type cannot satisfy the Poseidon preimage.

ML-DSA-44 certs (`signature.alg === "ML-DSA-44"`) follow the same steps 1, 3 and 4, then diverge at steps 5–7 — see the dedicated section below.

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

## ML-DSA-44 certificates (D-K, 2026-09-26)

**Decision D-K (founder, 2026-09-26):** Run Certificates (`SignedRunProofCertificate`) must be signable in ML-DSA-44 (FIPS 204) before any non-repudiation claim is sold. The signer lives in **command-center**, outside this repository — this module (`agent-sdk`) only holds the standalone, dependency-optional **verifier**.

### Format

`signature.alg: "ML-DSA-44"` selects this path. The payload:

```typescript
interface SignaturePayload {
  alg: "ML-DSA-44";
  kid: string;                 // key id (matches CC server's key registry)
  value: string;                // ML-DSA-44 signature, base64 — 2420 bytes decoded
  pubkey_b64: string;            // raw ML-DSA-44 public key, base64 — 1312 bytes decoded
  cert_hash_felt252: string;     // same Poseidon felt252 as Ed25519 v2 (see pipeline above)
  signed_at: string;
}
```

`value` and `pubkey_b64` are the FIPS 204 ML-DSA-44 fixed sizes: a signature decodes to exactly **2420 bytes**, a public key to exactly **1312 bytes**. Either length being off returns `malformed_signature` (signature) or `pubkey_unresolvable` (key) — never a partial or best-effort check.

**Why `pubkey_b64` and not `pubkey_spki_b64`:** SPKI-encapsulating an ML-DSA-44 key would need the ML-DSA-44 AlgorithmIdentifier OID `2.16.840.1.101.3.4.3.17`, which `node:crypto` does not understand (Node has no native ML-DSA support — verification runs entirely through `@noble/post-quantum` on raw key bytes). Wrapping the key in DER/SPKI would add ASN.1 machinery for no benefit, since nothing in this verifier ever hands the key to `node:crypto`. `pubkey_spki_b64` therefore stays Ed25519-only; ML-DSA-44 carries its public key raw, in its own field. A future signer emitting SPKI-wrapped ML-DSA-44 keys under that OID could be accommodated by extending `pubkey_b64` parsing without breaking existing Ed25519 certs, but is not implemented here.

### Hashing pipeline (unchanged from Ed25519 v2)

Same as the table above: strip `signature`, JCS-canonicalize, SHA-256 → first 31 bytes → felt252, Poseidon(`[0x1, sha_felt, CERT_MARKER_FELT]`) → `cert_hash_felt252`. ML-DSA-44 signs the same 32-byte felt252 projection that Ed25519 v2 signs — only the signature algorithm and context differ.

### FIPS 204 context

ML-DSA-44 (FIPS 204) signatures carry an application-defined `ctx` byte string, up to 255 bytes, that binds a signature to a particular usage domain (distinct from `CERT_MARKER_FELT`, which is baked into the *hashed message*; `ctx` is a separate FIPS 204 mechanism, checked by the algorithm itself). This module fixes it to:

```typescript
export const ML_DSA44_CONTEXT: Uint8Array = new TextEncoder().encode("vauban-run-cert-v1");
```

The signer (command-center) **must** sign with this exact context. A cert signed under any other context — or under no context — fails verification with `signature_invalid` (FIPS 204 context mismatch is indistinguishable, at this layer, from a bad signature). The `-v1` suffix is deliberate: a future ML-DSA-44 cert format change gets its own context string rather than reusing this one, so old and new formats can never be replayed against each other even though both would otherwise hash to the same felt252 message.

### Verification

```typescript
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";

ml_dsa44.verify(sigBytes, msgBytes, pubkeyBytes, { context: ML_DSA44_CONTEXT });
```

`@noble/post-quantum` is loaded **lazily** (via `node:module`'s `createRequire`, synchronously, cached after first load — the same pattern `metrics/create-agent-metrics.ts` uses for `prom-client`) and is an **optional peer dependency** (`peerDependenciesMeta["@noble/post-quantum"].optional === true`):

- An Ed25519 certificate verifies exactly as before — `@noble/post-quantum` is never touched, installed or not.
- An ML-DSA-44 certificate, when the dependency **is** installed, verifies normally.
- An ML-DSA-44 certificate, when the dependency is **absent** (or fails to load for any other reason), returns `{ valid: false, reason: "pq_verifier_unavailable" }`. This is a hard refusal — the certificate is never treated as valid, and the failure is never silently swallowed into a different reason. Consumers that need to verify ML-DSA-44 certificates must add `@noble/post-quantum` themselves.

### Pinning

`opts.expectedKid` pins the key id for both algorithms identically. Key-material pinning uses one field per algorithm, since the two do not share a key type:

- Ed25519: `opts.expectedPublicKey` (a Node.js `KeyObject`), as before.
- ML-DSA-44: `opts.expectedMlDsa44PublicKey` (raw `Uint8Array | Buffer`, 1312 bytes), which bypasses the embedded `pubkey_b64` exactly as `expectedPublicKey` bypasses `pubkey_spki_b64`.

The warning below — never trust an embedded public key without pinning — applies identically to `pubkey_b64`.

### command-center TODO (outside this repo)

This repository ships the verifier only. For ML-DSA-44 Run Certificates to exist at all, **command-center**'s signer must:

1. Generate/hold ML-DSA-44 keypairs (1312-byte public / 2560-byte secret key, FIPS 204) and register their `kid`s.
2. Sign the same felt252 message this module recomputes (JCS → SHA-256[:31] → Poseidon → felt252), under the fixed context `"vauban-run-cert-v1"`.
3. Emit `signature.alg: "ML-DSA-44"`, `pubkey_b64` (raw, base64), `value` (base64 2420-byte signature), alongside the existing `kid` / `cert_hash_felt252` / `signed_at` fields.
4. Depend on `@noble/post-quantum` (or another audited FIPS 204 implementation) directly, since command-center is the signing side and cannot treat it as optional.

---

## Security considerations

!!! warning "Treat embedded `pubkey_spki_b64` / `pubkey_b64` as a key-discovery hint, not a security guarantee"
    The `pubkey_spki_b64` (Ed25519) / `pubkey_b64` (ML-DSA-44) field in `signature` helps resolve the signing key for display and debugging, but an attacker can substitute it with their own public key and produce a valid self-consistent signature — for either algorithm.

    For production use, always pin to a known public key — `opts.expectedPublicKey` (Ed25519) or `opts.expectedMlDsa44PublicKey` (ML-DSA-44) — loaded from a trusted source such as an environment variable, K8s secret, or a JWKS registry keyed on `signature.kid`. Never accept a certificate as authoritative based solely on its embedded public key, regardless of algorithm.

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
