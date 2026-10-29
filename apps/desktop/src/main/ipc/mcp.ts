import type { AppContext } from "../context.js";
import { broadcast, handle } from "../ipc.js";
import { log } from "../log.js";

/** Bağlayıcı (uzak MCP) kanalları; durum değişimleri `mcp:changed` ile yayınlanır. */
export function registerMcpIpc({ engine: eng }: AppContext): void {
  const mcp = eng.mcp;
  // Hata metni yalnızca arayüzde kalmasın: her yeni hata bir kez günlüğe düşer.
  const lastError = new Map<string, string>();
  mcp.onChange(() => {
    for (const c of mcp.list()) {
      const prev = lastError.get(c.id);
      if (c.error && c.error !== prev) log.warn("mcp", `${c.name} (${c.status}): ${c.error}`);
      if (c.error) lastError.set(c.id, c.error);
      else lastError.delete(c.id);
    }
    broadcast("mcp:changed", {});
  });

  handle("mcp:list", () => mcp.list());
  handle("mcp:builtInGroups", () => mcp.builtInClientGroups());
  handle("mcp:add", ({ native, ...input }) =>
    mcp.add({ ...input, native: native ? { service: native } : null }),
  );
  handle("mcp:addStdio", (input) => mcp.addStdio(input));
  handle("mcp:update", ({ id, ...patch }) => mcp.update(id, patch));
  handle("mcp:remove", ({ id }) => mcp.remove(id));
  handle("mcp:login", ({ id }) => mcp.login(id));
  handle("mcp:logout", ({ id }) => mcp.logout(id));
  handle("mcp:reconnect", ({ id }) => mcp.connect(id));
  handle("mcp:setToolPolicy", ({ id, tools, policy }) => mcp.setToolPolicy(id, tools, policy));
  handle("mcp:approveTools", ({ id, tools }) => mcp.approveTools(id, tools));
  handle("mcp:getPrompt", async ({ id, name, args }) => ({
    text: await mcp.getPrompt(id, name, args),
  }));
  handle("mcp:reconnectFailed", () => mcp.reconnectFailed());
}
