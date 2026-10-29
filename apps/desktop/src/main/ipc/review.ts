import { mkdirSync } from "node:fs";
import { shell } from "electron";
import type { AppContext } from "../context.js";
import { handle } from "../ipc.js";

/** Kod incelemesi (deneysel) kanalları: koşu başlatma, bulgu işareti ve kayıt klasörü. */
export function registerReviewIpc({ engine }: AppContext): void {
  // Koşu arka planda sürer; başlangıç/bitiş `review` olayıyla renderer'a gider.
  handle("review:run", ({ sessionId }) => engine.startReview(sessionId));

  handle("review:mark", ({ sessionId, findingId, outcome }) => {
    engine.markReviewFinding(sessionId, findingId, outcome);
  });

  handle("review:reveal", async ({ sessionId }) => {
    const dir = engine.reviewDir(sessionId);
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
  });
}
