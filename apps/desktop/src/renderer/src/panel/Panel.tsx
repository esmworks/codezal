import type { TranslationKey } from "@codezal/i18n";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { Resizer } from "../components/Resizer";
import { SlidePane } from "../components/SlidePane";
import type { IconName } from "../icons";
import { padRight } from "../lib/platform";
import { useApp } from "../stores/app";
import { useMenu } from "../stores/menu";
import {
  BASE_PANEL_TABS,
  type BasePanelTab,
  baseTabOf,
  type PanelTab,
  termKeyOf,
  usePanel,
} from "../stores/panel";
import { AuditTab } from "./AuditTab";
import { BrowserTab } from "./BrowserTab";
import { ChangesTab } from "./ChangesTab";
import { FilesTab } from "./FilesTab";
import { JobsTab } from "./JobsTab";
import { killTerminal, TerminalTab } from "./TerminalTab";

const ICONS: Record<BasePanelTab, IconName> = {
  Tarayıcı: "globe",
  Dosyalar: "file",
  Değişiklikler: "changes",
  Bulgular: "shield",
  İşler: "list",
};

const TAB_KEYS: Record<BasePanelTab, TranslationKey> = {
  Tarayıcı: "panel.browser",
  Dosyalar: "panel.files",
  Değişiklikler: "panel.changes",
  Bulgular: "panel.findings",
  İşler: "panel.jobs",
};

interface Props {
  /** Panel açık mı; kapalıyken kayarak çekilir, animasyon bitince içerik sökülür. */
  open: boolean;
  cwd: string;
  /** Bulgular sekmesi denetim run'ını bu oturumdan okur. */
  sessionId: string;
  /**
   * Şu an açılabilen sekmeler: temel sekmeler + içeriği olan sonuç sekmeleri (denetim run'ı,
   * alt ajan koşusu). Palet ve boş durum karoları bunu kullanır; içeriği tükenen sekme kapanır.
   * Terminaller burada yer almaz: her biri paletten "Yeni terminal" ile açılan kendi sekmesidir.
   */
  available?: BasePanelTab[];
  /** Kullanılabilir genişlik (pencere − kenar çubuğu); sohbet için 520px bırakılır. */
  avail: number;
}

/** Sağ panel: sekmeler, ekleme menüsü, kapatma, tam ekran, boş durum kartları, sürükleme (TODO 2). */
export function Panel({ open, cwd, sessionId, avail, available = BASE_PANEL_TABS }: Props) {
  const { t } = useTranslation();
  const { panelWidth, setPanelWidth, togglePanel } = useApp();
  const {
    tabs,
    active,
    terms,
    full,
    setFull,
    openTab,
    closeTab,
    setActive,
    toggleFull,
    addTerminal,
  } = usePanel();
  const openAt = useMenu((s) => s.openAt);
  const max = Math.max(260, avail - 520);
  // Tam ekranda panel kalan tüm alanı kaplar; kapanış animasyonu bu genişlikten 0'a iner.
  const width = full ? avail : Math.max(200, Math.min(panelWidth, max));

  // İçeriği tükenen sonuç sekmesi (denetim run'ı olmayan "Bulgular", işi olmayan "İşler")
  // açık kalmasın: palet dışına düşen sekme kapatılır, boş yüzey kullanıcıya gösterilmez.
  // Terminal sekmeleri palete hiç girmez: içerikleri kendi kabuklarıdır.
  const availableKey = available.join("|");
  useEffect(() => {
    const allowed = new Set(availableKey.split("|"));
    for (const tab of usePanel.getState().tabs) {
      if (!allowed.has(tab) && baseTabOf(tab)) closeTab(tab);
    }
  }, [availableKey, closeTab]);

  /** Şeritteki ad: terminal sekmelerinin adı sıra numarasından gelir ("Terminal 2"). */
  const labelOf = (tab: PanelTab): string => {
    const key = termKeyOf(tab);
    if (key) return t("terminal.tab", { n: terms[key]?.num ?? 1 });
    return t(TAB_KEYS[tab as BasePanelTab]);
  };
  const iconOf = (tab: PanelTab): IconName =>
    termKeyOf(tab) ? "terminal" : ICONS[tab as BasePanelTab];

  // Palet ve boş durum karoları: sekme açan girdiler + "Yeni terminal" (eski Terminal sekmesinin
  // yeri). Sıra korunur: terminal, Tarayıcı'nın hemen ardında durur.
  const entries: { id: string; label: string; icon: IconName; run: () => void; check: boolean }[] =
    available.map((tab) => ({
      id: tab,
      label: t(TAB_KEYS[tab]),
      icon: ICONS[tab],
      run: () => openTab(tab),
      check: tabs.includes(tab),
    }));
  entries.splice(Math.max(0, entries.findIndex((e) => e.id === "Tarayıcı") + 1), 0, {
    id: "terminal",
    label: t("terminal.new"),
    icon: "terminal",
    run: () => addTerminal(cwd),
    check: false,
  });

  const addMenu = (e: React.MouseEvent) =>
    openAt(e.currentTarget as HTMLElement, {
      items: entries.map((entry) => ({
        label: entry.label,
        icon: entry.icon,
        check: entry.check,
        onSelect: entry.run,
      })),
    });

  /** Sekmeyi kapatır; terminal sekmesiyse kabuğu da öldürür. */
  const close = (tab: PanelTab) => {
    const key = termKeyOf(tab);
    if (key) killTerminal(key);
    closeTab(tab);
  };

  const btn =
    "flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px] text-tx3 hover:bg-hov hover:text-tx";

  // Kapanış bitince tam ekran modu bırakılır; panel yeniden normal genişlikte açılır.
  return (
    <SlidePane
      open={open}
      width={width}
      onClosed={() => setFull(false)}
      handle={
        !full ? (
          <Resizer
            side="left"
            sign={-1}
            value={panelWidth}
            min={200}
            max={max}
            onChange={setPanelWidth}
          />
        ) : null
      }
    >
      <div
        className={`flex h-full min-h-0 min-w-0 flex-col bg-bg ${full ? "" : "border-l border-line"}`}
      >
        <div
          className="flex h-12 shrink-0 items-center gap-1 px-3 [-webkit-app-region:drag]"
          style={{ paddingRight: padRight(12) }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-[2px] overflow-x-auto [-webkit-app-region:no-drag]">
            {tabs.map((tab) => {
              const on = tab === active;
              const key = termKeyOf(tab);
              const label = labelOf(tab);
              return (
                <div
                  key={tab}
                  onClick={() => setActive(tab)}
                  className={`group flex h-7 max-w-[170px] shrink-0 items-center gap-[7px] rounded-[8px] pr-[7px] pl-[9px] text-[13px] ${
                    on ? "bg-chip text-tx" : "text-tx3 hover:text-tx"
                  } ${key && terms[key]?.exited ? "opacity-55" : ""}`}
                >
                  <Icon name={iconOf(tab)} size={14} />
                  <span className="truncate">{label}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      close(tab);
                    }}
                    // İkon `aria-hidden`; düğmenin erişilebilir adı bu yüzden burada verilir.
                    aria-label={t("panel.closeTab", { tab: label })}
                    className={`flex h-4 w-4 items-center justify-center rounded-[5px] text-tx3 hover:bg-line2 hover:text-tx ${on ? "" : "invisible group-hover:visible"}`}
                  >
                    <Icon name="x" size={11} stroke={2} />
                  </button>
                </div>
              );
            })}
            <button type="button" onClick={addMenu} title={t("panel.newTab")} className={btn}>
              <Icon name="plus" size={14} stroke={2} />
            </button>
          </div>
          <button
            type="button"
            onClick={toggleFull}
            title={full ? t("panel.collapse") : t("panel.expand")}
            className={`${btn} [-webkit-app-region:no-drag]`}
          >
            <Icon name={full ? "collapse" : "expand"} size={14} />
          </button>
          <button
            type="button"
            onClick={togglePanel}
            title={t("panel.close")}
            className={`${btn} [-webkit-app-region:no-drag]`}
          >
            {/* Kapatma çarpısı: panel simgesi başlıktaki aç/kapa düğmesiyle karışıyordu. */}
            <Icon name="x" size={15} stroke={1.9} />
          </button>
        </div>
        {tabs.length === 0 ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6">
            <div className="flex flex-wrap justify-center gap-[10px]">
              {entries.map((entry) => (
                <button
                  type="button"
                  key={entry.id}
                  onClick={entry.run}
                  className="flex h-[104px] w-[118px] flex-col items-center justify-center gap-[11px] rounded-[12px] border border-line text-tx2 hover:border-line2 hover:text-tx"
                >
                  <Icon name={entry.icon} size={19} stroke={1.6} />
                  <span className="text-[13px]">{entry.label}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {tabs.includes("Tarayıcı") ? (
          <div className={`min-h-0 flex-1 flex-col ${active === "Tarayıcı" ? "flex" : "hidden"}`}>
            <BrowserTab />
          </div>
        ) : null}
        {tabs.map((tab) => {
          const key = termKeyOf(tab);
          const meta = key ? terms[key] : null;
          if (!key || !meta) return null;
          return (
            <div
              key={tab}
              className={`min-h-0 flex-1 flex-col ${active === tab ? "flex" : "hidden"}`}
            >
              <TerminalTab termKey={key} cwd={meta.cwd} active={active === tab} />
            </div>
          );
        })}
        {tabs.includes("Dosyalar") && active === "Dosyalar" ? <FilesTab cwd={cwd} /> : null}
        {tabs.includes("Değişiklikler") && active === "Değişiklikler" ? (
          <ChangesTab cwd={cwd} />
        ) : null}
        {tabs.includes("Bulgular") ? (
          <div className={`min-h-0 flex-1 flex-col ${active === "Bulgular" ? "flex" : "hidden"}`}>
            <AuditTab sessionId={sessionId} />
          </div>
        ) : null}
        {/* Yalnız öndeyken çizilir: arka plandaki çıktı yoklaması ve iz aboneliği boşa çalışmasın. */}
        {tabs.includes("İşler") && active === "İşler" ? (
          <JobsTab sessionId={sessionId} cwd={cwd} />
        ) : null}
      </div>
    </SlidePane>
  );
}
