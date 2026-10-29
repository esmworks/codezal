import {
  type Context,
  createFauxCore,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * Ajan koşularını uçtan uca sınamak için senaryolu model (Pi'nin faux sağlayıcısı). Yalnız
 * testlerde bağlanır: vitest akış testi ve Playwright (`CODEZAL_E2E_FAUX=1`, paketli sürümde
 * kapalı). Her oturum ilk kullanıcı mesajına bakarak ne yapacağını seçer: ana oturum `PLAN:`
 * satırındaki ajan çağrılarını tek yanıtta yapar, alt ajan `DOSYA:` satırındaki dosyayı yazar,
 * `ARKA:` satırındaki komut `bash_background` ile arka planda başlatılır; `ARKA[açıklama]:`
 * biçiminde komuta kısa açıklama da verilir; `KOMUT:` satırındaki komut ön planda `bash` ile
 * çalışır.
 * Paralel oturumlarda yanıt sırası belirsiz olduğu için sıra değil bağlam belirleyicidir.
 */

export const FLOW_PROVIDER = "faux";
export const FLOW_MODEL = "flow";

export interface FlowAgent {
  file: string;
  content: string;
  background?: boolean;
  isolation?: string;
}

/** Ana oturum istemi: modelin tek yanıtta başlatacağı ajanlar. */
export function flowPrompt(agents: FlowAgent[]): string {
  return `PLAN:${JSON.stringify(agents)}`;
}

/** Mesajın düz metni; içerik dize ya da blok listesi olabilir. */
function textOf(message: Context["messages"][number] | undefined): string {
  if (!message || !("content" in message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  return content.map((block) => ("text" in block ? block.text : "")).join("");
}

let callSeq = 0;

const reply: FauxResponseFactory = (context) => {
  const first = textOf(context.messages.find((m) => m.role === "user"));
  const answered = context.messages.some((m) => m.role === "assistant");
  const plan = /PLAN:(\[.*\])/.exec(first)?.[1];
  if (plan !== undefined) {
    // Ana oturum, yanıtlanmamış son kullanıcı mesajı plan taşıyorsa ajan başlatır (ikinci turda
    // yeni plan da çalışır); araç sonucu ya da arka plan dürtmesi gelince kapanış metni yazar.
    const lastUser = context.messages.findLastIndex((m) => m.role === "user");
    const pending = !context.messages.slice(lastUser + 1).some((m) => m.role === "assistant");
    const fresh = pending
      ? /PLAN:(\[.*\])/.exec(textOf(context.messages[lastUser]))?.[1]
      : undefined;
    if (fresh === undefined) return fauxAssistantMessage("Ana tur bitti.");
    const agents = JSON.parse(fresh) as FlowAgent[];
    return fauxAssistantMessage(
      agents.map((agent) =>
        fauxToolCall(
          "agent",
          {
            subagent_type: "general",
            description: `${agent.file} düzelt`,
            prompt: `DOSYA:${agent.file}=${agent.content}`,
            ...(agent.background ? { background: true } : {}),
            ...(agent.isolation ? { isolation: agent.isolation } : {}),
          },
          { id: `flow-${++callSeq}` },
        ),
      ),
      { stopReason: "toolUse" },
    );
  }
  const arka = /ARKA(?:\[([^\]]+)\])?:(.+)/.exec(first);
  const background = arka?.[2];
  if (background !== undefined) {
    // Arka plan akışı: komut tek yanıtta başlar; bitiş dürtmesi dahil sonraki yanıtlar metindir.
    if (answered) return fauxAssistantMessage("Komut arka planda.");
    return fauxAssistantMessage(
      fauxToolCall(
        "bash_background",
        {
          action: "start",
          command: background.trim(),
          ...(arka?.[1] ? { description: arka[1] } : {}),
        },
        { id: `flow-${++callSeq}` },
      ),
      { stopReason: "toolUse" },
    );
  }
  // Ön plan terminal komutu (`KOMUT:<komut>`): tur yedeğinin `bash` kapsamını sınamak için.
  const command = /KOMUT:(.+)/.exec(first)?.[1];
  if (command !== undefined) {
    if (answered) return fauxAssistantMessage("Komut çalıştı.");
    return fauxAssistantMessage(
      fauxToolCall("bash", { command: command.trim() }, { id: `flow-${++callSeq}` }),
      { stopReason: "toolUse" },
    );
  }
  const task = /DOSYA:([^=\s]+)=(.*)/.exec(first);
  if (task && !answered) {
    const [, file = "", content = ""] = task;
    return fauxAssistantMessage(
      fauxToolCall("write", { path: file, content: `${content}\n` }, { id: `flow-${++callSeq}` }),
      { stopReason: "toolUse" },
    );
  }
  return fauxAssistantMessage("Tamam, dosyayı düzelttim.");
};

/** Sağlayıcıyı çalışma zamanına ekler; yanıt kuyruğunu doldurmak için dönen işlev çağrılır. */
export function registerFlowModel(runtime: Pick<ModelRuntime, "registerProvider">): {
  reset: () => void;
} {
  const faux = createFauxCore({
    api: "faux-flow",
    provider: FLOW_PROVIDER,
    models: [{ id: FLOW_MODEL }],
  });
  runtime.registerProvider(FLOW_PROVIDER, {
    name: "Faux",
    baseUrl: "http://localhost",
    apiKey: "faux-key",
    api: "faux-flow",
    streamSimple: faux.streamSimple,
    models: [
      {
        id: FLOW_MODEL,
        name: "Flow",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 4096,
      },
    ],
  });
  // Fabrika bağlama bakar; kuyruk uzunluğu yalnız üst sınırdır.
  const reset = () => faux.setResponses(Array.from({ length: 500 }, () => reply));
  reset();
  return { reset };
}
