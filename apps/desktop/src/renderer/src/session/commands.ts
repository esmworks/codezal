import type { IpcResponse, ModelRef, PermissionMode, ThinkingLevel } from "@codezal/contracts";
import { i18n } from "../lib/i18n";
import type { MenuCallbackAnchor } from "../lib/menuPos";
import {
  allowedArgs,
  modelArg,
  parseSlashCommand,
  permissionArg,
  thinkingArg,
  usageOf,
} from "../lib/slashCommands";
import { useApp } from "../stores/app";
import { useMenu } from "../stores/menu";
import { useModelPicker } from "../stores/modelPicker";
import { useModels } from "../stores/models";
import { toast } from "../stores/toast";
import { permissionMenuItems, thinkingMenuItems } from "./chipMenus";

/**
 * Komutların dokunduğu oturum eylemleri. Komut çalıştırıcısı `stores/sessions`'ı **import etmez**
 * (depo, komutu çağıran taraftır: `prompt` içindeki kapı); eylemler bu porttan geçer. Böylece
 * komutlar hem gönderim yolundan hem paletten aynı kodla çalışır, döngüsel import doğmaz.
 */
export interface CommandPorts {
  /** Açık oturum kimliği; giriş ekranında null (yalnız oturumsuz komutlar çalışır). */
  sessionId: string | null;
  /** Seçici ve menülerin açılacağı yer: kompozer kutusu (ZCode da seçiciyi girişin üstünde açar). */
  anchor: MenuCallbackAnchor;
  /** Oturumun o anki modeli: seçicide işaretlenecek olan. */
  model: ModelRef | null;
  /** Menülerde işaretlenecek mevcut izin modu ve düşünme seviyesi (oturumunki, yoksa genel tercih). */
  permission: PermissionMode;
  thinking: ThinkingLevel;
  setModel(ref: ModelRef): void;
  setThinking(level: ThinkingLevel): void;
  setPermission(mode: PermissionMode): void;
  compact(): Promise<IpcResponse<"sessions:compact">>;
  goal(action: "set" | "stop" | "pause" | "resume", text?: string): Promise<void>;
  /** Yeni görev ekranı (ZCode'un `/new` komutu). */
  newTask(): void;
}

/** Seçicide/yardımda gösterilecek geçerli değerler; hata metni kullanıcıya listeyi söyler. */
function allowedText(values: string[]): string {
  return values.join(", ");
}

/** Oturum gerektiren komut, oturumsuz çağrıldığında: giriş ekranından sessizce düşmesin. */
function requireSession(ports: CommandPorts): string {
  if (!ports.sessionId) throw new Error(i18n.t("commands.needsSession"));
  return ports.sessionId;
}

/**
 * Metni komut olarak çalıştırır. `true` dönerse metin modele **gitmez**: yerel eylem tamamlandı
 * (`/model`, `/mod`, `/compact`, `/yardım`, …). `false` dönerse metin normal istemdir — kısayol
 * komutları (`/plan`, `/sor`, `/debug`, `/denetim`) ve bilinmeyen `/…` metinleri buradan geçer.
 *
 * Geçersiz argüman **hata fırlatır**: gönderim reddedilir, Composer taslağı geri yükler, kullanıcı
 * yazdığını kaybetmez. Sessizce yutmak (ya da komut metnini modele göndermek) kullanıcıyı
 * yanıltırdı: `/model yanlış` yazan kişi modele "model yanlış" dediğini sanmamalı.
 */
export async function runSlashCommand(text: string, ports: CommandPorts): Promise<boolean> {
  const parsed = parseSlashCommand(text);
  // Kısayol komutları (`action: false`) burada durmaz: metin talimata genişleyip modele gider.
  if (!parsed?.command.action) return false;
  const { command, args } = parsed;
  const t = i18n.t;

  switch (command.name) {
    case "help":
      // Argüman verilmişse ekran o komuta süzülerek açılır (ZCode'un `/help <komut>` davranışı).
      useApp.getState().setCommandsOpen(true, args);
      return true;

    case "model": {
      if (!args) {
        // Argümansız: seçici açılır (TUI'de de kullanıcıya liste sunulur, körlemesine değiştirilmez).
        useModelPicker.getState().openAt(ports.anchor, (ref) => ports.setModel(ref), ports.model);
        return true;
      }
      const ref = modelArg(args);
      if (!ref) throw new Error(t("commands.modelArgBad", { usage: usageOf(command, t) }));
      const known = useModels
        .getState()
        .catalog.some((m) => m.provider === ref.provider && m.id === ref.id);
      if (!known) throw new Error(t("commands.modelUnknown", { value: args }));
      ports.setModel(ref);
      return true;
    }

    case "mode": {
      if (!args) {
        useMenu.getState().openAt(ports.anchor, {
          minWidth: 260,
          items: permissionMenuItems(t, ports.permission, (mode) => ports.setPermission(mode)),
        });
        return true;
      }
      const mode = permissionArg(args);
      if (!mode)
        throw new Error(t("commands.argBad", { values: allowedText(allowedArgs(command)) }));
      ports.setPermission(mode);
      return true;
    }

    case "effort": {
      if (!args) {
        useMenu.getState().openAt(ports.anchor, {
          items: thinkingMenuItems(t, ports.thinking, (level) => ports.setThinking(level)),
        });
        return true;
      }
      const level = thinkingArg(args);
      if (!level)
        throw new Error(t("commands.argBad", { values: allowedText(allowedArgs(command)) }));
      ports.setThinking(level);
      return true;
    }

    case "compact": {
      requireSession(ports);
      if (args) throw new Error(t("commands.noArgs", { usage: usageOf(command, t) }));
      const result = await ports.compact();
      if (result.ok) {
        toast.success(t("compact.done"));
        return true;
      }
      // Sebep ayrı ayrı anlatılır: "yapacak iş yok" bir arıza değil; genel hata metni kullanıcıyı
      // yanıltırdı (kullanıcı `/compact` dedi ve "başarısız" gördü).
      if (result.reason === "nothing-to-compact") {
        toast.info(t("compact.nothingToDo"));
        return true;
      }
      if (result.reason === "already-compacted") {
        toast.info(t("compact.alreadyDone"));
        return true;
      }
      const key =
        result.reason === "busy"
          ? "compact.busy"
          : result.reason === "not-open"
            ? "compact.notOpen"
            : "compact.failed";
      const message = t(key);
      throw new Error(result.detail ? `${message}\n${result.detail}` : message);
    }

    case "goal": {
      requireSession(ports);
      const arg = args.trim();
      if (!arg) throw new Error(t("goal.emptyHint"));
      const lower = arg.toLocaleLowerCase("tr");
      if (lower === "stop" || lower === "durdur" || lower === "cancel") {
        await ports.goal("stop");
      } else if (lower === "pause" || lower === "duraklat") {
        await ports.goal("pause");
      } else if (lower === "resume" || lower === "devam") {
        await ports.goal("resume");
      } else {
        await ports.goal("set", arg);
      }
      return true;
    }

    case "skill":
      if (args) throw new Error(t("commands.noArgs", { usage: usageOf(command, t) }));
      useApp.getState().setSettingsOpen(true, "beceriler");
      return true;

    case "mcp":
      if (args) throw new Error(t("commands.noArgs", { usage: usageOf(command, t) }));
      useApp.getState().setSettingsOpen(true, "baglayicilar");
      return true;

    case "new":
      requireSession(ports);
      if (args) throw new Error(t("commands.noArgs", { usage: usageOf(command, t) }));
      ports.newTask();
      return true;

    case "resume":
      if (args) throw new Error(t("commands.noArgs", { usage: usageOf(command, t) }));
      useApp.getState().setSearchOpen(true);
      return true;

    default:
      return false;
  }
}
