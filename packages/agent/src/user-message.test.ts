import type { PromptOptions } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { type PromptTarget, sendUserMessage } from "./user-message.js";

function fakeSession(streaming: boolean) {
  const prompt = vi.fn(async (_text: string, _options?: PromptOptions) => undefined);
  const session: PromptTarget = { isStreaming: streaming, prompt };
  return { session, prompt };
}

describe("sendUserMessage", () => {
  it("tur sürerken mesajı yönlendirme (steer) olarak kuyruğa verir", async () => {
    const { session, prompt } = fakeSession(true);
    await sendUserMessage(session, "şunu da ekle");
    // Pi akış sürerken streamingBehavior'sız prompt'u reddediyor; mesaj bu yüzden kaybolmamalı.
    expect(prompt).toHaveBeenCalledWith("şunu da ekle", { streamingBehavior: "steer" });
  });

  it("tur sürerken görselleri de yönlendirmeye ekler", async () => {
    const { session, prompt } = fakeSession(true);
    const images = [{ type: "image" as const, mimeType: "image/png", data: "aGk=" }];
    await sendUserMessage(session, "şuna bak", images);
    expect(prompt).toHaveBeenCalledWith("şuna bak", { images, streamingBehavior: "steer" });
  });

  it("oturum boştayken yeni tur başlatır (kuyruk seçeneği yok)", async () => {
    const { session, prompt } = fakeSession(false);
    await sendUserMessage(session, "merhaba");
    expect(prompt).toHaveBeenCalledWith("merhaba", {});
  });

  it("boş görsel listesini isteğe eklemez", async () => {
    const { session, prompt } = fakeSession(false);
    await sendUserMessage(session, "merhaba", []);
    expect(prompt).toHaveBeenCalledWith("merhaba", {});
  });

  it("isStreaming ile prompt arasında tur başlarsa mesajı yönlendirmeye çevirir", async () => {
    // Yarış: boş görünen oturumda düz prompt Pi tarafından reddedilir; mesaj kaybolmamalı.
    const prompt = vi.fn(async (_text: string, options?: PromptOptions) => {
      if (!options?.streamingBehavior) {
        throw new Error(
          "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
        );
      }
      return undefined;
    });
    const session: PromptTarget = { isStreaming: false, prompt };
    await sendUserMessage(session, "bunu kaçırma");
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt).toHaveBeenLastCalledWith("bunu kaçırma", { streamingBehavior: "steer" });
  });

  it("ilgisiz prompt hatasını olduğu gibi fırlatır", async () => {
    const prompt = vi.fn(async () => {
      throw new Error("ağ koptu");
    });
    const session: PromptTarget = { isStreaming: false, prompt };
    await expect(sendUserMessage(session, "merhaba")).rejects.toThrow("ağ koptu");
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});
