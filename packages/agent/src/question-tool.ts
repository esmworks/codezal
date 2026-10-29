import type { QuestionAnswers, QuestionItem, QuestionRequest } from "@codezal/contracts";
import { dict, type Locale } from "@codezal/i18n";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

export const QUESTION_TOOL = "question";

/** Engine oturum durumunu bu köprüyle açar; araç Pi oturumunu ve izin yöneticisini bilmez. */
export interface QuestionBridge {
  /** Kullanıcıya sorar; gözetimsiz oturumda boş yanıt döner ve tur asılı kalmaz. */
  ask(questions: QuestionItem[]): Promise<QuestionAnswers>;
}

interface PendingQuestion {
  request: QuestionRequest;
  resolve: (answers: QuestionAnswers) => void;
}

let counter = 0;

/**
 * Soruları bekletir ve cevapları toplar (izin yöneticisinin soru karşılığı). Kart renderer'da,
 * cevap `questions:respond` ile döner; iptal ve kapanışta bekleyenler boş yanıtla çözülür.
 */
export class QuestionGate {
  readonly #pending = new Map<string, PendingQuestion>();
  readonly #onRequest: (request: QuestionRequest) => void;

  constructor(onRequest: (request: QuestionRequest) => void) {
    this.#onRequest = onRequest;
  }

  request(sessionId: string, questions: QuestionItem[]): Promise<QuestionAnswers> {
    const requestId = `question-${Date.now()}-${++counter}`;
    const request: QuestionRequest = { requestId, sessionId, questions };
    return new Promise<QuestionAnswers>((resolve) => {
      this.#pending.set(requestId, { request, resolve });
      this.#onRequest(request);
    }).finally(() => this.#pending.delete(requestId));
  }

  respond(requestId: string, answers: QuestionAnswers): boolean {
    const p = this.#pending.get(requestId);
    if (!p) return false;
    p.resolve(answers);
    return true;
  }

  /** Tur iptal edilince ya da oturum kapanınca bekleyen sorular yanıtsız çözülür. */
  rejectAll(sessionId: string): void {
    for (const [id, p] of this.#pending) {
      if (p.request.sessionId !== sessionId) continue;
      p.resolve(p.request.questions.map(() => []));
      this.#pending.delete(id);
    }
  }

  pendingFor(sessionId: string): QuestionRequest | undefined {
    for (const p of this.#pending.values()) if (p.request.sessionId === sessionId) return p.request;
    return undefined;
  }
}

/**
 * Soru aracı: model çalışma sırasında kullanıcıya çoktan seçmeli soru sorar; özellikle plan
 * yazmadan ya da büyük bir değişikliğe başlamadan önce belirsizliği netleştirmek içindir.
 * Seçenekler isteğe bağlıdır, `custom` açıkken kullanıcı kendi yanıtını yazar. Kart cevaplanana
 * dek araç bekler (`executionMode: "sequential"`), bu yüzden model soru sorarken aynı turda
 * dosyaya dokunamaz.
 */
export function questionTool(bridge: QuestionBridge, lang: Locale = "tr") {
  const d = dict(lang);
  const q = d.question;
  return defineTool({
    name: QUESTION_TOOL,
    label: d.agent.tool.question,
    description: d.prompt.questionDesc,
    promptSnippet: d.prompt.questionSnippet,
    promptGuidelines: [d.prompt.questionGuideline],
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          question: Type.String({ description: q.questionField }),
          options: Type.Optional(
            Type.Array(
              Type.Object({
                label: Type.String({ description: q.optionLabel }),
                description: Type.Optional(Type.String({ description: q.optionDescription })),
              }),
            ),
          ),
          multiple: Type.Optional(Type.Boolean({ description: q.multipleField })),
          custom: Type.Optional(Type.Boolean({ description: q.customField })),
        }),
      ),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      // Sözleşme alanları burada doldurulur: Pi şeması Typebox'tır, zod varsayılanı uygulanmaz.
      const questions: QuestionItem[] = params.questions.map((item) => {
        const options = item.options && item.options.length > 0 ? item.options : undefined;
        return {
          question: item.question,
          ...(options ? { options } : {}),
          multiple: item.multiple ?? false,
          // Seçenek yoksa serbest metin zorunlu; yoksa kullanıcı yanıt veremezdi.
          custom: options ? (item.custom ?? true) : true,
        };
      });
      const answers = await bridge.ask(questions);
      const text = questions
        .map((item, i) => {
          const picked = answers[i] ?? [];
          return `- ${item.question}\n  -> ${picked.length > 0 ? picked.join(", ") : q.noAnswer}`;
        })
        .join("\n");
      return {
        content: [{ type: "text" as const, text }],
        details: { answers },
      };
    },
  });
}
