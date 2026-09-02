/**
 * loadProofCertificate — REST client for /api/runs/:runId/proof-certificate.
 *
 * Fetches a RunProofCertificate from the Command Center API.
 * Auth is optional: if getToken is provided it is called and the result is
 * sent as a Bearer token; otherwise the request is sent unauthenticated
 * (the endpoint has a public read tier for finalized runs).
 *
 * sprint-521 Bloc 1.
 */

import { fetchJson } from "../http/fetch-json.js";
import type { RunProofCertificate } from "./types.js";

export interface LoadProofCertificateOptions {
  runId: string;
  baseUrl: string;
  getToken?: () => Promise<string>;
}

/**
 * Fetch a RunProofCertificate from the Command Center REST API.
 *
 * @param opts.runId   - UUID of the agent run.
 * @param opts.baseUrl - Base URL of the Command Center API (no trailing slash).
 * @param opts.getToken - Optional async function returning a Bearer token.
 * @returns Parsed RunProofCertificate.
 * @throws {HttpError} On 4xx/5xx responses (see ../http/fetch-json.js).
 */
export async function loadProofCertificate(
  opts: LoadProofCertificateOptions,
): Promise<RunProofCertificate> {
  const { runId, baseUrl, getToken } = opts;

  const url = `${baseUrl}/api/runs/${encodeURIComponent(runId)}/proof-certificate`;

  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (getToken) {
    const token = await getToken();
    headers.Authorization = `Bearer ${token}`;
  }

  return fetchJson<RunProofCertificate>(url, { headers }, { label: "[agent-sdk/proof]" });
}
