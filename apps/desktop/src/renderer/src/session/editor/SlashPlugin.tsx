import type { AppMode } from "@codezal/contracts";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  BLUR_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_LOW,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  mergeRegister,
} from "lexical";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../../api";
import { promptSuggestions } from "../../lib/mcpPrompts";
import { skillSuggestions } from "../../lib/skills";
import { commandSuggestions } from "../../lib/slashCommands";
import {
  bestIndex,
  filterSuggestions,
  type SlashPrompt,
  type SlashSuggestion,
  uniqueSuggestions,
} from "../../lib/slashSearch";
import { useApp } from "../../stores/app";
import { useMcp } from "../../stores/mcp";
import { useSkills } from "../../stores/skills";
import { humanizeError, toast } from "../../stores/toast";
import { homeCommandPorts, sessionCommandPorts } from "../commandPorts";
import { runSlashCommand } from "../commands";
import { McpPromptForm } from "./McpPromptForm";
import { SlashPanel, type SlashSection } from "./SlashPanel";
import { QUIET_TAG } from "./tags";
import { $createTokenNode, $isTokenNode } from "./tokenNode";

/** Panelin veri kaynağı: becerilerin okunacağı klasör ve kod odaklı komutları süzen mod. */
export interface SlashSource {
  cwd: string | null;
  mode: AppMode;
}

/** Mesajın başındaki `/sorgu`: yalnız boşluk öncesinde olabilir, sorgu boşluk ve `/` içermez. */
const LEADING_SLASH = /^\s*\/([^\s/]*)$/;

/**
 * İmleç mesajın başındaki `/sorgu` belirtecinin içindeyse sorguyu verir. Komutlar yalnız mesajın
 * başında çalışır (çalıştırma kapısı ve Pi baştaki komutu okur); cümle ortasında açılan panel
 * işe yaramayan bir etiket bırakırdı.
 */
function $leadingQuery(): string | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
  const node = selection.anchor.getNode();
  if (!$isTextNode(node) || $isTokenNode(node)) return null;
  if (node.getPreviousSibling() !== null) return null;
  const block = node.getParent();
  if (!block || block.getPreviousSibling() !== null) return null;
  const match = LEADING_SLASH.exec(node.getTextContent().slice(0, selection.anchor.offset));
  return match ? (match[1] ?? "") : null;
}

/**
 * `/` paneli: ZCode'un `SlashCommandPlugin`'i. Sorgu editörden okunur (ayrı arama kutusu yok),
 * ↑↓ gezer, Enter/Tab seçer, Esc kapatır ve aynı belirteç değişene kadar yeniden açmaz. Panel
 * açıkken tuşlar en yüksek öncelikle burada işlenir; Enter kompozere ulaşıp istemi göndermez.
 * Seçim: yerel eylem komutları hemen çalışır, ötekiler belirtecin yerine etiket olarak girer.
 */
export function SlashPlugin({ source }: { source: SlashSource }) {
  const [editor] = useLexicalComposerContext();
  const { t } = useTranslation();
  const [query, setQuery] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  // Esc ile kapatılan sorgu: kullanıcı belirteci değiştirene kadar panel geri açılmaz.
  const dismissed = useRef<string | null>(null);
  const hasSession = useApp((s) => s.activeSessionId !== null);
  const catalog = useSkills((s) => s.catalog);
  const loadSkills = useSkills((s) => s.load);
  const connectors = useMcp((s) => s.connectors);
  const mcpLoaded = useMcp((s) => s.loaded);
  const loadMcp = useMcp((s) => s.load);
  // Argüman bekleyen servis istemi: form kapanana kadar açık kalır.
  const [promptForm, setPromptForm] = useState<{ label: string; prompt: SlashPrompt } | null>(null);
  const open = query !== null;

  // Beceri kataloğu panel açılınca tazelenir: klasör değişmiş ya da beceri eklenmiş olabilir.
  // Servis listesi `mcp:changed` ile güncel kalır; yalnız hiç yüklenmediyse burada çekilir.
  useEffect(() => {
    if (!open) return;
    void loadSkills(source.cwd);
    if (!mcpLoaded) void loadMcp().catch(() => undefined);
  }, [open, source.cwd, loadSkills, mcpLoaded, loadMcp]);

  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState, tags }) => {
        // Geçmiş gezinmesi ve dışarıdan yazılan taslak paneli açmaz: açılsaydı ↑↓ tuşlarını
        // panel yutar, istem geçmişi gezilemezdi.
        if (tags.has(QUIET_TAG)) {
          setQuery(null);
          return;
        }
        const next = editorState.read($leadingQuery);
        if (next === null) {
          dismissed.current = null;
          setQuery(null);
          return;
        }
        if (dismissed.current !== null && dismissed.current !== next) dismissed.current = null;
        setQuery(dismissed.current === next ? null : next);
      }),
    [editor],
  );

  const sections = useMemo<SlashSection[]>(() => {
    if (query === null) return [];
    const commands = commandSuggestions(t, source.mode, hasSession);
    // Aynı yazım iki kaynaktan gelirse komut kazanır: beceri yerleşik komutu gölgelemesin.
    const all = uniqueSuggestions([
      ...commands,
      ...skillSuggestions(catalog),
      ...promptSuggestions(connectors),
    ]);
    const of = (kind: SlashSuggestion["kind"]) =>
      filterSuggestions(
        all.filter((s) => s.kind === kind),
        query,
      );
    return [
      { id: "commands", title: t("commands.group"), items: of("command") },
      { id: "skills", title: t("composer.slash.skills"), items: of("skill") },
      { id: "prompts", title: t("composer.slash.prompts"), items: of("prompt") },
    ];
  }, [query, t, source.mode, hasSession, catalog, connectors]);

  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  // Sorgu değişince seçim bütün listenin en iyi eşleşmesine gider; bölüm sırası bozulmaz.
  useEffect(() => setSelected(bestIndex(flat, query ?? "")), [flat, query]);

  /**
   * İstemi main'de işler ve metnini imlecin yerine yazar. Metin gönderilmez: kullanıcı okuyup
   * düzenledikten sonra kendisi gönderir (sunucudan gelen metin doğrudan modele gitmesin).
   */
  const insertPrompt = useCallback(
    async (prompt: SlashPrompt, args: Record<string, string>) => {
      const { text } = await invoke("mcp:getPrompt", {
        id: prompt.connectorId,
        name: prompt.name,
        args,
      });
      editor.update(() => {
        let selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          $getRoot().selectEnd();
          selection = $getSelection();
        }
        if ($isRangeSelection(selection)) selection.insertRawText(text);
      });
      editor.focus();
    },
    [editor],
  );

  const pick = useCallback(
    (item: SlashSuggestion) => {
      const prompt = item.prompt;
      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
        const node = selection.anchor.getNode();
        if (!$isTextNode(node) || $isTokenNode(node)) return;
        const text = node.getTextContent();
        const caret = selection.anchor.offset;
        const typed = /\/([^\s/]*)$/.exec(text.slice(0, caret));
        if (!typed) return;
        const start = caret - typed[0].length;
        // İmleç belirtecin ortasındaysa (`/pl|an`) arkadaki harfler de değişir; ama yalnız
        // adayın bir yazımının (değer, görünen ad, takma ad) devamıysa — `/go|revizyon` gibi
        // yapışık metin silinmesin. Hemen çalışan komutta belirtecin tamamı komutun kendisidir.
        const tail = /^[^\s]*/.exec(text.slice(caret))?.[0] ?? "";
        const whole = `${typed[1] ?? ""}${tail}`.toLocaleLowerCase("tr");
        const spellings = [item.value, item.label, ...item.keywords].map((spelling) =>
          spelling.replace(/^\//, "").toLocaleLowerCase("tr"),
        );
        const ownsTail = item.runOnPick || spellings.some((spelling) => spelling.startsWith(whole));
        const end = caret + (tail && ownsTail ? tail.length : 0);
        selection.setTextNodeRange(node, start, node, end);
        // Servis istemi etiket olarak girmez: yazılan `/sorgu` silinir, yerine işlenmiş metin gelir.
        if (item.runOnPick || prompt || item.kind === "prompt") {
          // Çalışan komut kutuda kalmaz: kalsaydı Enter onu ikinci kez gönderirdi.
          selection.removeText();
          return;
        }
        const token = $createTokenNode(item.kind, item.value);
        if (/^\s/.test(text.slice(end))) {
          selection.insertNodes([token]);
          token.selectNext(1, 1);
        } else {
          const space = $createTextNode(" ");
          selection.insertNodes([token, space]);
          space.selectEnd();
        }
      });
      dismissed.current = null;
      setQuery(null);
      if (prompt) {
        if (prompt.arguments.length > 0) setPromptForm({ label: item.label, prompt });
        else void insertPrompt(prompt, {}).catch((e: unknown) => toast.error(humanizeError(e)));
        return;
      }
      if (!item.runOnPick) return;
      const id = useApp.getState().activeSessionId;
      void runSlashCommand(item.value, id ? sessionCommandPorts(id) : homeCommandPorts()).catch(
        (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
      );
    },
    [editor, insertPrompt],
  );

  useEffect(() => {
    if (!open) return;
    const guard = (event: KeyboardEvent | null) => {
      event?.preventDefault();
      event?.stopPropagation();
      return true;
    };
    return mergeRegister(
      editor.registerCommand(
        KEY_ARROW_DOWN_COMMAND,
        (event) => {
          // Eşleşme yokken ok imleci doğal yoldan taşır (varsayılan engellenmez) ama kompozerin
          // geçmiş gezinmesine ulaşmaz: ulaşsaydı yazılan `/sorgu` geçmişteki istemle değişirdi.
          if (flat.length === 0) return true;
          setSelected((i) => Math.min(i + 1, flat.length - 1));
          return guard(event);
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(
        KEY_ARROW_UP_COMMAND,
        (event) => {
          if (flat.length === 0) return true;
          setSelected((i) => Math.max(i - 1, 0));
          return guard(event);
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
      // Eşleşme yokken Enter yutulmaz: `/mode yolo` gibi argümanlı komut yazılırken liste boş
      // kalır ve Enter kompozere ulaşıp gönderimi yapmalıdır.
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event) => {
          const item = flat[selected];
          // Yalnız düz Enter seçer: Shift+Enter satır ekler, ⌘/Ctrl+Enter kompozerin gönder/sıraya
          // al kısayoludur.
          const modified = event?.shiftKey || event?.metaKey || event?.ctrlKey;
          if (!item || event?.isComposing || modified) return false;
          pick(item);
          return guard(event);
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(
        KEY_TAB_COMMAND,
        (event) => {
          const item = flat[selected];
          if (!item) return false;
          pick(item);
          return guard(event);
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
      // Esc paneli kapatır, süren turu durdurmaz: kompozerin Esc'i (durdur) daha düşük öncelikte.
      editor.registerCommand(
        KEY_ESCAPE_COMMAND,
        (event) => {
          dismissed.current = query;
          setQuery(null);
          return guard(event);
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
      editor.registerCommand(
        BLUR_COMMAND,
        () => {
          dismissed.current = null;
          setQuery(null);
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
    );
  }, [editor, open, flat, selected, pick, query]);

  // Kapanış da canlanır: panel küçülürken son içeriğini göstermeye devam eder, yoksa boşalan
  // kart çökerken "eşleşme yok" satırı görünürdü.
  const last = useRef<{ sections: SlashSection[]; query: string; selected: number } | null>(null);
  if (query !== null) last.current = { sections, query, selected };
  const shown = last.current;

  // Sarmalayıcı hep bağlıdır: ilk açılışta da `data-open` sonradan eklenir ve geçiş çalışır.
  // Kutunun üst kenarına oturur (`.cz-slash`, styles.css); kutu yukarı doğru büyümüş görünür.
  return (
    <>
      {promptForm ? (
        <McpPromptForm
          title={promptForm.label}
          prompt={promptForm.prompt}
          onClose={() => {
            setPromptForm(null);
            editor.focus();
          }}
          onSubmit={async (args) => {
            try {
              await insertPrompt(promptForm.prompt, args);
              setPromptForm(null);
            } catch (e) {
              toast.error(humanizeError(e));
            }
          }}
        />
      ) : null}
      <div
        className="cz-slash absolute -inset-x-px bottom-full z-20"
        data-open={open ? "" : undefined}
        aria-hidden={!open}
        inert={!open}
      >
        <div className="cz-slash-body">
          {shown ? (
            <SlashPanel
              sections={shown.sections}
              selected={shown.selected}
              query={shown.query}
              onHover={setSelected}
              onPick={(index) => {
                const item = flat[index];
                if (item) pick(item);
              }}
            />
          ) : null}
        </div>
      </div>
    </>
  );
}
