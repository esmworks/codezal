import type { McpConnector } from "@codezal/contracts";
import { describe, expect, it } from "vitest";
import { connectorSlug, promptSuggestions } from "./mcpPrompts";
import { filterSuggestions } from "./slashSearch";

function connector(patch: Partial<McpConnector>): McpConnector {
  return {
    id: "c1",
    name: "Yerel Notlar",
    url: "",
    auth: "none",
    ownClient: false,
    clientGroup: null,
    native: null,
    enabled: true,
    status: "connected",
    account: null,
    tools: [],
    error: null,
    transport: "stdio",
    command: "node notes.mjs",
    cwd: null,
    envKeys: [],
    stderr: null,
    toolChange: null,
    resources: false,
    prompts: [],
    ...patch,
  };
}

describe("connectorSlug", () => {
  it("adı katlar ve yalnız harf, rakam, tire bırakır", () => {
    expect(connectorSlug("Google Takvim")).toBe("google-takvim");
    expect(connectorSlug("Çiçek Şirketi / İK")).toBe("cicek-sirketi-ik");
    expect(connectorSlug("  --  ")).toBe("");
  });
});

describe("promptSuggestions", () => {
  const ozet = {
    name: "ozet",
    title: null,
    description: "Konuyu özetlet",
    arguments: [{ name: "konu", description: "Özetlenecek konu", required: true }],
  };

  it("bağlı servisin istemlerini `/<servis>:<istem>` olarak verir", () => {
    const [item, ...rest] = promptSuggestions([connector({ prompts: [ozet] })]);
    expect(rest).toEqual([]);
    expect(item).toMatchObject({
      id: "prompt:c1:ozet",
      kind: "prompt",
      value: "/yerel-notlar:ozet",
      label: "/yerel-notlar:ozet",
      description: "Konuyu özetlet",
      runOnPick: false,
      prompt: { connectorId: "c1", name: "ozet", arguments: ozet.arguments },
    });
  });

  it("bağlı olmayan servisin istemleri listelenmez", () => {
    const off = connector({ status: "error", prompts: [ozet] });
    expect(promptSuggestions([off])).toEqual([]);
  });

  it("istem adındaki boşluk tireye iner, gerçek ad yükte kalır", () => {
    const spaced = { ...ozet, name: "haftalik rapor", arguments: [] };
    const [item] = promptSuggestions([connector({ prompts: [spaced] })]);
    expect(item?.value).toBe("/yerel-notlar:haftalik-rapor");
    expect(item?.prompt?.name).toBe("haftalik rapor");
  });

  it("panel aramasında servis adıyla bulunur", () => {
    const items = promptSuggestions([connector({ prompts: [ozet] })]);
    expect(filterSuggestions(items, "yerel").map((s) => s.id)).toEqual(["prompt:c1:ozet"]);
    expect(filterSuggestions(items, "zzz")).toEqual([]);
  });
});
