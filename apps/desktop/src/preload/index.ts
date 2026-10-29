import type { AppPlatform, CodezalBridge } from "@codezal/contracts";
import { contextBridge, ipcRenderer, webUtils } from "electron";

const bridge: CodezalBridge = {
  platform: process.platform as AppPlatform,
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  on: (channel, listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      listener(payload as Parameters<typeof listener>[0]);
    };
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld("codezal", bridge);
