import type { OpenWithApp } from "@codezal/contracts";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { IconName } from "../icons";
import { type MenuItem, useMenu } from "../stores/menu";
import { useOpenWith } from "../stores/openWith";
import { useSettings } from "../stores/settings";
import { Icon } from "./Icon";

/** Simgesi alınamayan uygulama için tür glifi. */
function fallbackIcon(kind: OpenWithApp["kind"]): IconName {
  if (kind === "finder") return "folder";
  return kind === "editor" ? "code" : "terminal";
}

function AppGlyph({ app, size = 15 }: { app: OpenWithApp; size?: number }) {
  if (app.iconDataUrl) {
    return (
      <img
        src={app.iconDataUrl}
        alt=""
        draggable={false}
        style={{ width: size, height: size }}
        className="shrink-0 object-contain"
      />
    );
  }
  return <Icon name={fallbackIcon(app.kind)} size={size} className="text-tx2" />;
}

interface Props {
  cwd: string;
}

/**
 * Üst şeritteki "Aç" bölünmüş düğmesi: sol taraf son kullanılan uygulamada açar,
 * chevron kurulu uygulamaların menüsünü açar. Hedef her zaman proje klasörüdür.
 */
export function OpenWithButton({ cwd }: Props) {
  const { t } = useTranslation();
  const apps = useOpenWith((state) => state.apps);
  const load = useOpenWith((state) => state.load);
  const open = useOpenWith((state) => state.open);
  const openAt = useMenu((state) => state.openAt);
  const chosen = useSettings((state) => state.settings?.openWithApp ?? "");

  useEffect(() => {
    void load();
  }, [load]);

  // Seçili uygulama kaldırılmış olabilir: o zaman ilk satıra düşülür, düğme çalışır kalır.
  const preferred = apps.find((app) => app.id === chosen) ?? apps[0];
  if (!preferred) return null;

  const nameOf = (app: OpenWithApp) =>
    app.kind === "finder" ? t("openWith.fileManager") : app.name;

  const itemsFor = (list: OpenWithApp[]): MenuItem[] => {
    const items: MenuItem[] = [];
    let previousKind: OpenWithApp["kind"] | undefined;
    for (const app of list) {
      const item: MenuItem = {
        label: nameOf(app),
        icon: fallbackIcon(app.kind),
        // Gruplar arasında ayırıcı: dosya yöneticisi | editörler | terminaller.
        top: previousKind !== undefined && previousKind !== app.kind,
        onSelect: () => void open(app.id, cwd),
      };
      // Gerçek simge varsa glif yerine o çizilir.
      if (app.iconDataUrl) item.iconSrc = app.iconDataUrl;
      items.push(item);
      previousKind = app.kind;
    }
    return items;
  };

  return (
    <div className="flex h-[26px] items-center rounded-[6px] [-webkit-app-region:no-drag]">
      <button
        type="button"
        onClick={() => void open(preferred.id, cwd)}
        title={t("openWith.openIn", { app: nameOf(preferred) })}
        aria-label={t("openWith.openIn", { app: nameOf(preferred) })}
        className="flex h-[26px] w-[26px] items-center justify-center rounded-l-[6px] hover:bg-hov"
      >
        <AppGlyph app={preferred} />
      </button>
      <button
        type="button"
        onClick={(event) => {
          // Menü çapanın yerine göre konumlanır; React olayı bıraktıktan sonra
          // `currentTarget` okunamayacağı için öğe şimdiden saklanır.
          const anchor = event.currentTarget;
          void load().then((list) => openAt(anchor, { minWidth: 210, items: itemsFor(list) }));
        }}
        title={t("openWith.menuLabel")}
        aria-label={t("openWith.menuLabel")}
        className="flex h-[26px] w-[15px] items-center justify-center rounded-r-[6px] text-tx3 hover:bg-hov hover:text-tx"
      >
        <Icon name="chevronDown" size={11} />
      </button>
    </div>
  );
}
