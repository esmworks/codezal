import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import type { IconName } from "../icons";
import { escapeClosesSettings } from "../lib/escapeLayers";
import { matchesFold } from "../lib/searchText";
import { useApp } from "../stores/app";
import {
  AccountPage,
  AgentsPage,
  ArchivePage,
  ConnectionPage,
  ConnectorsPage,
  DiagnosticsPage,
  GenelPage,
  MemoryPage,
  PersonalPage,
  ReviewPage,
  ShortcutsPage,
  SkillsPage,
  UsagePage,
  useSettingsPatch,
  WorktreePage,
} from "./pages/index";

/** Sayfa anahtarları: label çevrildiği için gezinme anahtar üzerinden yapılır. */
export type SettingsPageKey =
  | "genel"
  | "klavye"
  | "kisisellestirme"
  | "bellek"
  | "beceriler"
  | "ajanlar"
  | "baglayicilar"
  | "kullanim"
  | "baglanti"
  | "hesap"
  | "kodInceleme"
  | "worktree"
  | "arsiv"
  | "tanilama";

type NavItem = { key: SettingsPageKey; label: string; icon: IconName; keywords: string };

/** Ayarlar kaplaması: sol menü, arama, sayfa geçişi (TODO 3). */
export function SettingsOverlay() {
  const { settingsPage, setSettingsOpen } = useApp();
  const { t } = useTranslation();
  // Sayfa store'da tutulur: kaplama kapanıp açılınca (⌘,) son bakılan sayfaya döner; yerel
  // durumda kalsaydı yalnız derin bağlantıyla açılan sayfa hatırlanıyordu.
  const page = settingsPage as SettingsPageKey;
  const [q, setQ] = useState("");
  const [s, patch] = useSettingsPatch();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Üstte bir katman varsa Escape **onu** kapatır. Hepsi pencere dinleyicisi olduğu için
      // aksi hâlde tek basış onay penceresini (ya da sayfa içi form modalını) ve ayarları
      // birlikte kapatıyor, kaydedilmemiş form içeriği kayboluyordu.
      if (!escapeClosesSettings(e)) return;
      e.preventDefault();
      setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSettingsOpen]);

  const item = (key: SettingsPageKey, icon: IconName): NavItem => ({
    key,
    label: t(`settings.nav.${key}.label`),
    icon,
    keywords: t(`settings.nav.${key}.keywords`),
  });
  // Sıra tasarımdaki dört grubu (Tercihler, Yönetim, Kodlama, Arşiv) korur. Ajanı genişleten
  // sayfalar (alt ajan, beceri, MCP) Tercihler'i şişirmesin diye kendi grubunda durur; bellek
  // "seni tanıma" ayarı olduğu için Kişiselleştirme'nin yanındadır.
  const nav: Array<{ title: string; items: NavItem[] }> = [
    {
      title: t("settings.navGroup.tercihler"),
      items: [
        item("genel", "gear"),
        item("klavye", "keys"),
        item("kisisellestirme", "pen"),
        item("bellek", "brain"),
      ],
    },
    {
      title: t("settings.navGroup.yetenekler"),
      items: [item("ajanlar", "bot"), item("beceriler", "sparkle"), item("baglayicilar", "mcp")],
    },
    {
      title: t("settings.navGroup.yonetim"),
      items: [
        item("kullanim", "chart"),
        item("baglanti", "globe"),
        item("hesap", "user"),
        item("tanilama", "bug"),
      ],
    },
    {
      title: t("settings.navGroup.kodlama"),
      items: [item("kodInceleme", "code"), item("worktree", "branch")],
    },
    {
      title: t("settings.navGroup.arsiv"),
      items: [item("arsiv", "archive")],
    },
  ];

  // Katlama `searchText`ten: Türkçe küçültme "OpenAI"yi `openaı` yapıp `openai`yi kaçırıyordu.
  const needle = q.trim();
  const groups = nav
    .map((g) => ({
      ...g,
      items: g.items.filter((i) => !needle || matchesFold(`${i.label} ${i.keywords}`, needle)),
    }))
    .filter((g) => g.items.length > 0);
  const currentLabel = nav.flatMap((g) => g.items).find((i) => i.key === page)?.label ?? "";

  let body: React.ReactNode = null;
  if (!s) body = <div className="text-[13px] text-tx3">{t("settings.loading")}</div>;
  else if (page === "genel") body = <GenelPage s={s} patch={patch} />;
  else if (page === "klavye") body = <ShortcutsPage s={s} patch={patch} />;
  else if (page === "kisisellestirme") body = <PersonalPage s={s} patch={patch} />;
  else if (page === "bellek") body = <MemoryPage />;
  else if (page === "beceriler") body = <SkillsPage />;
  else if (page === "ajanlar") body = <AgentsPage s={s} patch={patch} />;
  else if (page === "baglayicilar") body = <ConnectorsPage />;
  else if (page === "kullanim") body = <UsagePage s={s} patch={patch} />;
  else if (page === "baglanti") body = <ConnectionPage s={s} patch={patch} />;
  else if (page === "hesap") body = <AccountPage s={s} patch={patch} />;
  else if (page === "kodInceleme") body = <ReviewPage s={s} patch={patch} />;
  else if (page === "worktree") body = <WorktreePage s={s} patch={patch} />;
  else if (page === "arsiv") body = <ArchivePage s={s} patch={patch} />;
  else if (page === "tanilama") body = <DiagnosticsPage s={s} patch={patch} />;

  return (
    <div className="fixed inset-0 z-[70] flex bg-bg">
      <div className="flex w-[250px] shrink-0 flex-col gap-[14px] overflow-y-auto border-r border-line bg-bg2 px-3 pt-[46px] pb-[14px]">
        <button
          type="button"
          onClick={() => setSettingsOpen(false)}
          className="flex items-center gap-[9px] rounded-[7px] px-2 py-[6px] text-left text-[14px] text-tx hover:bg-selHov"
        >
          <Icon name="chevronLeft" size={15} />
          {t("settings.back")}
        </button>
        <div className="flex items-center gap-2 rounded-[8px] bg-sel px-[10px] py-[6px] text-[13px] text-tx3">
          <Icon name="search" size={14} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("settings.searchPlaceholder")}
            className="min-w-0 flex-1 bg-transparent text-tx outline-none placeholder:text-tx3"
          />
        </div>
        {groups.map((g) => (
          <div key={g.title} className="flex flex-col gap-[2px]">
            <div className="px-2 pt-[2px] pb-1 text-[12px] uppercase tracking-[0.06em] text-tx3">
              {g.title}
            </div>
            {g.items.map((i) => (
              <button
                type="button"
                key={i.key}
                onClick={() => setSettingsOpen(true, i.key)}
                className={`flex items-center gap-[9px] rounded-[7px] px-2 py-[6px] text-left text-[13px] text-tx hover:bg-selHov ${page === i.key ? "bg-sel" : ""}`}
              >
                <Icon name={i.icon} size={15} className="shrink-0 text-tx2" />
                {i.label}
              </button>
            ))}
          </div>
        ))}
      </div>
      {/* items-start şart: esneyen (stretch) sütun kabın yüksekliğinde kalıp
          içeriği taşırdığı için Chrome alttaki 60px dolguyu kaydırma alanına
          katmıyor, son kart pencerenin dibine yapışıyordu. */}
      <div className="flex min-w-0 flex-1 items-start justify-center overflow-y-auto px-10 pt-[26px] pb-[60px]">
        <div className="flex w-full max-w-[760px] flex-col gap-[26px]">
          <div className="text-[20px] font-semibold tracking-[-0.01em]">{currentLabel}</div>
          {body}
        </div>
      </div>
    </div>
  );
}
