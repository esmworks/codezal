import type { AppMode } from "@codezal/contracts";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../api";
import { Icon } from "../components/Icon";
import { withMentions } from "../lib/skills";
import { useApp } from "../stores/app";
import { connectedToolCount, useMcp } from "../stores/mcp";
import { useMenu } from "../stores/menu";
import { humanizeError, toast } from "../stores/toast";
import type { ComposerHandle, SlashSource } from "./Composer";

/**
 * Composer'ın "+" düğmesi ve `/` panelinin kaynağı. Tüm composer'lar (Kodlama, Asistan; giriş ve
 * oturum) aynı kancayı kullanır: `button` sola, `composerRef` ve `slash` Composer'a verilir.
 *
 * Görevler ayrıktır (ZCode'un girişi gibi): "+" yalnız bağlam ekler (dosya, klasör, görsel,
 * servisler); komut ve beceriler `/` ile yazma kutusunun içinde aranır.
 */
export function useComposerPalette({
  cwd,
  mode,
  size = 24,
}: {
  cwd: string | null;
  mode: AppMode;
  /** Düğme çapı: giriş ekranlarında 26, oturumlarda 24. */
  size?: number;
}): {
  composerRef: React.RefObject<ComposerHandle | null>;
  button: ReactNode;
  slash: SlashSource;
} {
  const { t } = useTranslation();
  const composerRef = useRef<ComposerHandle>(null);
  const openAt = useMenu((s) => s.openAt);
  const mcpLoaded = useMcp((s) => s.loaded);
  const loadMcp = useMcp((s) => s.load);
  // Servis satırındaki araç sayısı menü açılmadan hazır olsun.
  useEffect(() => {
    if (!mcpLoaded) void loadMcp();
  }, [mcpLoaded, loadMcp]);

  /** Seçilen yollar taslağın sonuna `@yol` olarak eklenir; yazılmakta olan metin korunur. */
  const mention = (paths: string[]) => {
    const composer = composerRef.current;
    if (!composer || paths.length === 0) return;
    composer.setText(withMentions(composer.getDraft().text, paths));
  };

  // Seçici IPC'si düşerse (pencere kapanırken, doğrulama hatası) sessiz kalınmaz.
  const failed = (error: unknown) => toast.error(humanizeError(error));

  const open = (anchor: HTMLElement) => {
    const tools = connectedToolCount(useMcp.getState().connectors);
    openAt(anchor, {
      minWidth: 240,
      items: [
        {
          label: t("chips.filesLabel"),
          desc: t("chips.filesDesc"),
          icon: "clip",
          onSelect: () =>
            void invoke("files:pickFiles", { title: t("chips.pickFilesTitle") })
              .then(mention)
              .catch(failed),
        },
        {
          label: t("chips.folderLabel"),
          desc: t("chips.folderDesc"),
          icon: "folder",
          onSelect: () =>
            void invoke("settings:pickFolder", { title: t("chips.pickFolderTitle") })
              .then((path) => mention(path ? [path] : []))
              .catch(failed),
        },
        {
          label: t("chips.imgLabel"),
          desc: t("chips.imgDesc"),
          icon: "image",
          onSelect: () => composerRef.current?.attachImages(),
        },
        {
          label: t("chips.mcpLabel"),
          desc: tools > 0 ? t("chips.mcpDescCount", { count: tools }) : t("chips.mcpDescNone"),
          icon: "mcp",
          onSelect: () => useApp.getState().setSettingsOpen(true, "baglayicilar"),
        },
      ],
    });
  };

  const button = (
    <button
      type="button"
      onClick={(e) => open(e.currentTarget)}
      title={t("composer.addTitle")}
      className="flex shrink-0 items-center justify-center rounded-full border border-line2 text-tx hover:bg-hov"
      style={{ width: size, height: size }}
    >
      <Icon name="plus" size={size > 24 ? 13 : 12} stroke={2} />
    </button>
  );

  const slash = useMemo(() => ({ cwd, mode }), [cwd, mode]);
  return { composerRef, button, slash };
}
