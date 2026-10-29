import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke, on } from "../api";
import { Icon } from "../components/Icon";
import { basename } from "../lib/format";
import { i18n } from "../lib/i18n";
import { useApp } from "../stores/app";
import { useMenu } from "../stores/menu";
import { usePanel } from "../stores/panel";
import { useSettings } from "../stores/settings";

function cssVar(name: string): string {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

function isLight(): boolean {
  return document.body.hasAttribute("data-cz-light");
}

function themeOf(light: boolean) {
  return {
    background: cssVar("--bg"),
    foreground: cssVar("--tx"),
    cursor: cssVar("--tx2"),
    selectionBackground: light ? "rgba(16,24,40,0.15)" : "rgba(255,255,255,0.18)",
    black: light ? "#1c2126" : "#17191c",
    brightBlack: cssVar("--tx3"),
    green: cssVar("--green"),
    red: cssVar("--red"),
    yellow: cssVar("--amber"),
    blue: light ? "#4b6fa8" : "#8ab4f8",
    magenta: light ? "#8a5aa8" : "#c79cf0",
    cyan: light ? "#3f8a8f" : "#7fd1d6",
    white: cssVar("--tx"),
  };
}

/**
 * Bileşenden bağımsız yaşayan terminal oturumu. Panel sekmesi değişince React bileşeni yeniden
 * kurulur; xterm ve ekran içeriği burada kaldığı için kabuğa boş ekranla bağlanılmaz.
 * Anahtar panel deposundan gelir: sekme şeritte, kabuk burada durur.
 */
interface Session {
  /** Panel deposundaki anahtar; sekme işaretleri (kabuk kapandı) bununla yazılır. */
  key: string;
  cwd: string;
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  id: string | null;
  title: string;
  /** Kabuk kapandı; sekmeye dönüldüğünde kendiliğinden yenisi açılmaz, menüden başlatılır. */
  exited: boolean;
  creating: Promise<void> | null;
  onTitle: ((title: string) => void) | null;
}

const sessions = new Map<string, Session>();
let wired = false;

/** IPC olaylarını tek yerden oturumlara dağıt; bileşen bağlı olmasa da veri kaybolmasın. */
function wireEvents() {
  if (wired) return;
  wired = true;
  on("terminal:data", (p) => {
    for (const s of sessions.values()) if (s.id === p.id) s.term.write(p.data);
  });
  on("terminal:exit", (p) => {
    for (const [key, s] of sessions) {
      if (s.id !== p.id) continue;
      s.term.writeln(`\r\n${i18n.t("terminal.shellClosed")}`);
      s.id = null;
      s.exited = true;
      // Sekme soluk çizilsin: ölü kabuğun canlı görünmesi, komut yazıp yanıt beklemeye yol açıyordu.
      usePanel.getState().setTerminalExited(key, true);
    }
  });
}

const DEFAULT_FONT =
  "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', 'Cascadia Code', monospace";

/** Ayarlar > Genel > Terminal yazı tipi; boşken uygulamanın varsayılan yığını. */
function fontOf(): string {
  const font = useSettings.getState().settings?.terminalFont.trim();
  return font ? `${font}, ${DEFAULT_FONT}` : DEFAULT_FONT;
}

/** Anahtarı verilen oturumu kurar; aynı anahtar için ikinci kez çağrılırsa var olanı döndürür. */
function createSession(key: string, cwd: string): Session {
  const existing = sessions.get(key);
  if (existing) return existing;
  wireEvents();
  const term = new Terminal({
    fontFamily: fontOf(),
    fontSize: 12,
    lineHeight: 1,
    cursorBlink: true,
    allowProposedApi: true,
    theme: themeOf(isLight()),
    scrollback: 5000,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const el = document.createElement("div");
  el.className = "h-full w-full";
  term.open(el);
  // WebGL: blok/kutu karakterleri fonttan bağımsız dikişsiz çizer, kaydırma hızlanır.
  // Bağlam kaybında (GPU uyku vb.) eklenti kapanır, xterm DOM çizimine geri döner.
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    // WebGL yoksa DOM renderer yeterli
  }
  const session: Session = {
    key,
    cwd,
    term,
    fit,
    el,
    id: null,
    title: `zsh — ${basename(cwd)}`,
    exited: false,
    creating: null,
    onTitle: null,
  };
  term.onData((data) => {
    if (session.id) void invoke("terminal:write", { id: session.id, data });
  });
  sessions.set(key, session);
  return session;
}

/** Kabuk yoksa oluştur; eş zamanlı bağlanmalarda tek pty açılmasını garanti et. */
function ensureShell(s: Session): Promise<void> | null {
  if (s.exited) return null;
  if (s.id) {
    return invoke("terminal:resize", { id: s.id, cols: s.term.cols, rows: s.term.rows }).then(
      () => undefined,
    );
  }
  if (!s.creating) {
    s.creating = invoke("terminal:create", {
      cwd: s.cwd,
      cols: s.term.cols,
      rows: s.term.rows,
    })
      .then((info) => {
        s.id = info.id;
        s.title = info.title;
        s.onTitle?.(info.title);
        // Yeniden başlatılan kabuk ölü işaretini bırakır; sekme tekrar canlı çizilir.
        usePanel.getState().setTerminalExited(s.key, false);
      })
      .finally(() => {
        s.creating = null;
      });
  }
  return s.creating;
}

/** Sekme kapanınca kabuğu öldürür: kapalı sekmenin komutu arka planda dönmeye devam etmesin. */
export function killTerminal(key: string): void {
  const s = sessions.get(key);
  if (!s) return;
  sessions.delete(key);
  if (s.id) void invoke("terminal:kill", { id: s.id });
  s.el.remove();
  s.term.dispose();
}

/** Bir terminal sekmesinin gövdesi: xterm, kabuk bilgisi ve yeniden başlat/temizle menüsü (TODO 2). */
export function TerminalTab({
  termKey,
  cwd,
  active,
}: {
  /** Panel deposundaki terminal anahtarı (`termKeyOf`); aynı anahtar sekmeyi de gösterir. */
  termKey: string;
  cwd: string;
  /** Sekme önde mi: arkadaki terminaller ölçü almaz, öne gelince tazelenir. */
  active: boolean;
}) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement>(null);
  const theme = useApp((s) => s.theme);
  const terminalFont = useSettings((s) => s.settings?.terminalFont ?? "");
  const openAt = useMenu((s) => s.openAt);
  const [title, setTitle] = useState("");
  const [gen, setGen] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: gen değişince oturumu yeniden bağla
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const s = createSession(termKey, cwd);
    s.onTitle = setTitle;
    setTitle(s.title);
    host.appendChild(s.el);

    const resize = () => {
      // Panel kayarken genişlik sıfıra iner; o aradaki fit sütun sayısını bozar.
      if (host.clientWidth < 80 || host.clientHeight < 40) return;
      try {
        s.fit.fit();
        if (s.id)
          void invoke("terminal:resize", { id: s.id, cols: s.term.cols, rows: s.term.rows });
      } catch {
        // arkadaki sekmede fit hata verebilir
      }
    };
    resize();
    // Kabuk açılamazsa (silinmiş klasör, pty sınırı) sekme sessizce ölü kalmasın: sebebi
    // terminale yazılır ve sekme soluk çizilir — yoksa yazılan tuşlar hiçbir yere gitmiyordu.
    ensureShell(s)?.catch((error: unknown) => {
      s.exited = true;
      usePanel.getState().setTerminalExited(termKey, true);
      s.term.writeln(`\r\n${error instanceof Error ? error.message : String(error)}`);
    });
    // Yeniden bağlanmada tuvali tazele; taşınan canvas bazen ilk kareyi boş bırakır.
    s.term.refresh(0, s.term.rows - 1);

    const ro = new ResizeObserver(resize);
    ro.observe(host);
    return () => {
      ro.disconnect();
      s.onTitle = null;
      s.el.remove();
    };
  }, [cwd, termKey, gen]);

  useEffect(() => {
    if (!active) return;
    const s = sessions.get(termKey);
    if (!s) return;
    try {
      s.fit.fit();
      if (s.id) void invoke("terminal:resize", { id: s.id, cols: s.term.cols, rows: s.term.rows });
    } catch {
      // henüz ölçü yoksa sonraki boyamada sığdırılır
    }
    s.term.refresh(0, s.term.rows - 1);
    s.term.focus();
  }, [active, termKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: theme değişince renkleri yenile
  useEffect(() => {
    // Tema değişince xterm temasını canlı güncelle; oturum ve ekran içeriği korunur.
    for (const s of sessions.values()) s.term.options.theme = themeOf(isLight());
  }, [theme]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: yazı tipi değişince açık terminalleri yenile
  useEffect(() => {
    // Ayar tüm açık terminallere uygulanır; ölçüler değiştiği için yeniden sığdırılır.
    for (const s of sessions.values()) {
      s.term.options.fontFamily = fontOf();
      try {
        s.fit.fit();
        if (s.id)
          void invoke("terminal:resize", { id: s.id, cols: s.term.cols, rows: s.term.rows });
      } catch {
        // arkadaki sekmede fit hata verebilir
      }
    }
  }, [terminalFont]);

  const menu = (e: React.MouseEvent) =>
    openAt(e.currentTarget as HTMLElement, {
      items: [
        {
          label: t("terminal.restart"),
          icon: "loop",
          onSelect: () => {
            // Ölü ya da takılı kabuğu bırak; bağlama efekti temiz bir oturum kurar. Sekmenin
            // "kabuk kapandı" işareti yeni kabuk doğunca (ensureShell) geri alınır.
            killTerminal(termKey);
            setGen((g) => g + 1);
          },
        },
        {
          label: t("terminal.clear"),
          icon: "trash",
          onSelect: () => sessions.get(termKey)?.term.clear(),
        },
      ],
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 pb-[9px] font-mono text-[12px] text-tx3">
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <button
          type="button"
          onClick={menu}
          title={t("terminal.menu")}
          aria-label={t("terminal.menu")}
          className="hover:text-tx"
        >
          <Icon name="menuLines" size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 border-t border-line p-2">
        <div ref={hostRef} className="h-full w-full" />
      </div>
    </div>
  );
}
