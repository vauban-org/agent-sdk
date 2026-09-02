/**
 * Bundle size sanity check — ensures no ASN.1 / PKCS#7 / crypto-js
 * packages were added as core dependencies (R8-B1).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const pkgPath = resolve(__dirname, "../package.json");

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const pkg: PackageJson = JSON.parse(readFileSync(pkgPath, "utf-8"));
const allDeps = {
  ...pkg.dependencies,
  ...pkg.devDependencies,
};

describe("proof — bundle size sanity (R8-B1)", () => {
  const forbiddenPackages = [
    "asn1",
    "asn1js",
    "pkcs7",
    "pkijs",
    "crypto-js",
    "node-forge",
    "elliptic",
    "secp256k1",
    "bn.js",
  ];

  for (const pkg of forbiddenPackages) {
    it(`does not depend on "${pkg}"`, () => {
      expect(allDeps[pkg]).toBeUndefined();
    });
  }

  it("uses only Web Crypto API (no new crypto deps added)", () => {
    const cryptoDeps = Object.keys(allDeps).filter(
      (k) =>
        k.includes("crypto") &&
        k !== "node:crypto" &&
        k !== "web-crypto" &&
        // These are known legitimate non-ASN.1 crypto deps if present
        !k.startsWith("@noble/"),
    );
    // The only acceptable crypto-adjacent dep is json-canonicalize (not crypto)
    const suspiciousDeps = cryptoDeps.filter((k) => k !== "json-canonicalize");
    expect(suspiciousDeps).toEqual([]);
  });
});
