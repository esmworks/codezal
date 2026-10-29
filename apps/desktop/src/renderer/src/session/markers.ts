import { type CatalogModel, type MarkerItem, parseModelLabel } from "@codezal/contracts";
import type { TFunction } from "i18next";
import type { IconName } from "../icons";
import { PERMISSION_ICONS, PERMISSION_KEYS, THINKING_KEYS } from "./chipMenus";

/** İşaret satırının çizim için çözülmüş hâli: ikon, metin ve ton. */
export interface MarkerView {
  icon: IconName;
  text: string;
  /** Başarısız özetleme nötr tonda yazılır: hata metni zaten "özetlenemedi" der. */
  tone: "muted" | "plain";
}

/** Mod kimliğinin ikonu; bilinmeyen değerde nötr "onay" ikonuna düşer. */
function permissionIcon(value: string | undefined): IconName {
  const mode = value ?? "ask";
  return Object.hasOwn(PERMISSION_ICONS, mode)
    ? PERMISSION_ICONS[mode as keyof typeof PERMISSION_ICONS]
    : "permAsk";
}

/** Model kimliğini ("sağlayıcı/kimlik") katalogdaki görünen adına çevirir; bulunamazsa kimliği yazar. */
function modelName(label: string, catalog: readonly CatalogModel[]): string {
  const ref = parseModelLabel(label);
  if (!ref) return label;
  const found = catalog.find((m) => m.provider === ref.provider && m.id === ref.id);
  return found?.name ?? label;
}

/** Geçiş metni: iki uç varsa "eski → yeni", tek uç varsa yalnız o (kayıt eksik olabilir). */
function fromTo(
  from: string | undefined,
  to: string | undefined,
  shown: (value: string) => string,
  t: TFunction,
): string {
  const head = from ? shown(from) : "";
  const tail = to ? shown(to) : "";
  if (head && tail) return t("marker.fromTo", { from: head, to: tail });
  return tail || head;
}

/**
 * İşaret satırının metnini ve ikonunu kurar (saf fonksiyon). Metin kayda gömülmez: kayıt yalnız
 * kimlikleri (`from`/`to`) taşır, gösterilecek adlar arayüz dilinden ve katalogdan gelir — dil
 * sonradan değişse eski kayıtlar da doğru okunur.
 */
export function markerView(
  item: MarkerItem,
  catalog: readonly CatalogModel[],
  t: TFunction,
): MarkerView {
  // `Object.hasOwn` şart: `in` prototip anahtarlarını da doğru sayar ve elle düzenlenmiş bir
  // kayıttaki "constructor" gibi bir değer sözlükte bulunmuş gibi görünürdü.
  const mode = (value: string): string =>
    Object.hasOwn(PERMISSION_KEYS, value)
      ? t(PERMISSION_KEYS[value as keyof typeof PERMISSION_KEYS])
      : value;
  const level = (value: string): string =>
    Object.hasOwn(THINKING_KEYS, value)
      ? t(THINKING_KEYS[value as keyof typeof THINKING_KEYS])
      : value;

  switch (item.kind) {
    case "model":
      return {
        icon: "code",
        tone: "plain",
        text: `${t("marker.model")} · ${fromTo(item.from, item.to, (v) => modelName(v, catalog), t)}`,
      };
    case "permission":
      return {
        // Bilinmeyen mod kimliğinde ikon da yedeklenir: `<Icon>` eşleşmeyen adda çizemez.
        icon: permissionIcon(item.to),
        tone: "plain",
        text: `${t("marker.permission")} · ${fromTo(item.from, item.to, mode, t)}`,
      };
    case "thinking":
      return {
        icon: "brain",
        tone: "plain",
        text: `${t("marker.thinking")} · ${fromTo(item.from, item.to, level, t)}`,
      };
    case "compact":
      return {
        icon: "collapse",
        tone: item.outcome === "failed" ? "muted" : "plain",
        text:
          item.outcome === "noop"
            ? t("marker.compactNoop")
            : item.outcome === "failed"
              ? t("marker.compactFailed")
              : t("marker.compact"),
      };
    case "unsent":
      return {
        // `stop` (içi boş kare) bu boyutta onay kutusuna benziyor; iptal `x` ile okunur.
        icon: "x",
        tone: "muted",
        text: item.to ? `${t("marker.unsent")} · ${item.to}` : t("marker.unsent"),
      };
  }
}
