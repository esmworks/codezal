import type { ExtensionUiRequest, ExtensionUiValue } from "@codezal/contracts";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";

interface Props {
  request: ExtensionUiRequest;
  /** Cevap: confirm boolean, select/input metin; iptalda null (confirm reddedilir). */
  onRespond: (value: ExtensionUiValue) => void;
}

/**
 * Eklenti `ctx.ui` kartı: `confirm`, `select` ve `input` istekleri burada sorulur. Pi'nin TUI
 * diyaloglarının masaüstü karşılığıdır; cevap `sessions:respondExtensionUi` ile eklentiye döner.
 * Kart tek başına yeterli bilgi taşımaz: isteği bir eklentinin yaptığı her zaman yazılıdır.
 */
export function ExtensionUiCard({ request, onRespond }: Props) {
  const { t } = useTranslation();
  const [text, setText] = useState("");

  return (
    <div className="flex flex-col gap-3 rounded-[12px] border border-accLine bg-card2 px-4 py-3">
      <div className="flex items-center gap-2 text-[13px]">
        <Icon name="sparkle" size={15} className="text-accTx" />
        <span className="font-medium text-tx">{t("extensionUi.title")}</span>
        <span className="text-tx3">· {t(`extensionUi.kind.${request.kind}`)}</span>
      </div>
      <span className="whitespace-pre-wrap text-[13px] font-medium text-tx">{request.title}</span>
      {request.message ? (
        <span className="whitespace-pre-wrap text-[13px] leading-[1.55] text-tx2">
          {request.message}
        </span>
      ) : null}
      {request.options && request.options.length > 0 ? (
        <div className="flex flex-col gap-2">
          {request.options.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onRespond(option)}
              className="rounded-[8px] border border-line bg-bg px-3 py-2 text-left text-[13px] text-tx transition-colors hover:border-accLine"
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      {request.kind === "input" ? (
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={request.placeholder ?? ""}
          className="w-full rounded-[8px] border border-line bg-bg px-3 py-2 text-[13px] text-tx outline-none placeholder:text-tx3 focus:border-accLine"
        />
      ) : null}
      <div className="flex items-center gap-2">
        {request.kind === "confirm" ? (
          <Button variant="primary" onClick={() => onRespond(true)}>
            <Icon name="check" size={13} stroke={2.2} /> {t("extensionUi.confirm")}
          </Button>
        ) : null}
        {request.kind === "input" ? (
          <Button
            variant="primary"
            disabled={text.trim().length === 0}
            onClick={() => onRespond(text)}
          >
            <Icon name="check" size={13} stroke={2.2} /> {t("extensionUi.send")}
          </Button>
        ) : null}
        <span className="flex-1" />
        <Button
          variant="secondary"
          onClick={() => onRespond(request.kind === "confirm" ? false : null)}
        >
          {t("extensionUi.cancel")}
        </Button>
      </div>
      <span className="text-[11px] text-tx3">{t("extensionUi.hint")}</span>
    </div>
  );
}
