import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "../lib/i18n";
import { humanizeError, toast } from "../stores/toast";
import { Icon } from "./Icon";

/** Onay durumunun ekranda kaldığı süre; tıklamanın görüldüğüne yetecek kadar kısa. */
const RESET_MS = 1400;

/**
 * Panoya kopyalama geri bildirimi: kopyalandıktan sonra kısa süre `copied` doğru kalır.
 * Düğme kendi biçimini kuranlar (araç çubuğu, metin düğmesi) bunu doğrudan kullanır.
 */
export function useCopy() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Düğme kopyalamadan hemen sonra kalkarsa zamanlayıcı boşa çalışmasın.
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (text: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), RESET_MS);
      })
      // Pano erişimi başarısız olursa tıklama sessiz kalmasın.
      .catch((e: unknown) => toast.error(humanizeError(e)));
  };
  return { copied, copy };
}

interface Props {
  /** Panoya yazılacak metin. */
  text: string;
  /** İkonun yanında "Kopyala" metni de görünsün. */
  label?: boolean;
  size?: number;
  stroke?: number;
  className?: string;
}

/** Kopyala düğmesi; kopyalanınca ikon tike, metin ve ipucu "Kopyalandı"ya döner. */
export function CopyButton({ text, label = false, size = 14, stroke = 1.6, className }: Props) {
  const { t } = useTranslation();
  const { copied, copy } = useCopy();
  const title = copied ? t("common.copied") : t("common.copy");
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={() => copy(text)}
      className={className}
    >
      <Icon
        name={copied ? "check" : "copyDoc"}
        size={size}
        stroke={stroke}
        className={copied ? "text-green" : ""}
      />
      {label ? <span className={copied ? "text-green" : ""}>{title}</span> : null}
    </button>
  );
}

/**
 * Menü öğeleri gibi kendi durumunu gösteremeyen kopyalama noktaları için: menü kapandığından
 * geri bildirim bildirim kartıyla verilir.
 */
export function copyWithToast(text: string) {
  void navigator.clipboard
    .writeText(text)
    .then(() => toast.success(i18n.t("common.copied")))
    .catch((e: unknown) => toast.error(humanizeError(e)));
}
