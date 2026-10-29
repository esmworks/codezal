import { type ImageAttachment, TEST_IDS, testId } from "@codezal/contracts";
import { type InitialConfigType, LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import {
  $addUpdateTag,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  COPY_COMMAND,
  CUT_COMMAND,
  DROP_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  mergeRegister,
  PASTE_COMMAND,
} from "lexical";
import {
  type DragEvent,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { invoke, pathForFile } from "../api";
import { Icon } from "../components/Icon";
import { useLightbox } from "../components/Lightbox";
import { setComposerAnchor } from "../lib/commandAnchor";
import { useLocale } from "../lib/i18n";
import { approxKb, attachmentsFrom, dataUrl, isImageFile, MAX_IMAGES } from "../lib/images";
import {
  atHistoryEdge,
  type HistoryCursor,
  type HistoryStep,
  historyFor,
  historyNext,
  historyPrev,
  rememberPrompt,
} from "../lib/promptHistory";
import { withQuotes } from "../lib/promptText";
import { withMentions } from "../lib/skills";
import { useModels } from "../stores/models";
import { humanizeError, toast } from "../stores/toast";
import {
  addQuote,
  type ComposerDraft,
  emptyDraft,
  expandDraft,
  hasMessage,
  insertPaste,
  isDraftEmpty,
  mergeImages,
  normalizePaste,
  pasteLineCount,
  removeImageAt,
  removeQuoteAt,
  sameDraft,
  shouldCollapsePaste,
  syncDraft,
  uniquePlaceholder,
} from "./composerParts";
import { $draftSelection, $draftText, $writeDraft } from "./editor/draftText";
import { SlashPlugin, type SlashSource } from "./editor/SlashPlugin";
import { QUIET_TAG } from "./editor/tags";
import { $createTokenNode, TokenNode } from "./editor/tokenNode";

export type { SlashSource };

/**
 * Kutunun rolü. Ölçü, boşluk, gölge ve otomatik odak buradan gelir; ekranlar tek tek
 * ayar geçmez, böylece tüm composer'lar aynı görünür.
 */
export type ComposerVariant = "home" | "chat";

/** Role göre ölçüler: giriş ekranı ferah ve odaklı, oturum içi sıkı. */
const VARIANTS = {
  home: {
    box: "gap-[16px] rounded-[16px] px-4 pt-[14px] pb-[12px]",
    row: "gap-3",
    send: 28,
    maxHeight: 220,
    minHeight: 46,
  },
  chat: {
    box: "gap-[10px] rounded-[16px] px-[14px] pt-[12px] pb-[10px]",
    row: "gap-2",
    send: 26,
    maxHeight: 180,
    minHeight: 40,
  },
} as const;

interface Props {
  placeholder: string;
  /**
   * Genişletilmiş metni ve görselleri gönderir. Promise reddederse Composer taslağı
   * (metin + yapıştırma parçaları + görseller) aynen geri yükler ve hatayı toast'lar.
   */
  onSend: (text: string, images: ImageAttachment[]) => unknown;
  /** Çalışırken ⌘/Ctrl+Enter ile kuyruğa alma; verilmezse kısayol yönlendirme gibi çalışır. */
  onQueue?: (text: string, images: ImageAttachment[]) => unknown;
  /** Varsayılan "chat"; giriş ekranlarında "home". */
  variant?: ComposerVariant;
  /** Sol tarafta gösterilecek düğmeler (ekle düğmesi vb.). */
  left?: React.ReactNode;
  /** Sağ tarafta gösterilecek çipler (düşünme, model). */
  right?: React.ReactNode;
  busy?: boolean;
  /** Ajan çalışırken de gönderime izin ver (yönlendirme); varsayılan kapalı. */
  allowWhileBusy?: boolean;
  onStop?: () => void;
  /** `/` panelinin kaynağı (beceri klasörü, mod); verilmezse panel açılmaz. */
  slash?: SlashSource;
  /** Başlangıç taslağı: metin + yapıştırma parçaları + görseller. */
  draft?: ComposerDraft | null;
  /** Artınca taslak `draft`'tan tazelenir: rewind, palet seçimi gibi dış kaynaklı güncellemeler. */
  hydrateKey?: number;
  /** Her değişimde çağrılır (oturum başına taslak saklamak için); gönderimde boş taslak gelir. */
  onDraft?: (draft: ComposerDraft) => void;
  /** Görsel düğmesini gizle: ekleme "+" menüsündeki "Görsel ekle" seçeneğiyle yapılır. */
  hideAttach?: boolean;
  /**
   * İstem geçmişinin anahtarı (proje yolu). ↑/↓ bu projede gönderilen istemler arasında gezinir;
   * verilmezse tek bir genel liste kullanılır.
   */
  historyKey?: string;
  /**
   * Kutu `/model` ve `/mod` seçicilerinin çapası olsun mu (varsayılan açık). Çapa tekildir; aynı
   * ekrandaki ikinci kutu (yan sohbet) kapatmazsa sökülürken ana kutunun çapasını silerdi.
   */
  commandAnchor?: boolean;
  /** Kutu açılır açılmaz odak alsın mı; verilmezse yalnız giriş ekranlarında ("home") alır. */
  autoFocus?: boolean;
}

/** Dışarıdan tetikleme kolu: "+" menüsü görsel seçtirir ya da taslağı okuyup yazar. */
export interface ComposerHandle {
  attachImages: () => void;
  getDraft: () => ComposerDraft;
  setText: (text: string) => void;
  /** Sohbetten "Yanıtla": metni alıntı olarak ekler ve kutuya odaklanır. */
  addQuote: (text: string) => void;
}

/** Lexical kurulumu: düz metin, tek düğüm türü (etiket). Hatalar kutuyu düşürmez, günlüğe gider. */
const EDITOR_CONFIG: InitialConfigType = {
  namespace: "codezal-composer",
  nodes: [TokenNode],
  theme: { paragraph: "m-0" },
  onError: (error) => console.error(error),
};

/**
 * Yazma kutusu. İçerik Lexical düzenleyicide yaşar (ZCode'un sohbet girişi gibi): komut, beceri,
 * dosya bahsi ve uzun yapıştırma tek birimlik etiket olarak görünür, tek Backspace ile silinir.
 * Taslağın tek doğruluk kaynağı yine `ComposerDraft`'tır: editör her değişimde taslak metnine
 * çevrilir (etiket → `/plan`, `@/yol`, yer tutucu), gönderimde yapıştırmalar gerçek içerikle
 * genişler. Enter gönderir, Shift+Enter satır ekler. Görseller yapıştırma (⌘V), sürükle-bırak
 * ya da ataç düğmesiyle eklenir; Pi'ye base64 olarak gider.
 */
export const Composer = forwardRef<ComposerHandle, Props>(function Composer(props, ref) {
  return (
    <LexicalComposer initialConfig={EDITOR_CONFIG}>
      <ComposerBody {...props} handleRef={ref} />
    </LexicalComposer>
  );
});

function ComposerBody({
  placeholder,
  onSend,
  onQueue,
  variant = "chat",
  left,
  right,
  busy,
  allowWhileBusy,
  onStop,
  slash,
  draft,
  hydrateKey,
  onDraft,
  hideAttach,
  historyKey = "global",
  commandAnchor = true,
  autoFocus: autoFocusProp,
  handleRef,
}: Props & { handleRef: React.ForwardedRef<ComposerHandle> }) {
  const v = VARIANTS[variant];
  const { send: size, maxHeight } = v;
  // Giriş ekranlarında kutu açılır açılmaz yazmaya hazır olur.
  const autoFocus = autoFocusProp ?? variant === "home";
  const { t } = useTranslation();
  const lang = useLocale();
  const [editor] = useLexicalComposerContext();
  // Tek doğruluk kaynağı: taslak state'i. Editör yalnız bu taslağı gösterir.
  const draftRef = useRef<ComposerDraft>(draft ?? emptyDraft());
  // İstem geçmişi imleci: gezinme sürerken kutudaki **tam taslak** (metin + yapıştırmalar +
  // görseller) `cursorRef.draft` içinde saklanır; yalnız görünen metni saklamak yapıştırma
  // yer tutucularını çözer ve gönderimde içeriği yer tutucu metinle değiştirirdi.
  const cursorRef = useRef<HistoryCursor<ComposerDraft>>({ index: null, draft: emptyDraft() });
  const [view, setView] = useState<ComposerDraft>(draftRef.current);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const openLightbox = useLightbox((s) => s.open);
  const vision = useModels((s) => {
    const m = s.model;
    if (!m) return true;
    return s.catalog.find((c) => c.provider === m.provider && c.id === m.id)?.vision ?? true;
  });
  // Prop her render'da yeni closure olabilir; commit/applyDraft bağımlılığını sabit tutmak için ref.
  const onDraftRef = useRef(onDraft);
  onDraftRef.current = onDraft;

  /** Taslağı state'e ve dinleyiciye yazar; editöre dokunmaz (içerik zaten oradadır). */
  const adopt = useCallback((next: ComposerDraft) => {
    draftRef.current = next;
    setView(next);
    onDraftRef.current?.(next);
  }, []);

  const commit = useCallback(
    (next: ComposerDraft) => {
      if (!sameDraft(draftRef.current, next)) adopt(next);
    },
    [adopt],
  );

  /** Taslağı editöre yazar (sessiz güncelleme: panel açılmaz, geçmiş imleci sıfırlanmaz). */
  const writeEditor = useCallback(
    (next: ComposerDraft) => {
      editor.update(
        () => {
          $addUpdateTag(QUIET_TAG);
          $writeDraft(next.text, next.pastes);
        },
        { discrete: true },
      );
    },
    [editor],
  );

  /** State + editör + ekran taslağını birlikte günceller. */
  const applyDraft = useCallback(
    (next: ComposerDraft) => {
      adopt(next);
      writeEditor(next);
    },
    [adopt, writeEditor],
  );

  // Editördeki her değişim taslağa yansır. Kullanıcı yazdıysa gezinme biter: ↑ bir sonraki
  // basışta en yeniden başlar. Yalnız imleç kıpırdadıysa (içerik aynı) imleç korunur.
  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves, tags }) => {
        const text = editorState.read($draftText);
        commit(syncDraft(draftRef.current, text));
        if (!tags.has(QUIET_TAG) && (dirtyElements.size > 0 || dirtyLeaves.size > 0))
          cursorRef.current = { index: null, draft: draftRef.current };
      }),
    [editor, commit],
  );

  // e2e testleri kutuyu yer tutucusuyla bulur (`getByPlaceholder`); contenteditable'da öznitelik
  // bir şey çizmez, görünen yer tutucu ayrı öğedir. `ref` ile yazılmaz: her çizimde yeni ref geri
  // çağrısı ContentEditable'ın kökünü söküp yeniden bağlar ve imleç her tuşta başa döner.
  useEffect(
    () => editor.registerRootListener((root) => root?.setAttribute("placeholder", placeholder)),
    [editor, placeholder],
  );

  // Yalnız kurulumda ve `hydrateKey` artışında uygulanır.
  // biome-ignore lint/correctness/useExhaustiveDependencies: draft bilinçli deps dışında, yazarken kutu ezilmesin
  useEffect(() => {
    applyDraft(draft ?? emptyDraft());
    if (autoFocus) editor.focus();
  }, [hydrateKey, applyDraft, autoFocus, editor]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(t);
  }, [notice]);

  const addImages = useCallback(
    (incoming: ImageAttachment[]) => {
      if (incoming.length === 0) return;
      const r = mergeImages(draftRef.current, incoming, MAX_IMAGES);
      if (r.added > 0) commit(r.draft);
      if (r.rejected > 0) {
        setNotice(
          r.added === 0
            ? t("composer.maxImages", { count: MAX_IMAGES })
            : t("composer.maxImagesPartial", { count: MAX_IMAGES, n: r.added }),
        );
      }
      editor.focus();
    },
    [commit, t, editor],
  );

  const removeImage = useCallback(
    (i: number) => commit(removeImageAt(draftRef.current, i)),
    [commit],
  );

  const quote = useCallback(
    (text: string) => {
      commit(addQuote(draftRef.current, text));
      editor.focus();
    },
    [commit, editor],
  );

  const removeQuote = useCallback(
    (i: number) => commit(removeQuoteAt(draftRef.current, i)),
    [commit],
  );

  /** Metni kutuya yazar; yapıştırma parçaları görünen metne göre yeniden konumlanır, imleç sona gider. */
  const setText = useCallback(
    (text: string) => {
      applyDraft(syncDraft(draftRef.current, text));
      editor.focus();
    },
    [applyDraft, editor],
  );

  /** Yolları `@yol` olarak taslağa ekler; sürükleme ve ekleme menüsü aynı davranışı paylaşır. */
  const appendMentions = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) return;
      setText(withMentions(draftRef.current.text, paths));
    },
    [setText],
  );

  const pickFiles = useCallback(async () => {
    try {
      addImages(await invoke("files:pickImages", undefined));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }, [addImages]);

  useImperativeHandle(
    handleRef,
    () => ({
      attachImages: () => void pickFiles(),
      getDraft: () => draftRef.current,
      setText,
      addQuote: quote,
    }),
    [pickFiles, setText, quote],
  );

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!dragging) setDragging(true);
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragging(false);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const list = e.dataTransfer.files;
    const files = Array.from(list);
    // Görseller ek olur; kalan dosya ve klasörler taslağa `@yol` olarak girer.
    const paths = files
      .filter((f) => !isImageFile(f))
      .map((f) => pathForFile(f))
      .filter((p) => p.length > 0);
    void attachmentsFrom(list).then(addImages);
    appendMentions(paths);
    if (paths.length === 0 && !files.some(isImageFile)) setNotice(t("composer.dropFailed"));
  };

  // Yalnız alıntı gönderilmez: model neyin sorulduğunu bilemez.
  const canSend = hasMessage(view);

  /** Gönderim: çalışırken Enter yönlendirir (steer), ⌘/Ctrl+Enter tur bitimine kuyruklar (followUp). */
  const send = (queue = false) => {
    const current = draftRef.current;
    const expanded = expandDraft(current).trim();
    if ((!expanded && current.images.length === 0) || (busy && !allowWhileBusy)) return;
    // Gönderim iyimserdir: kutu hemen boşalır. Motor reddederse `restore` taslağı aynen
    // geri koyar; böylece uzun yapıştırma ve görseller kaybolmaz.
    const snapshot = current;
    const restore = (e: unknown) => {
      // Kullanıcı gönderim sürerken yeni bir şey yazdıysa onu ezme; eski taslak yalnız kutu
      // boşken geri gelir (OpenCode `submission.restore` guard'ının karşılığı).
      if (!isDraftEmpty(draftRef.current)) {
        toast.error(humanizeError(e));
        return;
      }
      // Composer bu arada kapanmış olabilir; taslak yine store'a yazılmalı ki kaybolmasın.
      applyDraft(snapshot);
      editor.focus();
      toast.error(humanizeError(e));
    };
    applyDraft(emptyDraft());
    // Geçmişe yazılır ve imleç sıfırlanır: gönderimden sonra ↑ en son gönderileni getirir.
    // Alıntı bloğu geçmişe girmez; ↑ kutuya etiketli blok metni getirirdi.
    rememberPrompt(historyKey, expanded);
    cursorRef.current = { index: null, draft: emptyDraft() };
    const message = withQuotes(expanded, snapshot.quotes, lang);
    try {
      const deliver =
        queue && busy && allowWhileBusy && onQueue
          ? onQueue(message, snapshot.images)
          : onSend(message, snapshot.images);
      void Promise.resolve(deliver).catch(restore);
    } catch (e) {
      restore(e);
    }
  };

  // Tuş ve pano işleyicileri her çizimde güncel kapanışı okur; kayıt bir kez yapılır.
  const live = useRef({ send, busy, onStop, removeImage, addImages, adopt, t });
  live.current = { send, busy, onStop, removeImage, addImages, adopt, t };

  useEffect(() => {
    /** ↑/↓ istem geçmişi: yalnız imlecin üstünde/altında satır yokken devreye girer. */
    const history = (event: KeyboardEvent, up: boolean): boolean => {
      // ↓ yalnız gezinme sürerken geçmişe aittir. Gezinme yokken ↓ satır gezinmesidir; burada
      // devam edilseydi `historyNext` boş metin döndürüp kutuyu temizlerdi.
      if (!up && cursorRef.current.index === null) return false;
      const value = $draftText();
      const range = $draftSelection();
      if (!range || !atHistoryEdge(value, range.start, range.end, up ? "up" : "down")) return false;
      const list = historyFor(historyKey);
      if (list.length === 0) return false;
      // Generic açıkça verilir: koşullu ifadede çıkarım varsayılana (`string`) düşüyor.
      const step: HistoryStep<ComposerDraft> = up
        ? historyPrev<ComposerDraft>(list, cursorRef.current, draftRef.current)
        : historyNext<ComposerDraft>(list, cursorRef.current);
      // Liste başında/sonunda yapılacak bir şey yok: varsayılan davranış kalsın (imleç kaysın).
      if (step.cursor.index === cursorRef.current.index && step.text === value) return false;
      event.preventDefault();
      cursorRef.current = step.cursor;
      // Taslağa dönüş: yapıştırma parçaları ve görseller de geri gelir.
      const next =
        step.cursor.index === null ? step.cursor.draft : syncDraft(draftRef.current, step.text);
      live.current.adopt(next);
      $addUpdateTag(QUIET_TAG);
      $writeDraft(next.text, next.pastes);
      return true;
    };

    /** Pano: taslak metni yazılır ki etiketler görünen adıyla değil değeriyle (`/plan`) kopyalansın. */
    const copy = (event: ClipboardEvent | KeyboardEvent | null, cut: boolean): boolean => {
      if (!(event instanceof ClipboardEvent) || !event.clipboardData) return false;
      const range = $draftSelection();
      if (!range || range.start === range.end) return false;
      event.preventDefault();
      event.clipboardData.setData("text/plain", $draftText().slice(range.start, range.end));
      const selection = $getSelection();
      if (cut && $isRangeSelection(selection)) selection.removeText();
      return true;
    };

    return mergeRegister(
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event) => {
          if (!event || event.shiftKey || event.isComposing) return false;
          event.preventDefault();
          live.current.send(event.metaKey || event.ctrlKey);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_ESCAPE_COMMAND,
        (event) => {
          const { busy: running, onStop: stop } = live.current;
          if (!running || !stop) return false;
          // Oturum ekranının pencere düzeyindeki Esc'i aynı turu ikinci kez durdurmasın.
          event?.preventDefault();
          stop();
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(
        KEY_BACKSPACE_COMMAND,
        (event) => {
          const images = draftRef.current.images;
          if ($draftText() !== "" || images.length === 0) return false;
          event.preventDefault();
          live.current.removeImage(images.length - 1);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_ARROW_UP_COMMAND,
        (event) => history(event, true),
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_ARROW_DOWN_COMMAND,
        (event) => history(event, false),
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        PASTE_COMMAND,
        (event) => {
          if (!(event instanceof ClipboardEvent) || !event.clipboardData) return false;
          const items = event.clipboardData.items;
          const hasImage = Array.from(items).some(
            (it) => it.kind === "file" && it.type.startsWith("image/"),
          );
          if (hasImage) {
            event.preventDefault();
            void attachmentsFrom(items).then(live.current.addImages);
            return true;
          }
          const raw = event.clipboardData.getData("text/plain");
          // Kısa metin editörün kendi yapıştırmasıyla akar; yalnız uzun yapıştırma etikete döner.
          if (!raw || !shouldCollapsePaste(raw)) return false;
          const selection = $getSelection();
          const range = $draftSelection();
          if (!$isRangeSelection(selection) || !range) return false;
          event.preventDefault();
          const text = normalizePaste(raw);
          const label = uniquePlaceholder(
            draftRef.current.pastes,
            live.current.t("composer.pastedLines", { count: pasteLineCount(text) }),
          );
          // Parça önce taslağa yazılır: güncelleme dinleyicisi yer tutucuyu bu kayıtla eşler.
          live.current.adopt(insertPaste(draftRef.current, text, label, range.start, range.end));
          selection.insertNodes([$createTokenNode("paste", label)]);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(COPY_COMMAND, (event) => copy(event, false), COMMAND_PRIORITY_HIGH),
      editor.registerCommand(CUT_COMMAND, (event) => copy(event, true), COMMAND_PRIORITY_HIGH),
      // Dosya bırakma kutunun kendi işleyicisinde (görsel ek + `@yol`); editör yol metni yazmasın.
      editor.registerCommand(
        DROP_COMMAND,
        (event) => Array.from(event.dataTransfer?.types ?? []).includes("Files"),
        COMMAND_PRIORITY_HIGH,
      ),
    );
  }, [editor, historyKey]);

  const stopBtn = (
    <button
      type="button"
      onClick={onStop}
      title={t("composer.stopTitle")}
      className="flex shrink-0 items-center justify-center rounded-full bg-acc text-onAcc hover:opacity-85"
      style={{ width: size, height: size }}
    >
      <Icon name="stop" size={size * 0.42} fill />
    </button>
  );
  const sendBtn = busy ? (
    allowWhileBusy && canSend ? (
      <div className="flex items-center gap-[6px]">
        {stopBtn}
        <button
          type="button"
          onClick={() => send()}
          title={t("composer.redirectTitle")}
          className="flex shrink-0 items-center justify-center rounded-full border border-line2 text-tx2 hover:bg-hov"
          style={{ width: size, height: size }}
        >
          <Icon name="send" size={size * 0.5} stroke={2.2} />
        </button>
      </div>
    ) : (
      stopBtn
    )
  ) : (
    <button
      type="button"
      onClick={() => send()}
      title={t("composer.sendTitle")}
      className="flex shrink-0 items-center justify-center rounded-full bg-acc text-onAcc"
      style={{
        width: size,
        height: size,
        opacity: canSend ? 1 : 0.35,
        cursor: canSend ? "pointer" : "default",
      }}
    >
      <Icon name="send" size={size * 0.5} stroke={2.2} />
    </button>
  );

  const attachBtn = hideAttach ? null : (
    <button
      type="button"
      onClick={() => void pickFiles()}
      title={t("composer.attachTitle")}
      className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px] text-tx3 hover:bg-hov hover:text-tx"
    >
      <Icon name="image" size={15} stroke={1.7} />
    </button>
  );

  const editable = (
    <div className="relative" style={{ minHeight: v.minHeight }}>
      <PlainTextPlugin
        contentEditable={
          <ContentEditable
            aria-placeholder={placeholder}
            aria-label={placeholder}
            placeholder={
              <div className="pointer-events-none absolute top-0 left-0 select-none text-[14px] leading-[1.5] text-tx3">
                {placeholder}
              </div>
            }
            className="w-full whitespace-pre-wrap break-words text-[14px] leading-[1.5] text-tx outline-none"
            style={{ maxHeight, overflowY: "auto" }}
          />
        }
        ErrorBoundary={LexicalErrorBoundary}
      />
      <HistoryPlugin />
    </div>
  );

  const quotes =
    view.quotes.length > 0 ? (
      <div className="flex flex-col gap-[6px]">
        {view.quotes.map((q, i) => (
          <div
            key={q}
            className="group flex items-start gap-2 rounded-[8px] border border-line bg-bg py-[6px] pr-[6px] pl-[10px]"
          >
            <Icon name="quote" size={13} stroke={1.7} className="mt-[3px] shrink-0 text-tx3" />
            <div
              title={q}
              className="line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap break-words text-[13px] leading-[1.5] text-tx2"
            >
              {q}
            </div>
            <button
              type="button"
              onClick={() => removeQuote(i)}
              title={t("composer.removeQuote")}
              aria-label={t("composer.removeQuote")}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] text-tx3 hover:bg-hov hover:text-tx"
            >
              <Icon name="x" size={11} stroke={2} />
            </button>
          </div>
        ))}
      </div>
    ) : null;

  const strip =
    view.images.length > 0 || notice || (view.images.length > 0 && !vision) ? (
      <div className="flex flex-col gap-[6px]">
        {view.images.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {view.images.map((img, i) => (
              <div
                key={`${i}-${img.data.length}`}
                className="group relative h-[64px] w-[64px] overflow-hidden rounded-[8px] border border-line2 bg-bg"
                title={`${img.name ?? t("composer.imageAlt")} · ${approxKb(img)} KB`}
              >
                <img
                  src={dataUrl(img)}
                  alt={img.name ?? t("composer.imageAlt")}
                  className="h-full w-full cursor-zoom-in object-cover"
                  onClick={() => openLightbox(dataUrl(img))}
                />
                <button
                  type="button"
                  onClick={() => removeImage(i)}
                  title={t("composer.remove")}
                  className="absolute top-[3px] right-[3px] flex h-[18px] w-[18px] items-center justify-center rounded-full bg-black/70 text-white opacity-0 group-hover:opacity-100"
                >
                  <Icon name="x" size={10} stroke={2.4} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {view.images.length > 0 && !vision ? (
          <div className="text-[12px] text-amber">{t("composer.noVision")}</div>
        ) : null}
        {notice ? <div className="text-[12px] text-tx3">{notice}</div> : null}
      </div>
    ) : null;

  const dropCls = dragging ? "border-accLine ring-1 ring-accLine" : "border-line2";

  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      // `/model` ve `/mode` gibi komutlar seçiciyi bu kutunun üstünde açar: kutu kendini çapa
      // olarak kaydeder (bkz. `lib/commandAnchor.ts`). Komut çalıştırıcısı React ağacının
      // dışında yaşadığı için ölçülen dikdörtgen bu köprüden geçer.
      ref={commandAnchor ? (el) => setComposerAnchor(el) : undefined}
      // Hiza ölçen e2e testi bu kimliği kullanır (bkz. `TEST_IDS.composerBox`).
      {...testId(TEST_IDS.composerBox)}
      className={`cz-composer relative flex flex-col border bg-card ${v.box} ${dropCls}`}
    >
      {slash ? <SlashPlugin source={slash} /> : null}
      {quotes}
      {strip}
      {editable}
      <div className={`flex items-center ${v.row}`}>
        {left}
        {attachBtn}
        <span className="flex-1" />
        {right}
        {sendBtn}
      </div>
    </div>
  );
}
