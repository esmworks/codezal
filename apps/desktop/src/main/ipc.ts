import { maskSecrets } from "@codezal/agent";
import {
  type IpcChannel,
  type IpcEventChannel,
  type IpcEventPayload,
  type IpcPayload,
  type IpcResponse,
  ipcContract,
} from "@codezal/contracts";
import { BrowserWindow, type IpcMainInvokeEvent, ipcMain } from "electron";
import { log } from "./log.js";

type Handler<C extends IpcChannel> = (
  payload: IpcPayload<C>,
  event: IpcMainInvokeEvent,
) => Promise<IpcResponse<C>> | IpcResponse<C>;

/** Kanal + Zod şema + handler. İstek doğrulanır, yanıt şemaya göre parse edilir, hata loglanır. */
export function handle<C extends IpcChannel>(channel: C, handler: Handler<C>): void {
  const def = ipcContract[channel];
  ipcMain.handle(channel, async (event, raw: unknown) => {
    const started = Date.now();
    try {
      const payload = def.req.parse(raw) as IpcPayload<C>;
      const result = await handler(payload, event);
      // Ayrıntılı günlükte kanal süresi görünür: takılan bir çağrı burada belli olur.
      log.debug(`ipc:${channel}`, `${Date.now() - started} ms`);
      return def.res.parse(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`ipc:${channel}`, error);
      throw new Error(`[${channel}] ${maskSecrets(message)}`);
    }
  });
}

/** Main → tüm pencereler olay yayını. */
export function broadcast<C extends IpcEventChannel>(
  channel: C,
  payload: IpcEventPayload<C>,
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}
