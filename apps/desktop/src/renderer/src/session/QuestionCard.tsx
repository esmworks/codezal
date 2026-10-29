import type { QuestionAnswers, QuestionItem, QuestionRequest } from "@codezal/contracts";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";

interface Props {
  request: QuestionRequest;
  /** Soru başına seçilen etiketler + serbest metin; boş dizi soruyu yanıtsız geçer. */
  onAnswer: (answers: QuestionAnswers) => void;
}

const hasOptions = (q: QuestionItem) => !!q.options && q.options.length > 0;
/** Seçenek yoksa serbest metin zorunlu; `custom: false` yalnızca seçenekli soruda anlamlıdır. */
const customVisible = (q: QuestionItem) => (hasOptions(q) ? q.custom : true);

/**
 * Soru kartı (`question` aracı): model plan yazmadan ya da karar vermeden önce kullanıcıya
 * sorar. Cevaplar `questions:respond` ile döner; kart yanıtlanana dek tur bekler.
 */
export function QuestionCard({ request, onAnswer }: Props) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Record<number, string[]>>({});
  const [custom, setCustom] = useState<Record<number, string>>({});

  function toggle(qi: number, q: QuestionItem, label: string) {
    setSelected((prev) => {
      const cur = prev[qi] ?? [];
      if (q.multiple) {
        const next = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label];
        return { ...prev, [qi]: next };
      }
      // Tek seçimde de aynı seçeneğe tıklamak iptal eder; karar geri alınabilir kalır.
      return { ...prev, [qi]: cur.includes(label) ? [] : [label] };
    });
  }

  const answered = (qi: number, q: QuestionItem): boolean => {
    if ((selected[qi]?.length ?? 0) > 0) return true;
    return customVisible(q) && (custom[qi] ?? "").trim().length > 0;
  };
  const allAnswered = request.questions.every((q, qi) => answered(qi, q));

  function submit() {
    onAnswer(
      request.questions.map((q, qi) => {
        const picked = selected[qi] ?? [];
        const text = customVisible(q) ? (custom[qi] ?? "").trim() : "";
        return text ? [...picked, text] : picked;
      }),
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-[12px] border border-accLine bg-card2 px-4 py-3">
      <div className="flex items-center gap-2 text-[13px]">
        <Icon name="question" size={15} className="text-accTx" />
        <span className="font-medium text-tx">{t("question.title")}</span>
        {request.questions.length > 1 ? (
          <span className="text-tx3">· {request.questions.length}</span>
        ) : null}
      </div>
      <div className="flex max-h-[420px] flex-col gap-4 overflow-y-auto">
        {request.questions.map((q, qi) => (
          <div key={qi} className="flex flex-col gap-2">
            <span className="whitespace-pre-wrap text-[13px] font-medium text-tx">
              {q.question}
            </span>
            {q.multiple ? (
              <span className="text-[12px] text-tx3">{t("question.multipleHint")}</span>
            ) : null}
            {q.options?.map((opt) => {
              const isSel = (selected[qi] ?? []).includes(opt.label);
              return (
                <button
                  key={`${qi}-${opt.label}`}
                  type="button"
                  onClick={() => toggle(qi, q, opt.label)}
                  className={`flex items-start gap-2 rounded-[8px] border px-3 py-2 text-left text-[13px] transition-colors ${
                    isSel
                      ? "border-accLine bg-hov text-tx"
                      : "border-line bg-bg text-tx hover:border-accLine"
                  }`}
                >
                  <span
                    className={`mt-[1px] flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border ${
                      isSel ? "border-accTx bg-accTx text-bg" : "border-line"
                    }`}
                  >
                    {isSel ? <Icon name="check" size={11} stroke={2.4} /> : null}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-medium">{opt.label}</span>
                    {opt.description ? (
                      <span className="text-[12px] leading-[1.5] text-tx3">{opt.description}</span>
                    ) : null}
                  </span>
                </button>
              );
            })}
            {customVisible(q) ? (
              <textarea
                value={custom[qi] ?? ""}
                onChange={(e) => setCustom((p) => ({ ...p, [qi]: e.target.value }))}
                rows={hasOptions(q) ? 2 : 3}
                placeholder={
                  hasOptions(q) ? t("question.customPlaceholder") : t("question.placeholder")
                }
                className="w-full resize-none rounded-[8px] border border-line bg-bg px-3 py-2 text-[13px] leading-[1.5] text-tx outline-none placeholder:text-tx3 focus:border-accLine"
              />
            ) : null}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="primary" disabled={!allAnswered} onClick={submit}>
          <Icon name="check" size={13} stroke={2.2} /> {t("question.send")}
        </Button>
        <span className="flex-1" />
        <Button variant="secondary" onClick={() => onAnswer(request.questions.map(() => []))}>
          {t("question.skip")}
        </Button>
      </div>
    </div>
  );
}
