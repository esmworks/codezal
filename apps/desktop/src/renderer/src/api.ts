import type {
  IpcChannel,
  IpcEventChannel,
  IpcEventPayload,
  IpcRequest,
  IpcResponse,
} from "@codezal/contracts";

/** Tipli IPC istemcisi. Preload köprüsünü sarar; renderer'da yalnızca burası window.codezal'a dokunur. */
export function invoke<C extends IpcChannel>(
  channel: C,
  payload: IpcRequest<C>,
): Promise<IpcResponse<C>> {
  return window.codezal.invoke(channel, payload);
}

export function on<C extends IpcEventChannel>(
  channel: C,
  listener: (payload: IpcEventPayload<C>) => void,
): () => void {
  return window.codezal.on(channel, listener);
}

/** Sürükleyip bırakılan dosyanın disk yolunu verir; yol yoksa boş dize. */
export function pathForFile(file: File): string {
  return window.codezal.pathForFile(file);
}
