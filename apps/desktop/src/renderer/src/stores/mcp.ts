import type { IpcRequest, McpConnector, McpToolPolicy } from "@codezal/contracts";
import { create } from "zustand";
import { invoke, on } from "../api";

interface McpState {
  connectors: McpConnector[];
  loaded: boolean;
  /** Uygulamayla gelen OAuth istemcisi olan aileler; katalog kartı kimlik formu sormaz. */
  builtInGroups: string[];
  /** Süren giriş akışının bağlayıcı kimliği (tarayıcı bekleniyor). */
  loggingIn: string | null;
  load: () => Promise<void>;
  add: (input: IpcRequest<"mcp:add">) => Promise<McpConnector>;
  /** Yerel komut (stdio) sunucusu; ortam değerleri main'e gider, geri hiç dönmez. */
  addStdio: (input: IpcRequest<"mcp:addStdio">) => Promise<McpConnector>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  remove: (id: string) => Promise<void>;
  login: (id: string) => Promise<void>;
  logout: (id: string) => Promise<void>;
  reconnect: (id: string) => Promise<void>;
  /** Araç izinlerini değiştirir; liste hemen güncellenir, main `mcp:changed` ile doğrular. */
  setToolPolicy: (id: string, tools: string[], policy: McpToolPolicy) => Promise<void>;
  /** Yeni/değişmiş araçları onaylar; main tanımı sabitler ve `mcp:changed` yayınlar. */
  approveTools: (id: string, tools: string[]) => Promise<void>;
  /** Hata/bağlı değil durumdaki etkin bağlayıcıları yeniden dener (main debounce'lu). */
  reconnectFailed: () => Promise<number>;
}

/** Bağlayıcı listesi ve durumları; belirteçler main'de kalır, buraya yalnızca özet gelir. */
export const useMcp = create<McpState>((set, get) => ({
  connectors: [],
  loaded: false,
  builtInGroups: [],
  loggingIn: null,
  load: async () => {
    const [connectors, builtInGroups] = await Promise.all([
      invoke("mcp:list", {}),
      invoke("mcp:builtInGroups", {}),
    ]);
    set({ connectors, builtInGroups, loaded: true });
  },
  add: (input) => invoke("mcp:add", input),
  addStdio: (input) => invoke("mcp:addStdio", input),
  setEnabled: async (id, enabled) => {
    set({ connectors: get().connectors.map((c) => (c.id === id ? { ...c, enabled } : c)) });
    await invoke("mcp:update", { id, enabled });
  },
  remove: (id) => invoke("mcp:remove", { id }),
  login: async (id) => {
    set({ loggingIn: id });
    try {
      await invoke("mcp:login", { id });
    } finally {
      set({ loggingIn: null });
    }
  },
  logout: (id) => invoke("mcp:logout", { id }),
  reconnect: (id) => invoke("mcp:reconnect", { id }),
  setToolPolicy: async (id, tools, policy) => {
    const names = new Set(tools);
    set({
      connectors: get().connectors.map((c) =>
        c.id === id
          ? { ...c, tools: c.tools.map((t) => (names.has(t.name) ? { ...t, policy } : t)) }
          : c,
      ),
    });
    await invoke("mcp:setToolPolicy", { id, tools, policy });
  },
  approveTools: (id, tools) => invoke("mcp:approveTools", { id, tools }),
  reconnectFailed: () => invoke("mcp:reconnectFailed", {}),
}));

on("mcp:changed", () => void useMcp.getState().load());

/** Bağlayıcının ajana giden araçları: kapatılmamış ve onay beklemeyen. */
export function activeTools(c: McpConnector): McpConnector["tools"] {
  return c.tools.filter((t) => t.policy !== "off" && t.review === null);
}

/** Yeni ya da tanımı değiştiği için onay bekleyen araçlar (ajana verilmez). */
export function pendingTools(c: McpConnector): McpConnector["tools"] {
  return c.status === "connected" ? c.tools.filter((t) => t.review !== null) : [];
}

/** Bağlı bağlayıcıların ajana giden toplam araç sayısı (palet satırı, Servisler özeti). */
export function connectedToolCount(connectors: McpConnector[]): number {
  return connectors
    .filter((c) => c.status === "connected")
    .reduce((n, c) => n + activeTools(c).length, 0);
}
