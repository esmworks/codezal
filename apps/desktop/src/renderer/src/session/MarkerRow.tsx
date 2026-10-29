import type { MarkerItem } from "@codezal/contracts";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { useModels } from "../stores/models";
import { markerView } from "./markers";

/**
 * Komut sonucu işareti (ZCode'un timelineMarker satırı): sohbetin ortasında iki ince çizgi
 * arasında ortalanmış tek satır. Model/izin/seviye değişimini ve özetleme sonucunu anlatır;
 * kullanıcı balonu üretmez (komut modele gitmez), bu yüzden sohbette görünen tek iz bu satırdır.
 * Metin kurma `markers.ts`'te saf tutulur; burada yalnız çizim var.
 */
export function MarkerRow({ item }: { item: MarkerItem }) {
  const { t } = useTranslation();
  const catalog = useModels((s) => s.catalog);
  const view = markerView(item, catalog, t);
  const tone = view.tone === "muted" ? "text-tx3" : "text-tx2";
  return (
    <div className="flex items-center gap-3 py-[2px] text-[12px]" role="status">
      <span className="h-px min-w-6 flex-1 bg-line" aria-hidden />
      {/* Uzun metin (gönderilmeyen mesajın başı) sütundan taşmasın: kısalır, tamamı ipucunda. */}
      <span className={`flex min-w-0 items-center gap-[6px] ${tone}`} title={view.text}>
        <Icon name={view.icon} size={13} className="shrink-0" />
        <span className="truncate">{view.text}</span>
      </span>
      <span className="h-px min-w-6 flex-1 bg-line" aria-hidden />
    </div>
  );
}
