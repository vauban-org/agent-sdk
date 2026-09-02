/**
 * Tests pour `runAcpStdioServer` : le cablage de `AcpStdioAgentServer` a de
 * vrais flux d'octets. Deux niveaux de preuve :
 *   1. `PassThrough` de `node:stream` : de vrais flux Node (pas des mocks),
 *      en memoire, rapides ; couvrent le cablage data/end/error.
 *   2. Un vrai subprocess (`node:child_process`) qui execute la fixture
 *      `tests/acp/run-stdio-subprocess-fixture.ts` via le binaire `tsx` du
 *      workspace : preuve la plus forte que le transport fonctionne au-dela
 *      d'un test unitaire, avec de vrais descripteurs de fichier stdin/stdout
 *      de processus. Ignore silencieusement si `tsx` est absent du
 *      workspace (meme garde que `container-runtime-e2e.test.ts`).
 *
 * @see ./run-stdio.ts
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AcpInitializeResult } from "./initialize.js";
import type { AcpErrorResponse, AcpSuccessResponse } from "./jsonrpc.js";
import { runAcpStdioServer } from "./run-stdio.js";

const AGENT_INFO = { name: "preste", version: "0.66.2" };

function utf8(s: string): Buffer {
  return Buffer.from(s, "utf-8");
}

describe("runAcpStdioServer ; PassThrough (vrais flux Node en memoire)", () => {
  it("lit une requete initialize sur stdin et ecrit la reponse sur stdout", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const chunks: Buffer[] = [];
    stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

    const done = runAcpStdioServer({ agentInfo: AGENT_INFO, stdin, stdout });
    stdin.write(
      utf8(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })}\n`,
      ),
    );
    stdin.end();
    await done;

    const frame = Buffer.concat(chunks).toString("utf-8");
    expect(frame.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(frame) as AcpSuccessResponse<AcpInitializeResult>;
    expect(parsed.id).toBe(1);
    expect(parsed.result.agentInfo).toEqual(AGENT_INFO);
  });

  it("traite plusieurs requetes ecrites en plusieurs write() distincts, dans l'ordre", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const chunks: Buffer[] = [];
    stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

    const done = runAcpStdioServer({ agentInfo: AGENT_INFO, stdin, stdout });
    stdin.write(
      utf8(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })}\n`,
      ),
    );
    stdin.write(utf8(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new" })}\n`));
    stdin.end();
    await done;

    const frames = Buffer.concat(chunks).toString("utf-8").trim().split("\n");
    expect(frames).toHaveLength(2);
    expect((JSON.parse(frames[0] as string) as AcpSuccessResponse).id).toBe(1);
    expect((JSON.parse(frames[1] as string) as AcpErrorResponse).id).toBe(2);
  });

  it("flush une derniere ligne sans saut de ligne final a la fermeture du flux (EOF)", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const chunks: Buffer[] = [];
    stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

    const done = runAcpStdioServer({ agentInfo: AGENT_INFO, stdin, stdout });
    // Pas de "\n" final : simule un client qui ecrit puis ferme immediatement
    // sans flush explicite de sa derniere ligne.
    stdin.write(
      utf8(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 9,
          method: "initialize",
          params: { protocolVersion: 1 },
        }),
      ),
    );
    stdin.end();
    await done;

    const parsed = JSON.parse(
      Buffer.concat(chunks).toString("utf-8"),
    ) as AcpSuccessResponse<AcpInitializeResult>;
    expect(parsed.id).toBe(9);
  });

  it("se rejette si stdin emet une erreur (frontiere hostile : ne reste jamais pendante)", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const done = runAcpStdioServer({ agentInfo: AGENT_INFO, stdin, stdout });
    const boom = new Error("stdin cassee");
    stdin.emit("error", boom);
    await expect(done).rejects.toBe(boom);
  });
});

describe("runAcpStdioServer ; vrai subprocess (node:child_process)", () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // packages/agent-sdk/src/acp -> ../../../.. = racine du workspace pnpm.
  const REPO_ROOT = path.resolve(__dirname, "../../../..");
  const TSX_BIN = path.join(REPO_ROOT, "node_modules/.bin/tsx");
  const FIXTURE = path.resolve(__dirname, "../../tests/acp/run-stdio-subprocess-fixture.ts");
  const TSX_OK = existsSync(TSX_BIN) && existsSync(FIXTURE);

  it.skipIf(!TSX_OK)(
    "un vrai processus enfant repond a une requete initialize ecrite sur son vrai stdin",
    async () => {
      const child: ChildProcessWithoutNullStreams = spawn(TSX_BIN, [FIXTURE], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      const exited = new Promise<number | null>((resolve) => {
        child.on("close", (code) => resolve(code));
      });

      child.stdin.write(
        utf8(
          `${JSON.stringify({ jsonrpc: "2.0", id: "req-1", method: "initialize", params: { protocolVersion: 1 } })}\n`,
        ),
      );
      child.stdin.end();

      const exitCode = await exited;
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      expect(exitCode, `stderr du subprocess : ${stderr}`).toBe(0);

      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const parsed = JSON.parse(stdout.trim()) as AcpSuccessResponse<AcpInitializeResult>;
      expect(parsed.id).toBe("req-1");
      expect(parsed.result.agentInfo).toEqual({ name: "preste-fixture", version: "0.0.0-test" });
    },
    15_000,
  );
});
