import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { useShortcutHint } from "../shortcuts";
import { useApp } from "../stores/app";
import { type MenuEntry, useMenu } from "../stores/menu";
import { FIRST_BUTTON_LEFT, TITLE_BAR_HEIGHT } from "./titleBarMetrics";

/**
 * macOS trafik ışıklarının yanındaki sabit pencere kontrolleri: kenar çubuğu düğmesi, arama,
 * tema ve ayar. Işıklar soldan 18px, 34px'lik başlık şeridinde dikey ortada (window.ts
 * `trafficLightPosition`); düğmeler ışıklarla aynı ritimde dördüncü ve beşinci nokta gibi durur
 * (macOS 26: 14px daire, 23px adım).
 *
 * Kutu genişliği 22 + 1px aralık = 23px adım; merkezler 94, 117, 140… olur. Kutular 28px olsaydı
 * kutu araları eşit görünse de merkez aralığı 30'a çıkar, ikinci düğme sağa kaçmış görünürdü.
 *
 * Şeride düğme eklerken `titleBarMetrics.titleLeftInset` kendiliğinden büyür: içerik başlığı
 * (SessionScreen, AsistanTask) sabit sayıyla değil o değerle konumlanır.
 *
 * Sürüklenebilir bölge hesabı belge sırasına göre birleşir/çıkarılır; bu bileşen App'te en sonda
 * render edilir ki alttaki başlık şeritlerinin `drag` alanı düğmenin `no-drag` alanını ezmesin.
 */
export function TitleBar() {
  const { t } = useTranslation();
  const sidebarKey = useShortcutHint("toggle-sidebar");
  const searchKey = useShortcutHint("search");
  const settingsKey = useShortcutHint("settings");
  const { sidebarOpen, toggleSidebar, setSearchOpen, theme, toggleTheme, setSettingsOpen } =
    useApp();
  const openAt = useMenu((s) => s.openAt);

  const hesapMenu = (e: React.MouseEvent) =>
    openAt(e.currentTarget as HTMLElement, {
      items: [
        {
          label: t("common.settings"),
          icon: "gear",
          key: settingsKey,
          onSelect: () => setSettingsOpen(true),
        },
        {
          label: t("sidebar.shortcuts"),
          icon: "keys",
          onSelect: () => setSettingsOpen(true, "klavye"),
        },
      ] satisfies MenuEntry[],
    });

  return (
    <div
      className="fixed top-0 left-0 z-20 flex items-center gap-[1px] [-webkit-app-region:drag]"
      style={{ height: TITLE_BAR_HEIGHT, paddingLeft: FIRST_BUTTON_LEFT }}
    >
      <button
        type="button"
        onClick={toggleSidebar}
        title={t("shell.toggleSidebarTitle", { key: sidebarKey })}
        className={`flex h-[26px] w-[22px] items-center justify-center rounded-[7px] [-webkit-app-region:no-drag] hover:bg-hov hover:text-tx ${
          sidebarOpen ? "text-tx2" : "text-tx3"
        }`}
      >
        <Icon name="sidebar" size={15} stroke={1.7} />
      </button>
      {/* Ara düğmesi her zaman görünür: kenar çubuğu kapalıyken de komut paletine fareyle
          erişilebilsin (klavye kısayolu ⌘K zaten bağımsızdı). */}
      <button
        type="button"
        onClick={() => setSearchOpen(true)}
        title={t("shell.searchTitle", { key: searchKey })}
        className="flex h-[26px] w-[22px] items-center justify-center rounded-[7px] text-tx2 [-webkit-app-region:no-drag] hover:bg-hov hover:text-tx"
      >
        <Icon name="search" size={15} stroke={1.7} />
      </button>
      <button
        type="button"
        onClick={toggleTheme}
        title={t("shell.themeTitle")}
        className="flex h-[26px] w-[22px] items-center justify-center rounded-[7px] text-tx2 [-webkit-app-region:no-drag] hover:bg-hov hover:text-tx"
      >
        <Icon name={theme === "koyu" ? "sun" : "moon"} size={15} stroke={1.7} />
      </button>
      <button
        type="button"
        onClick={() => setSettingsOpen(true)}
        onContextMenu={hesapMenu}
        // Erişilebilir ad yalnız eylemi söyler; kısayol ipucu `title`da kalır (bkz. i18n notu).
        aria-label={t("shell.settingsLabel")}
        title={t("shell.settingsTitle", { key: settingsKey })}
        className="flex h-[26px] w-[22px] items-center justify-center rounded-[7px] text-tx2 [-webkit-app-region:no-drag] hover:bg-hov hover:text-tx"
      >
        <Icon name="gear" size={15} stroke={1.7} />
      </button>
    </div>
  );
}
