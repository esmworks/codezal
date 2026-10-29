import { invoke } from "../api";
import { revealJobs, showPanel } from "../lib/revealAgent";
import { usePanel } from "./panel";
import { humanizeError, toast } from "./toast";

/**
 * Bir arka plan komutunun çıktısını sağ panelin "İşler" sekmesinde, ayrıntı görünümünde açar.
 * `jobId` verilmezse iş listesi açılır.
 */
export function revealBackground(sessionId: string, jobId?: string): void {
  if (!jobId) {
    revealJobs();
    return;
  }
  usePanel.getState().showJob({ sessionId, kind: "bg", id: jobId });
  showPanel();
}

/** Komutu durdurur; satır `background_end` olayı gelince "durduruldu"ya döner. */
export function stopBackground(sessionId: string, jobId: string): void {
  void invoke("background:stop", { sessionId, jobId }).catch((e: unknown) =>
    toast.error(humanizeError(e)),
  );
}
