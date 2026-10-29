import { dict, type Locale } from "@codezal/i18n";
import {
  type Api,
  type AssistantMessage,
  contentText,
  type Message,
  type Model,
  Type,
} from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  convertToLlm,
  defineTool,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/**
 * Danışman (advisor) aracı: ajan parametresiz çağırır, oturumun tüm dökümü Ayarlar > Kullanım'da
 * seçilen daha güçlü modele gider ve tavsiye araç sonucu olarak döner. Danışmanın aracı yoktur;
 * yalnızca okur ve yazar.
 */
export const ADVISOR_TOOL = "advisor";

/** Tavsiyenin yanıt sınırı; kısa tutulması istenir ama düşünen modellerde pay bırakılır. */
const ADVICE_MAX_TOKENS = 8_192;
/** Tek araç sonucunun dökümdeki sınırı; dosya okuması ve komut çıktısı büyük ölçüde görünsün. */
const RESULT_MAX_CHARS = 20_000;
/** Araç argümanı ve düşünme bloğu sınırı. */
const BLOCK_MAX_CHARS = 6_000;
/** Ajanın sistem istemi (proje talimatları) dökümün başına bu kadarıyla eklenir. */
const SYSTEM_MAX_CHARS = 30_000;
/** Token başına karakter; sınır hesabı temkinli olsun diye düşük tutulur. */
const CHARS_PER_TOKEN = 3;
/** Sistem istemi, çerçeve metni ve sağlayıcı farkları için ayrılan pay (token). */
const RESERVE_TOKENS = 12_000;

export interface AdvisorOptions {
  /** Seçili danışman modeli (Ayarlar > Kullanım); her çağrıda canlı okunur. */
  model: () => { provider: string; id: string } | null | undefined;
  /** Bu oturumda danışılabilir mi (zamanlanmış koşuda ayara bağlı); verilmezse hep açık. */
  allowed?: () => boolean;
  /** Danışman çağrısının kullanımı; motor bunu kullanım sayacına yayınlar. */
  onUsage?: (message: AssistantMessage, model: string) => void;
}

/** Uzun metni baştan ve sondan korur; ortadaki kısım atılır. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n[… ${text.length - max} chars omitted …]\n${text.slice(-tail)}`;
}

function argsText(args: unknown): string {
  try {
    return JSON.stringify(args) ?? "";
  } catch {
    return String(args);
  }
}

/** Tek mesajı dökümdeki bloklarına çevirir; görseller yer tutucuyla geçer. */
function messageParts(message: Message): string[] {
  if (message.role === "user") {
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("\n");
    return text.trim() ? [`[User]\n${text}`] : [];
  }
  if (message.role === "assistant") {
    const parts: string[] = [];
    for (const block of message.content) {
      if (block.type === "thinking" && block.thinking.trim()) {
        parts.push(`[Assistant thinking]\n${clip(block.thinking, BLOCK_MAX_CHARS)}`);
      } else if (block.type === "text" && block.text.trim()) {
        parts.push(`[Assistant]\n${block.text}`);
      } else if (block.type === "toolCall") {
        parts.push(
          `[Tool call: ${block.name}] ${clip(argsText(block.arguments), BLOCK_MAX_CHARS)}`,
        );
      }
    }
    return parts;
  }
  if (message.role !== "toolResult") return [];
  const text = message.content
    .map((c) => (c.type === "text" ? c.text : "[image]"))
    .join("\n")
    .trim();
  const label = message.isError ? "Tool error" : "Tool result";
  return [`[${label}: ${message.toolName}]\n${clip(text || "(empty)", RESULT_MAX_CHARS)}`];
}

/**
 * Konuşmayı düz metne çevirir. Ham mesaj gönderilmez: son asistan mesajındaki `advisor` çağrısının
 * henüz sonucu yoktur (Anthropic sonuçsuz araç çağrısını reddeder) ve danışman başka bir
 * sağlayıcı olabilir. Sınır aşılırsa ilk kullanıcı mesajı (görev) korunur, eski girdiler atılır.
 */
export function serializeTranscript(messages: Message[], maxChars: number): string {
  const parts = messages.flatMap(messageParts);
  const total = parts.reduce((sum, p) => sum + p.length + 2, 0);
  if (total <= maxChars) return parts.join("\n\n");
  const firstUser = parts.findIndex((p) => p.startsWith("[User]"));
  const head = firstUser >= 0 ? clip(parts[firstUser] ?? "", Math.floor(maxChars / 4)) : "";
  let budget = maxChars - head.length - 64;
  const tail: string[] = [];
  for (let i = parts.length - 1; i > firstUser; i--) {
    const part = parts[i] ?? "";
    if (part.length + 2 > budget) {
      // Son girdi tek başına sığmıyorsa kırpılarak da olsa girsin; danışman en son durumu görmeli.
      if (tail.length === 0 && budget > 1_000) tail.unshift(clip(part, budget - 2));
      break;
    }
    tail.unshift(part);
    budget -= part.length + 2;
  }
  const omitted = parts.length - tail.length - (head ? 1 : 0);
  return [head, `[… ${omitted} earlier entries omitted …]`, ...tail].filter(Boolean).join("\n\n");
}

/** Modelin bağlam penceresine göre dökümün karakter sınırı. */
export function transcriptBudget(model: Model<Api>): number {
  const tokens = Math.max(8_000, model.contextWindow - ADVICE_MAX_TOKENS - RESERVE_TOKENS);
  return tokens * CHARS_PER_TOKEN;
}

/** Oturumun etkin dalındaki mesajlar (sıkıştırma özeti dahil), LLM biçiminde. */
function sessionMessages(ctx: ExtensionContext): Message[] {
  const manager = ctx.sessionManager;
  const { messages } = buildSessionContext(manager.getEntries(), manager.getLeafId());
  return convertToLlm(messages);
}

/** Seçili modeli anahtarı olan modeller arasında bulur; görevin modeline düşülmez. */
function resolveModel(
  ctx: ExtensionContext,
  ref: { provider: string; id: string },
): Model<Api> | undefined {
  return ctx.modelRegistry
    .getAvailable()
    .find((m) => m.provider === ref.provider && m.id === ref.id);
}

export function advisorTool(options: AdvisorOptions, lang: Locale = "tr") {
  const d = dict(lang);
  return defineTool({
    name: ADVISOR_TOOL,
    label: d.agent.tool.advisor,
    description: d.prompt.advisorDesc,
    promptSnippet: d.prompt.advisorSnippet,
    promptGuidelines: [d.prompt.advisorGuideline],
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate, ctx) {
      const ref = options.model();
      if (!ref) throw new Error(d.errors.advisorOff);
      if (options.allowed && !options.allowed()) throw new Error(d.errors.advisorScheduledOff);
      const name = `${ref.provider}/${ref.id}`;
      const model = resolveModel(ctx, ref);
      if (!model) throw new Error(d.errors.advisorUnavailable.replace("{{model}}", () => name));
      const budget = transcriptBudget(model);
      const system = clip(ctx.getSystemPrompt(), Math.min(SYSTEM_MAX_CHARS, budget / 4));
      const transcript = serializeTranscript(sessionMessages(ctx), budget - system.length);
      const message = await ctx.modelRegistry
        .streamSimple(
          model,
          {
            systemPrompt: d.prompt.advisorSystem,
            messages: [
              {
                role: "user",
                content: d.prompt.advisorUser
                  .replace("{{system}}", () => system)
                  .replace("{{transcript}}", () => transcript),
                timestamp: Date.now(),
              },
            ],
          },
          {
            maxTokens: Math.min(ADVICE_MAX_TOKENS, model.maxTokens || ADVICE_MAX_TOKENS),
            ...(model.reasoning ? { reasoning: "high" as const } : {}),
            ...(signal ? { signal } : {}),
          },
        )
        .result();
      options.onUsage?.(message, name);
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        throw new Error(
          d.errors.advisorFailed.replace("{{error}}", () => message.errorMessage ?? "?"),
        );
      }
      const advice = contentText(message.content).trim();
      if (!advice) throw new Error(d.errors.advisorEmpty);
      return {
        content: [{ type: "text", text: advice }],
        details: { model: name },
      };
    },
  });
}
