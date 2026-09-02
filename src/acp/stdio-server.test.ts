/**
 * Tests pour AcpStdioAgentServer : la boucle serveur qui relie framing +
 * jsonrpc + initialize, pilotee comme un vrai flux d'octets fragmente.
 *
 * @see ./stdio-server.ts
 */
import { describe, expect, it } from "vitest";
import type { AcpInitializeResult } from "./initialize.js";
import type { AcpErrorResponse, AcpSuccessResponse } from "./jsonrpc.js";
import { AcpStdioAgentServer } from "./stdio-server.js";

const AGENT_INFO = { name: "preste", version: "0.66.2" };

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function makeServer(): { server: AcpStdioAgentServer; frames: string[] } {
  const frames: string[] = [];
  const server = new AcpStdioAgentServer({ agentInfo: AGENT_INFO, write: (f) => frames.push(f) });
  return { server, frames };
}

describe("AcpStdioAgentServer ; initialize", () => {
  it("repond a une requete initialize valide, un seul chunk", () => {
    const { server, frames } = makeServer();
    server.push(
      utf8(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: 1 },
        })}\n`,
      ),
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]?.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(frames[0] as string) as AcpSuccessResponse<AcpInitializeResult>;
    expect(parsed.id).toBe(1);
    expect(parsed.result.protocolVersion).toBe(1);
    expect(parsed.result.agentInfo).toEqual(AGENT_INFO);
    expect(parsed.result.agentCapabilities.loadSession).toBe(false);
  });

  it("negocie vers la derniere version supportee si le client en demande une inconnue", () => {
    const { server, frames } = makeServer();
    server.push(
      utf8(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: "req-1",
          method: "initialize",
          params: { protocolVersion: 999 },
        })}\n`,
      ),
    );
    const parsed = JSON.parse(frames[0] as string) as AcpSuccessResponse<AcpInitializeResult>;
    expect(parsed.result.protocolVersion).toBe(1);
    expect(parsed.id).toBe("req-1");
  });

  it("gere une requete fragmentee sur plusieurs push() (le message n'arrive pas d'un coup)", () => {
    const { server, frames } = makeServer();
    const line = `${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "initialize", params: { protocolVersion: 1 } })}\n`;
    const mid = Math.floor(line.length / 2);
    server.push(utf8(line.slice(0, mid)));
    expect(frames).toHaveLength(0); // rien avant la ligne complete
    server.push(utf8(line.slice(mid)));
    expect(frames).toHaveLength(1);
  });

  it("traite plusieurs messages arrives dans UN SEUL chunk, dans l'ordre", () => {
    const { server, frames } = makeServer();
    const l1 = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })}\n`;
    const l2 = `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new" })}\n`;
    server.push(utf8(l1 + l2));
    expect(frames).toHaveLength(2);
    expect((JSON.parse(frames[0] as string) as AcpSuccessResponse).id).toBe(1);
    expect((JSON.parse(frames[1] as string) as AcpErrorResponse).id).toBe(2);
  });
});

describe("AcpStdioAgentServer ; methode non geree (honnetete de perimetre)", () => {
  it("repond method-not-found (-32601) pour toute methode autre que initialize", () => {
    const { server, frames } = makeServer();
    server.push(utf8(`${JSON.stringify({ jsonrpc: "2.0", id: 5, method: "session/prompt" })}\n`));
    const parsed = JSON.parse(frames[0] as string) as AcpErrorResponse;
    expect(parsed.id).toBe(5);
    expect(parsed.error.code).toBe(-32601);
    expect(parsed.error.message).toContain("session/prompt");
  });
});

describe("AcpStdioAgentServer ; fin de flux (end)", () => {
  it("flush une derniere ligne restee sans saut de ligne final et la traite", () => {
    const { server, frames } = makeServer();
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1 },
    });
    server.push(utf8(line)); // pas de \n final : rien ne doit sortir tant que le flux n'est pas ferme
    expect(frames).toHaveLength(0);
    server.end();
    expect(frames).toHaveLength(1);
    const parsed = JSON.parse(frames[0] as string) as AcpSuccessResponse<AcpInitializeResult>;
    expect(parsed.id).toBe(1);
  });

  it("ne fait rien si le flux se termine sans ligne en attente (idempotent)", () => {
    const { server, frames } = makeServer();
    server.push(
      utf8(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })}\n`,
      ),
    );
    expect(frames).toHaveLength(1);
    server.end(); // rien en attente : ne doit pas produire de deuxieme reponse
    expect(frames).toHaveLength(1);
  });
});

describe("AcpStdioAgentServer ; durcissement hostile (Zero Trust)", () => {
  it("ne leve jamais sur une ligne non-JSON ; repond parse-error id:null", () => {
    const { server, frames } = makeServer();
    server.push(utf8("ceci n'est pas du JSON\n"));
    expect(frames).toHaveLength(1);
    const parsed = JSON.parse(frames[0] as string) as AcpErrorResponse;
    expect(parsed.id).toBeNull();
    expect(parsed.error.code).toBe(-32700);
  });

  it("ne leve jamais sur un JSON valide mais hors enveloppe JSON-RPC", () => {
    const { server, frames } = makeServer();
    server.push(utf8(`${JSON.stringify({ hello: "world" })}\n`));
    const parsed = JSON.parse(frames[0] as string) as AcpErrorResponse;
    expect(parsed.error.code).toBe(-32700);
  });

  it("ignore silencieusement une notification a methode inconnue (JSON-RPC : jamais de reponse a une notification)", () => {
    const { server, frames } = makeServer();
    server.push(utf8(`${JSON.stringify({ jsonrpc: "2.0", method: "unknown/notify" })}\n`));
    expect(frames).toHaveLength(0);
  });

  it("ignore silencieusement une reponse entrante (result) sans requete correlee, ne leve jamais", () => {
    const { server, frames } = makeServer();
    server.push(utf8(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } })}\n`));
    expect(frames).toHaveLength(0);
  });

  it("ignore silencieusement une reponse entrante (error) sans requete correlee, ne leve jamais", () => {
    const { server, frames } = makeServer();
    server.push(
      utf8(`${JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "x" } })}\n`),
    );
    expect(frames).toHaveLength(0);
  });

  it("ignore une ligne vide sans fabriquer d'erreur", () => {
    const { server, frames } = makeServer();
    server.push(utf8("\n"));
    expect(frames).toHaveLength(0);
  });

  it("continue de fonctionner apres une ligne hostile (pas d'etat corrompu)", () => {
    const { server, frames } = makeServer();
    server.push(utf8("hostile\n"));
    server.push(
      utf8(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })}\n`,
      ),
    );
    expect(frames).toHaveLength(2);
    expect((JSON.parse(frames[1] as string) as AcpSuccessResponse).id).toBe(1);
  });
});
