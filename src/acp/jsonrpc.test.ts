import { describe, expect, it } from "vitest";
import { AcpProtocolError, parseAcpMessage, serializeAcpMessage } from "./jsonrpc.js";

// Exemple de requete `initialize` tel que publie dans la doc officielle ACP
// (https://agentclientprotocol.com/protocol/v1/initialization). Utilise tel
// quel plutot qu'invente, pour ancrer les tests dans la spec reelle.
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

describe("parseAcpMessage", () => {
  it("parse la requete initialize officielle en AcpRequest", () => {
    const raw = JSON.stringify(OFFICIAL_INITIALIZE_REQUEST);
    const message = parseAcpMessage(raw);
    expect(message).toEqual({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: OFFICIAL_INITIALIZE_REQUEST.params,
    });
  });

  it("parse une notification (sans id) en AcpNotification", () => {
    const raw = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s-1" },
    });
    const message = parseAcpMessage(raw);
    expect(message).toEqual({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s-1" },
    });
    expect("id" in message).toBe(false);
  });

  it("parse une reponse de succes en AcpSuccessResponse", () => {
    const raw = JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      result: { protocolVersion: 1 },
    });
    const message = parseAcpMessage(raw);
    expect(message).toEqual({
      jsonrpc: "2.0",
      id: 0,
      result: { protocolVersion: 1 },
    });
  });

  it("parse une reponse d'erreur en AcpErrorResponse", () => {
    const raw = JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32601, message: "Method not found" },
    });
    const message = parseAcpMessage(raw);
    expect(message).toEqual({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32601, message: "Method not found" },
    });
  });

  it("rejette une ligne non-JSON", () => {
    expect(() => parseAcpMessage("{ pas du json valide")).toThrow(AcpProtocolError);
  });

  it("rejette un message sans jsonrpc: 2.0", () => {
    expect(() => parseAcpMessage(JSON.stringify({ id: 1, method: "initialize" }))).toThrow(
      AcpProtocolError,
    );
  });

  it("rejette une reponse qui porte a la fois result et error", () => {
    const raw = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {},
      error: { code: -1, message: "conflit" },
    });
    expect(() => parseAcpMessage(raw)).toThrow(AcpProtocolError);
  });

  it("rejette un objet qui n'est ni requete/notification ni reponse", () => {
    const raw = JSON.stringify({ jsonrpc: "2.0", foo: "bar" });
    expect(() => parseAcpMessage(raw)).toThrow(AcpProtocolError);
  });

  it("rejette un id de type invalide (objet)", () => {
    const raw = JSON.stringify({ jsonrpc: "2.0", id: {}, method: "initialize" });
    expect(() => parseAcpMessage(raw)).toThrow(AcpProtocolError);
  });

  it("accepte un id null pour une reponse (JSON-RPC 2.0 valide pour les erreurs de parsing amont)", () => {
    const raw = JSON.stringify({ jsonrpc: "2.0", id: null, result: null });
    const message = parseAcpMessage(raw);
    expect(message).toEqual({ jsonrpc: "2.0", id: null, result: null });
  });
});

describe("serializeAcpMessage", () => {
  it("est l'inverse exact de parseAcpMessage sur un aller-retour", () => {
    const message = parseAcpMessage(JSON.stringify(OFFICIAL_INITIALIZE_REQUEST));
    const roundTripped = parseAcpMessage(serializeAcpMessage(message));
    expect(roundTripped).toEqual(message);
  });
});
