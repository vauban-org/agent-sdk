import { describe, expect, it } from "vitest";
import type { AcpInitializeParams } from "./initialize.js";
import { negotiateAcpInitialize, negotiateAcpProtocolVersion } from "./initialize.js";
import { parseAcpMessage } from "./jsonrpc.js";

// Meme requete officielle que jsonrpc.test.ts
// (https://agentclientprotocol.com/protocol/v1/initialization), reprise ici
// pour verifier que ses `params` correspondent bien a AcpInitializeParams et
// que la negociation produit une reponse conforme au schema.
const OFFICIAL_INITIALIZE_REQUEST = {
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: {
    protocolVersion: 1,
    clientCapabilities: {
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
      terminal: true,
    },
    clientInfo: {
      name: "my-client",
      title: "My Client",
      version: "1.0.0",
    },
  },
};

const PRESTE_AGENT_INFO = { name: "preste", version: "0.0.0-scaffold" };

describe("negotiateAcpProtocolVersion", () => {
  it("echoue la version demandee quand elle est supportee (1)", () => {
    expect(negotiateAcpProtocolVersion(1)).toBe(1);
  });

  it("retombe sur la derniere version supportee quand la demande est plus recente", () => {
    expect(negotiateAcpProtocolVersion(2)).toBe(1);
  });

  it("retombe sur la derniere version supportee quand la demande est plus ancienne/invalide", () => {
    expect(negotiateAcpProtocolVersion(0)).toBe(1);
  });
});

describe("negotiateAcpInitialize", () => {
  it("traite la requete initialize officielle et produit une reponse conforme", () => {
    const message = parseAcpMessage(JSON.stringify(OFFICIAL_INITIALIZE_REQUEST));
    if (message.method !== "initialize" || !("id" in message)) {
      throw new Error("attendu : requete initialize");
    }
    const params = message.params as AcpInitializeParams;
    const result = negotiateAcpInitialize(params, PRESTE_AGENT_INFO);
    expect(result).toEqual({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false },
      },
      authMethods: [],
      agentInfo: PRESTE_AGENT_INFO,
    });
  });

  it("ne declare jamais une capacite a true (honnetete : rien n'est cable a AgentLoop dans ce scaffold)", () => {
    const result = negotiateAcpInitialize({ protocolVersion: 1 }, PRESTE_AGENT_INFO);
    expect(result.agentCapabilities.loadSession).toBe(false);
    expect(result.agentCapabilities.promptCapabilities?.image).toBe(false);
    expect(result.agentCapabilities.promptCapabilities?.audio).toBe(false);
    expect(result.agentCapabilities.promptCapabilities?.embeddedContext).toBe(false);
    expect(result.agentCapabilities.mcpCapabilities?.http).toBe(false);
    expect(result.agentCapabilities.mcpCapabilities?.sse).toBe(false);
    expect(result.authMethods).toEqual([]);
  });

  it("fonctionne sans clientCapabilities/clientInfo (tous deux optionnels dans le schema)", () => {
    const result = negotiateAcpInitialize({ protocolVersion: 1 }, PRESTE_AGENT_INFO);
    expect(result.protocolVersion).toBe(1);
    expect(result.agentInfo).toEqual(PRESTE_AGENT_INFO);
  });
});
