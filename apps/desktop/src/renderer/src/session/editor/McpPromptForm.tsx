import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/Button";
import { Modal } from "../../components/Modal";
import type { SlashPrompt } from "../../lib/slashSearch";

const INPUT =
  "min-w-0 rounded-[9px] border border-line2 bg-card px-[11px] py-[6px] text-[13px] text-tx outline-none placeholder:text-tx3";

/**
 * Argümanlı servis istemi için basit form: her argüman bir satır. Zorunlu alanlar dolmadan
 * gönderilemez. Modal gövdeye taşınır: kompozerdeki `/` paneli kapalıyken `inert`tir ve
 * dönüşümlü kapsayıcı `fixed` konumu bozabilir.
 */
export function McpPromptForm({
  title,
  prompt,
  onSubmit,
  onClose,
}: {
  title: string;
  prompt: SlashPrompt;
  onSubmit: (args: Record<string, string>) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  // Modal açılışta odağı karta verir (ebeveyn efekti çocuktan sonra çalışır); ilk alan bir kare
  // sonra odak alır ki kullanıcı doğrudan yazmaya başlasın.
  useEffect(() => {
    const frame = requestAnimationFrame(() => first.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  const missing = prompt.arguments.some((a) => a.required && !values[a.name]?.trim());

  const submit = async () => {
    if (missing || busy) return;
    setBusy(true);
    try {
      // Boş isteğe bağlı alan gönderilmez: sunucu varsayılanını kullansın.
      const args: Record<string, string> = {};
      for (const a of prompt.arguments) {
        const value = values[a.name]?.trim();
        if (value) args[a.name] = value;
      }
      await onSubmit(args);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <span className="flex-1 text-[12px] text-tx3">{t("composer.slash.promptHint")}</span>
          <Button size="sm" onClick={onClose} disabled={busy}>
            {t("composer.slash.promptCancel")}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={missing || busy}
            onClick={() => void submit()}
          >
            {busy ? t("composer.slash.promptLoading") : t("composer.slash.promptSubmit")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-[10px]">
        {prompt.arguments.map((a, index) => (
          <label key={a.name} className="flex flex-col gap-1">
            <span className="text-[13px] text-tx2">
              {a.name}
              {a.required ? (
                <span className="text-tx3"> · {t("composer.slash.promptRequired")}</span>
              ) : null}
            </span>
            <input
              ref={index === 0 ? first : undefined}
              value={values[a.name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [a.name]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) void submit();
              }}
              placeholder={a.description}
              className={INPUT}
            />
          </label>
        ))}
      </div>
    </Modal>,
    document.body,
  );
}
