import type { CodezalEngine } from "@codezal/agent";
import type { AgentEvent, AppSettings } from "@codezal/contracts";
import { BrowserWindow, dialog } from "electron";
import type { AgentTrace } from "./agent-trace.js";
import type { AppPaths } from "./paths.js";
import type { ProjectStore } from "./projects.js";
import type { AppStores } from "./stores.js";
import type { TerminalManager } from "./terminals.js";

/** IPC modüllerinin paylaştığı bağımlılıklar; index.ts açılışta kurar. */
export interface AppContext {
  paths: AppPaths;
  engine: CodezalEngine;
  projects: ProjectStore;
  stores: AppStores;
  terminals: TerminalManager;
  /** Oturum başına NDJSON ajan olay izi (tanılama). */
  agentTrace: AgentTrace;
  /**
   * Oturum başına son yayınlanan ajan olayları (sıra artan). Renderer açılışta snapshot'ı
   * beklerken kaçırabileceği olayları buradan telafi eder; seq filtresiyle çift kayıt önlenir.
   */
  recentAgentEvents: Map<string, AgentEvent[]>;
  settings: () => AppSettings;
}

export function windowOf(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

/** Pencereye bağlı (modal) açma diyaloğu; pencere yoksa serbest. */
export async function openDialog(
  event: Electron.IpcMainInvokeEvent,
  opts: Electron.OpenDialogOptions,
): Promise<string[]> {
  const win = windowOf(event);
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return r.canceled ? [] : r.filePaths;
}

export async function saveDialog(
  event: Electron.IpcMainInvokeEvent,
  opts: Electron.SaveDialogOptions,
): Promise<string | null> {
  const win = windowOf(event);
  const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  return r.canceled || !r.filePath ? null : r.filePath;
}
