import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CopyButton } from "./CopyButton";
import { Icon } from "./Icon";

/**
 * Hata yüzeyi. ZCode'un hata çubuğu gibi **renksiz** durur: hata olduğunu kırmızı değil, baştaki
 * bilgi ikonu ve metnin kendisi söyler; eylemler sağda ince ayraçlarla ayrılmış metin düğmeleridir.
 * Kırmızı yalnız yıkıcı eylemlerde ve veri anlamında (diff, kota) kalır — hata mesajında değil.
 */

/** Eylemler kenarlıksız metin düğmesi: çubuğun kendisi zaten bir yüzey. */
const ACT = "shrink-0 text-[12px] text-tx3 transition-colors hover:text-tx";
/** "Ayrıntılar" komşularından bir ton parlak: çubuğun birincil eylemi odur. */
const ACT_LEAD = "shrink-0 text-[12px] font-medium text-tx2 transition-colors hover:text-tx";

/** Eylemleri ayıran ince dikey çizgi. */
function Sep() {
  return <span className="h-3.5 w-px shrink-0 bg-line2" aria-hidden="true" />;
}

/** Bu uzunluğun üstündeki mesaj tek satıra sığmaz: "Ayrıntılar" ile sarılabilir hâle gelir. */
const TRUNCATE_AT = 120;

interface Props {
  /** Çubukta görünen mesaj; sığmazsa kısaltılır, tamamı kopyalanabilir kalır. */
  text: string;
  /** "Ayrıntılar" açılınca görünen ham metin (yığın izi, komut çıktısı). */
  detail?: string | undefined;
  /** Sağdaki ek eylem (ör. "Günlüğü aç"). */
  action?: { label: string; run: () => void } | undefined;
  /** Verilirse sağda kapatma düğmesi çıkar. */
  onDismiss?: (() => void) | undefined;
  className?: string | undefined;
}

export function ErrorBar({ text, detail = "", action, onDismiss, className = "" }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const full = detail ? `${text}\n${detail}` : text;
  // Katlanmayı hak eden iki durum: altında gövde olması ya da tek satıra sığmayacak kadar uzun
  // olması. İkincisinde "Ayrıntılar" gövde açmaz, mesajın kendisini sarar.
  const expandable = detail !== "" || text.length > TRUNCATE_AT;
  return (
    <div className={`rounded-lg bg-chip px-3 py-2 ${className}`}>
      <div className="flex items-center gap-2.5">
        <Icon name="info" size={14} className="text-tx3" />
        {/* Kapalıyken tek satır: uzun hata yığını transkripti şişirmesin; tamamı "Ayrıntılar"da. */}
        <span
          className={`min-w-0 flex-1 text-[13px] leading-[1.45] text-tx2 ${
            open ? "break-words" : "truncate"
          }`}
          title={open ? undefined : text}
        >
          {text}
        </span>
        <div className="flex shrink-0 items-center gap-2.5">
          {expandable ? (
            <>
              <button type="button" onClick={() => setOpen((v) => !v)} className={ACT_LEAD}>
                {open ? t("common.hideDetails") : t("common.details")}
              </button>
              <Sep />
            </>
          ) : null}
          <CopyButton text={full} label size={12} className={`${ACT} flex items-center gap-1.5`} />
          {action ? (
            <>
              <Sep />
              <button type="button" onClick={action.run} className={ACT}>
                {action.label}
              </button>
            </>
          ) : null}
          {onDismiss ? (
            <>
              <Sep />
              <button
                type="button"
                onClick={onDismiss}
                title={t("common.close")}
                aria-label={t("common.close")}
                className="-my-0.5 flex h-5 w-5 items-center justify-center rounded-[5px] text-tx3 transition-colors hover:bg-hov hover:text-tx"
              >
                <Icon name="x" size={11} stroke={2} />
              </button>
            </>
          ) : null}
        </div>
      </div>
      {open && detail ? (
        <pre className="mt-2 max-h-[220px] overflow-auto border-line border-t pt-2 font-mono text-[12px] leading-[1.5] break-words whitespace-pre-wrap text-tx3">
          {detail}
        </pre>
      ) : null}
    </div>
  );
}

/**
 * Çok satırlı hata metnini çubuk için ikiye böler: ilk satır mesaj, kalanı ayrıntı. Sağlayıcı
 * hataları ilk satırda özeti, altında gövdeyi taşır; çubuk özeti gösterip gövdeyi katlar.
 * Ayrıntı yoksa boş dizedir (`exactOptionalPropertyTypes` altında da doğrudan yayılabilir).
 */
export function splitError(raw: string): { text: string; detail: string } {
  const [first = "", ...rest] = raw.trim().split("\n");
  return { text: first, detail: rest.join("\n").trim() };
}

/**
 * Satır içi hata: yüzey açmadan tek satırda duran sönük uyarı (form altı, kart içi not).
 * Çubuk kadar yer kaplaması istenmeyen yerlerde aynı dili sürdürür.
 */
export function ErrorText({ text, className = "" }: { text: string; className?: string }) {
  return (
    <div className={`flex items-start gap-2 text-[13px] text-tx2 ${className}`}>
      <Icon name="info" size={13} className="mt-[3px] text-tx3" />
      <span className="min-w-0 flex-1 break-words">{text}</span>
    </div>
  );
}
