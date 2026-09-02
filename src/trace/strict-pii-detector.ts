/**
 * STRICT_PII_DETECTOR — ultra-conservative, opt-in PIIDetector.
 *
 * Detects:
 *   - Email addresses (RFC 5321 — local-part + domain + TLD ≥ 2 chars)
 *   - IBANs (ISO 13616 — country code + check digits mod-97 + BBAN)
 *
 * Intentionally NOT detecting:
 *   - Phone numbers: catastrophic false-positive rate on amounts and IDs.
 *   - SSN / NSS: locale-dependent patterns with high FP on numeric sequences.
 *
 * Activation:
 *   This detector is NEVER activated by defaultPolicy() (R8-I3).
 *   Opt in explicitly:
 *     { kind: 'redact', piiFields: ['email'], piiDetector: STRICT_PII_DETECTOR }
 *
 * @module trace/strict-pii-detector
 */

import type { PIIDetector } from "./policy.js";

// ─── Email (RFC 5321) ────────────────────────────────────────────────────────
//
// Local-part: printable ASCII except @, <, >, (, ), [, ], :, ;, \, ,, .
//   except that . is allowed when not leading, trailing, or consecutive.
// Domain: standard hostname labels (alphanum + hyphen, no leading/trailing hyphen).
// TLD: at least 2 alpha chars (no all-numeric TLDs accepted).
//
// We intentionally reject IP-literal domains ([1.2.3.4]) and quoted strings
// in the local part — they are valid RFC 5321 but extremely rare in practice
// and high false-positive risk.

const EMAIL_REGEX =
  /^[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;

function isEmail(value: string): boolean {
  return EMAIL_REGEX.test(value.trim());
}

// ─── IBAN (ISO 13616) ────────────────────────────────────────────────────────
//
// Structure: CC DD BBAN
//   CC = 2-letter ISO 3166-1 alpha-2 country code
//   DD = 2-digit check digits
//   BBAN = country-specific (alphanumeric, variable length)
// Total length: 15–34 characters (no spaces in canonical form).
//
// Checksum (mod-97-10):
//   1. Move CC + DD to the end.
//   2. Replace each letter with its decimal value (A=10, B=11, ..., Z=35).
//   3. Compute the resulting integer mod 97.
//   4. Valid IBAN → result === 1.
//
// Country codes: hardcoded list of all ISO 13616 registered countries (2026-04-30).
// We reject any 2-letter prefix NOT in this list to avoid false positives.

const IBAN_COUNTRY_CODES = new Set([
  "AD",
  "AE",
  "AL",
  "AT",
  "AZ",
  "BA",
  "BE",
  "BG",
  "BH",
  "BR",
  "BY",
  "CH",
  "CR",
  "CY",
  "CZ",
  "DE",
  "DK",
  "DO",
  "EE",
  "EG",
  "ES",
  "FI",
  "FK",
  "FO",
  "FR",
  "GB",
  "GE",
  "GI",
  "GL",
  "GR",
  "GT",
  "HR",
  "HU",
  "IE",
  "IL",
  "IQ",
  "IS",
  "IT",
  "JO",
  "KW",
  "KZ",
  "LB",
  "LC",
  "LI",
  "LT",
  "LU",
  "LV",
  "LY",
  "MC",
  "MD",
  "ME",
  "MK",
  "MN",
  "MR",
  "MT",
  "MU",
  "NI",
  "NL",
  "NO",
  "PK",
  "PL",
  "PS",
  "PT",
  "QA",
  "RO",
  "RS",
  "RU",
  "SA",
  "SC",
  "SD",
  "SE",
  "SI",
  "SK",
  "SM",
  "SO",
  "ST",
  "SV",
  "TL",
  "TN",
  "TR",
  "UA",
  "VA",
  "VG",
  "XK",
  "YE",
]);

/** Strip whitespace and uppercase for canonical form. */
function normaliseIban(raw: string): string {
  return raw.replace(/\s/g, "").toUpperCase();
}

/**
 * Compute mod-97 of a large numeric string represented as a string.
 * We process 9 digits at a time to avoid BigInt or floating-point overflow.
 */
function mod97(numericStr: string): number {
  let remainder = 0;
  for (let i = 0; i < numericStr.length; i += 9) {
    const chunk = String(remainder) + numericStr.slice(i, i + 9);
    remainder = Number.parseInt(chunk, 10) % 97;
  }
  return remainder;
}

/**
 * Convert IBAN characters to their numeric equivalents:
 *   A=10, B=11, …, Z=35 ; digits stay as-is.
 */
function ibanToNumericString(iban: string): string {
  let result = "";
  for (const ch of iban) {
    const code = ch.charCodeAt(0);
    if (code >= 65 && code <= 90) {
      // A-Z → 10-35
      result += String(code - 55);
    } else {
      result += ch;
    }
  }
  return result;
}

function isIban(value: string): boolean {
  const normalised = normaliseIban(value);

  // Length check: 15–34 chars
  if (normalised.length < 15 || normalised.length > 34) return false;

  // Country code check
  const countryCode = normalised.slice(0, 2);
  if (!IBAN_COUNTRY_CODES.has(countryCode)) return false;

  // Only alphanumeric characters after country code + check digits
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(normalised)) return false;

  // Rearrange: move first 4 chars to end
  const rearranged = normalised.slice(4) + normalised.slice(0, 4);

  // Convert to numeric string and check mod-97
  const numericStr = ibanToNumericString(rearranged);
  return mod97(numericStr) === 1;
}

// ─── PIIDetector implementation ───────────────────────────────────────────────

/**
 * Ultra-conservative PII detector for strings.
 * Returns true only for values that match email or IBAN patterns with checksum.
 *
 * Note: operates on leaves of the value tree only (non-string values → false).
 * The redaction logic in policy.ts handles recursive traversal.
 * @public
 */
export const STRICT_PII_DETECTOR: PIIDetector = (value: unknown): boolean => {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return isEmail(trimmed) || isIban(trimmed);
};
