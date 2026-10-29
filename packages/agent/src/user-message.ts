import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** Mesaj teslimi için motorun oturumdan gördüğü dar yüz; testler sahte nesneyle aynı yolu ölçer. */
export type PromptTarget = Pick<AgentSession, "isStreaming" | "prompt">;

/** Pi, tur sürerken düz prompt'u bu metinle reddeder (SDK'da ayrı hata sınıfı yok). */
function isAlreadyProcessing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("already processing");
}

/**
 * Kullanıcı mesajını oturuma teslim eder.
 *
 * Pi, tur sürerken yeni tur başlatmayı reddediyor: "Agent is already processing. Specify
 * streamingBehavior ('steer' or 'followUp') to queue the message." Arayüz oturumu boşta görse bile
 * Pi akışta olabilir (tur sonu dürtmesinin sürdürmesi, sıkıştırma, bekleyen izin, yeniden deneme);
 * kullanıcının mesajı kaybolmasın diye yönlendirme (steer) olarak kuyruğa girer ve ajan onu bir
 * sonraki model çağrısında görür. Görseller de aynı yoldan gider.
 */
export async function sendUserMessage(
  session: PromptTarget,
  text: string,
  images?: readonly ImageContent[],
): Promise<void> {
  const attachments = images && images.length > 0 ? { images: [...images] } : {};
  if (session.isStreaming) {
    await session.prompt(text, { ...attachments, streamingBehavior: "steer" });
    return;
  }
  try {
    await session.prompt(text, attachments);
  } catch (error) {
    // `isStreaming` okumasıyla prompt arasında tur başlamış olabilir; mesaj kaybolmasın diye
    // Pi'nin "already processing" reddi yönlendirmeye (steer) çevrilir.
    if (!isAlreadyProcessing(error)) throw error;
    await session.prompt(text, { ...attachments, streamingBehavior: "steer" });
  }
}
