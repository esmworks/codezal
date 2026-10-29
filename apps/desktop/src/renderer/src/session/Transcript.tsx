import {
  type AssistantItem,
  type ExtensionUiValue,
  isAbsolutePath,
  itemTime,
  joinPath,
  type PlanDecision,
  promptQuotes,
  type QuestionAnswers,
  TEST_IDS,
  type ToolCallItem,
  type TranscriptItem,
  testId,
} from "@codezal/contracts";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../api";
import { Clamp } from "../components/Clamp";
import { CopyButton } from "../components/CopyButton";
import { ErrorBar, splitError } from "../components/ErrorBar";
import { Icon } from "../components/Icon";
import { useLightbox } from "../components/Lightbox";
import { Markdown, OpenPathContext } from "../components/Markdown";
import { Working } from "../components/Working";
import { clearFind, paintFind } from "../lib/findHighlight";
import { CHAT_COLUMN, chatPadRight } from "../lib/floatPanel";
import { formatElapsed, formatTurnDuration } from "../lib/format";
import { useLocale } from "../lib/i18n";
import { dataUrl } from "../lib/images";
import { isBackgroundLaunch } from "../lib/jobs";
import { looksLikePath, resolveMention } from "../lib/mentions";
import { findExpandedRuns, findLiveRows, type RunGroup } from "../lib/openRuns";
import { forgetMissingPaths } from "../lib/pathExists";
import { collapsePrompt } from "../lib/promptText";
import { useScrollAnchor } from "../lib/scrollAnchor";
import { collapseRetries, firstErrorDetail, planRun } from "../lib/toolGroups";
import {
  type FindTarget,
  findMatches,
  firstMatchFrom,
  pickMatch,
  stepMatch,
} from "../lib/transcriptFind";
import { findTurnEnds } from "../lib/turnEnds";
import { buildPreviewText, resolveAssistantPreview } from "../lib/turnPreview";
import { liveSegmentStart, mergeTurnRuns } from "../lib/turnRuns";
import { useCollapseOnDone } from "../lib/useCollapseOnDone";
import { useSmoothText } from "../lib/useSmoothText";
import {
  RowHeightCache,
  sumRowHeights,
  VIRTUAL_MIN_ROWS,
  type VirtualWindow,
  virtualWindow,
} from "../lib/virtualWindow";
import { useFind } from "../stores/find";
import { useModels } from "../stores/models";
import { usePaths } from "../stores/paths";
import type { ForkPoint, SessionRuntime } from "../stores/sessions";
import { useSettings } from "../stores/settings";
import { toast } from "../stores/toast";
import { AgentBadgeProvider } from "./AgentBadge";
import { AgentReviewCards } from "./AgentReviewPanel";
import { ExtensionUiCard } from "./ExtensionUiCard";
import { FindBar } from "./FindBar";
import { MarkerRow } from "./MarkerRow";
import { PermissionCard } from "./PermissionCard";
import { PlanReviewCard } from "./PlanReviewCard";
import { PromptText } from "./PromptText";
import { QuestionCard } from "./QuestionCard";
import { ReviewCard } from "./ReviewCard";
import { ScheduleCards } from "./ScheduleCard";
import { SelectionReply } from "./SelectionReply";
import { ROW_CLASS, RowChevron, ToolCard, ToolGroup } from "./ToolCard";
import { TurnFiles } from "./TurnFiles";
import { type RailItem, TurnRail } from "./TurnRail";

/** Sanallaştırmada satır aralığı: `gap-5` (20px) yerine satır dolgusu, ölçüm boşluğu da kapsasın. */
const ROW_SPACING_CLASS = "pb-5";
/** Mesaja atlarken üstte bırakılan pay: satır kabın en üstüne yapışmaz. */
const JUMP_TOP_PAD = 26;

/**
 * Satırın **kararlı** anahtarı. Pencere hesabı (`rowKeys`), ölçüm önbelleği ve DOM'daki
 * `data-anchor-key` aynı anahtarı kullanmak zorunda: ayrışırsa ölçülen yükseklik önbellekte
 * aranmayan bir anahtara yazılır ve o satırlar pencere hesabında hep tahminle temsil edilir
 * (sohbetin toplam yüksekliği tutmaz, kaydırma zıplar).
 */
export function rowKeyOf(group: RunGroup, index: number): string {
  if (Array.isArray(group)) return `g-${group[0]?.id ?? index}`;
  if (group.type === "user") return `u-${group.id}`;
  if (group.type === "marker") return `m-${group.id}`;
  return `a-${group.id}`;
}

interface Props {
  rt: SessionRuntime;
  onDecide: (requestId: string, decision: "allow" | "deny" | "allow-session") => void;
  /** Plan onay kartı (`plan_exit`): onay ya da geri bildirimli ret. */
  onPlanDecide: (requestId: string, decision: PlanDecision) => void;
  /** Soru kartı (`question`): soru başına seçilen etiketler + serbest metin. */
  onQuestionAnswer: (requestId: string, answers: QuestionAnswers) => void;
  /** Eklenti `ctx.ui` kartı: confirm/select/input cevabı eklentiye döner. */
  onExtensionUi?: ((requestId: string, value: ExtensionUiValue) => void) | undefined;
  /** Dallandır: verilen noktaya kadar olan konuşmayı yeni oturuma kopyalar. */
  onFork?: ((at: ForkPoint) => void) | undefined;
  /** Geri sar: N. kullanıcı mesajının öncesine döner, metni yazma kutusuna koyar. Çalışırken kapalı. */
  onRewind?: ((userOrdinal: number) => void) | undefined;
  /** Verilirse her turun altında o turda oluşturulan/değişen dosyalar listelenir. */
  cwd?: string | undefined;
  /** Tur altı listesinden ve metindeki yol çiplerinden "Aç": asistan görüntüleyici, kodlamada Dosyalar sekmesi. */
  onOpenFile?: ((path: string) => void) | undefined;
  /** Metinde geçen göreli yolların deneneceği kökler (cwd'den önce, örn. çıktı klasörü). */
  openRoots?: readonly string[] | undefined;
  /** Konuşma dışından bilinen dosyalar (çıktı klasöründekiler); çıplak ad bunlara da bağlanır. */
  knownPaths?: readonly string[] | undefined;
  /** Tur altı "Geri al": N. kullanıcı mesajının turundaki dosya değişikliklerini döndürür. */
  onUndo?:
    | ((userOrdinal: number) => Promise<{ restored: string[]; removed: string[] }>)
    | undefined;
  /** Kod incelemesi koşusunu başlatmak için oturum kimliği; yoksa İncele düğmesi görünmez. */
  sessionId?: string | undefined;
  /** Hata bandındaki ✕: bandı kapatır (sonraki hata olayına kadar gizli kalır). */
  onDismissError?: (() => void) | undefined;
  /**
   * Sağda yüzen panelin genişliği. Kaydırma kabı bu kadar sağa uzatılır: içerik yine aynı
   * kolonda durur ama dikey kaydırma çubuğu pencere kenarına yapışır (panel sütun değilse 0).
   */
  reserveRight?: number | undefined;
  /** Asistan metninde seçim yapılınca "Yanıtla": seçili metin yazma kutusuna alıntı olarak gider. */
  onQuote?: ((text: string) => void) | undefined;
  /** Seçim menüsündeki "Yan sohbet": seçili metinle yan sohbet açar; verilmezse düğme görünmez. */
  onSideChat?: ((text: string) => void) | undefined;
  /**
   * Dar yüzen panelde (yan sohbet) çizim: mesaj çubuğu yok, üst pay ve kolon dolgusu dar, düzen
   * ölçen e2e kimlikleri ana sohbete kalır.
   */
  compact?: boolean | undefined;
  /**
   * Sohbet içi bulmanın (⌘F) bağlı olduğu oturum. Verilmezse bulma çubuğu bu transkriptte hiç
   * açılmaz (yan sohbet paneli ana oturumun çubuğunu paylaşmasın).
   */
  findKey?: string | undefined;
}

/** Kullanıcı bu alanda metin seçmiş mi; seçmişse otomatik kaydırma seçimi bozmamak için durur. */
function hasSelection(el: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  return el.contains(selection.getRangeAt(0).commonAncestorContainer);
}

/** Bir çalışma dizisi: araç kartları ve aralarındaki ara anlatımlar. */
type Run = Array<ToolCallItem | AssistantItem>;

/** Gruplardaki diziler yalnızca araç ve asistan mesajı taşır; tür daraltması çizimde yapılır. */
function isRunItem(i: TranscriptItem): i is ToolCallItem | AssistantItem {
  return i.type === "tool" || i.type === "assistant";
}

/**
 * Çalışma dizisinin süresi: ilk adımın başlangıcından son biten adıma. Yanıtın kendi üretimi
 * dışarıda kalır, o süre tur sonundaki model satırında zaten yazar.
 */
function runDuration(run: Run): number | undefined {
  let start = Number.POSITIVE_INFINITY;
  let end = 0;
  for (const i of run) {
    const from = i.type === "tool" ? i.startedAt : i.at;
    const to = i.type === "tool" ? (i.endedAt ?? i.startedAt) : i.at;
    if (from > 0) start = Math.min(start, from);
    end = Math.max(end, to);
  }
  return Number.isFinite(start) && end > start ? end - start : undefined;
}

/**
 * Çalışma dizisi. Tur sürerken adımlar açık akar; tamamlanan tur tek satıra katlanır
 * ("2 dk 14 sn çalıştı · 5 işlem · 2 okundu · 1 arandı", sağdaki oktan yeniden açılır).
 * Yarım kalan ya da hatalı biten tur katlanmaz, adımlarıyla açık kalır.
 */
function RunBlock({
  run,
  cwd,
  home,
  lang,
  endIds,
  live,
  liveMs,
  turnMs,
  keepOpen,
  onOpenFile,
  reveal = false,
}: {
  /** Bulmanın geçerli eşleşmesi bu dizideyse katlı dizi açılır (eşleşme görünsün). */
  reveal?: boolean;
  run: Run;
  cwd: string;
  home: string;
  lang: "tr" | "en";
  /** Kart içindeki "Dosyada aç" buradan geçer; sohbet panelini açıp dosyayı önizler. */
  onOpenFile?: ((path: string) => void) | undefined;
  /** Tur sonu mesajları: diziye yalnızca düşünmeleri için girer, metinleri aşağıda çizilir. */
  endIds: ReadonlySet<string>;
  /** Bu dizi süren turun dizisi mi; öyleyse başlık "sürüyor" der ve açık kalır. */
  live: boolean;
  /** Süren turun işaretli geçen süresi; başlıktaki sayaç bundan işler. */
  liveMs?: number | undefined;
  /** Turun süresi (kullanıcı mesajı → yanıt); yanıt altındaki satırla aynı sayı görünsün. */
  turnMs?: number | undefined;
  /** Tur tamamlanmadan bitti (Esc/Durdur, boş yanıt, API hatası): katlanmaz, adımlar açık kalır. */
  keepOpen: boolean;
}) {
  const { t } = useTranslation();
  const tools = run.filter((i): i is ToolCallItem => i.type === "tool");
  // Arka plan komutu başlatan dizi tur bitince katlanmaz: komut hâlâ sürüyor olabilir ve başlatan
  // satır sohbetten kaybolunca iş "ortadan kalkmış" gibi görünüyordu. Kullanıcı yine katlayabilir.
  const pinned = tools.some(isBackgroundLaunch);
  const [open, setOpen] = useState(pinned);
  useEffect(() => {
    if (pinned || reveal) setOpen(true);
  }, [pinned, reveal]);
  const entries = collapseRetries(tools);
  // Düşünme satırları listede **kalır**: model aracı çağırmadan önce kısa bir düşünme turu
  // yapıyor ve o satırlar araç dizisini bölüyor. Eskiden burada gizleniyorlardı; sonuç, araya
  // giren düşünmelerin görünmez olması ve iki ayrı araç dizisinin tek gruba yutulmasıydı
  // ("5 çalıştırıldı" gibi). ZCode da düşünme satırını dizide tutar: "Thought" satırı araç
  // satırlarının arasında durur ve grupları oradan böler.
  const visible = run.filter(
    (i) =>
      i.type === "tool" ||
      (!endIds.has(i.id) && (i.text.trim().length > 0 || Boolean(i.thinking?.trim()))),
  );
  // Süren turda da bitmiş turda da aynı kural işler (ZCode'un kuralı): her çağrı kendi satırında
  // doğar, yalnız ardışık keşif (okuma/arama) ve terminal çağrıları ikinci çağrıdan itibaren tek
  // satıra katlanır. Eskiden süren turun **tamamı** tek satıra toplanıyordu: araçlar tek tek
  // görünmüyor, satır her araçta baştan yazılıyordu. Tur bitince dizi "X sn çalıştı" başlığına
  // katlanır; içerideki adımlar yine bu kurala göre çizilir.
  const steps = planRun(visible, { live });
  // Adım aralığı OpenChamber yoğunluğunda (kaynağında satırlar arası boşluk 0–4px, satır yüksekliği
  // 28px). Eskiden 16px'ti ve araç listesi seyrek görünüyordu; satır yüksekliği korunur, yalnız
  // aralık kısalır. Ara anlatım metni kendi dolgusuyla (aşağıda py-2) nefes payını korur.
  const sequence = (
    <div className="flex flex-col gap-[2px]">
      {steps.map((s, si) => {
        if (s.type === "assistant") {
          const i = s.item;
          const text = i.text.trim();
          const thinking = i.thinking?.trim();
          if (!text && !thinking) return null;
          // Düşünme satırı **her** öğede çizilir: düşünmesi de metni de olan ara anlatımda da
          // görünür. Eskiden metin varsa yalnız metin basılıyordu ve düşünme satırı kayboluyordu
          // (aynı turda bazı düşünmeler görünüp bazıları gizleniyordu). Düz metin yolu yalnız
          // düşünmesi olmayan, akışı bitmiş öğeler için: orada kademeli yazım makinesi kurulmaz.
          // Dikey pay yalnız metnin çevresinde: "Düşündü" satırı da bu payı alınca araç dizisinin
          // ritmi 45/53px diye bozuluyordu. Düşünme satırı araç satırıyla aynı adımda durur; metin
          // varsa altına (düşünme yoksa üstüne de) 8px nefes payı konur.
          const pad = text ? (thinking ? "pb-2" : "py-2") : undefined;
          return (
            <div key={i.id} className={pad}>
              {i.streaming || thinking ? (
                <AssistantBlock item={i} />
              ) : (
                <div data-quotable>
                  <Markdown text={text} />
                </div>
              )}
            </div>
          );
        }
        if (s.type === "group")
          return (
            <ToolGroup
              // Kimlik dizinin ilk çağrısında: satır büyürken yerinde kalır, yeniden doğmaz.
              key={s.entries[0]?.anchorId ?? ""}
              entries={s.entries}
              cwd={cwd}
              home={home}
              lang={lang}
              // Canlı biçim yalnız turun **son** adımına aittir (ZCode'un kuralı: grup, süren işin
              // kuyruğu olduğu sürece canlıdır). Önceki gruplar kapanmıştır: sayaçları yazılır.
              live={live && si === steps.length - 1}
              onOpen={onOpenFile}
            />
          );
        return (
          <ToolCard
            key={s.entry.anchorId}
            item={s.entry.item}
            attempts={s.entry.attempts}
            cwd={cwd}
            home={home}
            onOpen={onOpenFile}
          />
        );
      })}
    </div>
  );
  if (tools.length === 0) return sequence;

  const hasError = entries.some((e) => e.item.status === "error" || e.item.status === "denied");
  // Hatanın ne olduğu kart açılmadan görünsün: ilk hatalı araç ve çıktısının ilk satırı.
  const errorDetail = hasError ? firstErrorDetail(entries, cwd, t("tool.notRun")) : undefined;
  // Başlık ZCode'un satırıdır: sürerken "Working for 12s", bitince "Worked for 6m 36s", süre
  // ölçülemezse yalnız "Worked". Başlıkta **sayaç yoktur**: kaç işlem olduğu açılan dizideki grup
  // satırlarında yazar ("2 okundu · 1 arandı"); ZCode'da da sayım oradadır.
  // Süre turun kendisinden: yanıtın altındaki "model · 6,1 sn" satırı da aynı ölçüyü yazar, iki
  // satır aynı tur için farklı sayı göstermez. Ölçü yoksa dizi süresine düşülür.
  const ms = live ? liveMs : (turnMs ?? runDuration(run));
  const duration = ms === undefined ? "" : formatTurnDuration(ms, lang);
  const label =
    ms === undefined
      ? live
        ? t("transcript.working")
        : t("transcript.worked")
      : live
        ? t("transcript.workingFor", { duration })
        : t("transcript.workedFor", { duration });
  // Katlanma yalnız tamamlanan turda: süren ve yarım kalan dizi açık akar ve **oku olmaz**
  // (ZCode açık tuttuğu grupta oku hiç çizmez; ok yalnız katlanabilen satırda görünür).
  const collapsible = !live && !keepOpen;
  const head = (
    <>
      <span className="shrink-0 font-medium text-tx2">{label}</span>
      <span className="min-w-0 truncate text-tx3">{errorDetail ?? ""}</span>
      {collapsible ? <RowChevron open={open} always /> : null}
    </>
  );
  const headClass =
    "group/row flex w-full items-center gap-2 border-line border-b pb-[9px] text-left text-[14px]";
  return (
    <div className="flex flex-col gap-5">
      {collapsible ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title={t("transcript.workedToggle")}
          className={headClass}
        >
          {head}
        </button>
      ) : (
        <div className={headClass}>{head}</div>
      )}
      {!collapsible || open ? sequence : null}
    </div>
  );
}

/**
 * Turun başlığı ("5 sn çalıştı"): dizisi olmayan turlarda (yalnız düşünme + yanıt) yanıtın üstünde
 * durur. ZCode'da bu satır her turda vardır — araç çalışmasa bile — ve tur sürerken "Working for
 * 12s" der. Katlanacak bir dizi olmadığı için ok çizilmez (ZCode oku yalnız katlanabilen grupta
 * gösterir).
 */
function TurnHead({
  item,
  live,
  liveMs,
  lang,
}: {
  item: AssistantItem;
  live: boolean;
  liveMs: number;
  lang: "tr" | "en";
}) {
  const { t } = useTranslation();
  // Süre turun kendisinden: kullanıcı mesajından bu yanıta kadar geçen süre (`durationMs`).
  const ms = live ? liveMs : item.durationMs;
  const duration = ms === undefined ? "" : formatTurnDuration(ms, lang);
  const label =
    ms === undefined
      ? live
        ? t("transcript.working")
        : t("transcript.worked")
      : live
        ? t("transcript.workingFor", { duration })
        : t("transcript.workedFor", { duration });
  return (
    <div className="flex w-full items-center gap-2 border-line border-b pb-[9px] text-[14px]">
      <span className="shrink-0 font-medium text-tx2">{label}</span>
    </div>
  );
}

/**
 * Katlanmış düşünme satırında gösterilen özet: son dolu satırın kuyruğu. ZCode da katlı hâlde
 * akan metnin son satırını gösterir; en yeni token'lar sağda kaldığı için kuyruk alınır.
 */
export function thoughtSummary(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const last =
    [...lines]
      .reverse()
      .find((l) => l.trim().length > 0)
      ?.trim() ?? "";
  return last.length > 120 ? `…${last.slice(-119)}` : last;
}

/**
 * Düşünme süresi: akarken saniye saniye artar, akış bitince donar. Katlıyken sayaç kurulmaz
 * (ZCode'un reasoning tetikleyicisi de yalnız açıkken her saniye yeniden çizer).
 */
function useThoughtSeconds(live: boolean, open: boolean): number | undefined {
  const startedAt = useRef<number | null>(null);
  const [seconds, setSeconds] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!live) {
      if (startedAt.current !== null)
        setSeconds(Math.max(1, Math.round((Date.now() - startedAt.current) / 1000)));
      startedAt.current = null;
      return;
    }
    if (startedAt.current === null) startedAt.current = Date.now();
    if (!open) return;
    const tick = () =>
      setSeconds(Math.max(1, Math.round((Date.now() - (startedAt.current ?? Date.now())) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [live, open]);
  return seconds;
}

/**
 * Düşünme bölümü (ZCode'un düşünme satırı): beyin ikonu, "Düşünüyor" ve akan son satır; akış
 * bitince "Düşündü · 3 sn" olarak katlanır. Eskiden düşünürken tam metin açılıyordu; düşünmeli
 * modeller araçlar arasında saniyeler süren kısa düşünme döngüleri kurduğu için blok açılıp
 * anında katlanıyor ve metin arayüzde hızlı yanıp sönen yazı gibi görünüyordu. Tam metin yine
 * oktan açılır; akan satır kuyruğu gösterir (en yeni token'lar orada).
 */
function ThinkingBlock({ thinking, live }: { thinking: string; live: boolean }) {
  const { t } = useTranslation();
  const lang = useLocale();
  // Canlı düşünme kendiliğinden açılmaz: kısa döngülerde açılıp kapanma (yanıp sönme)
  // yaratmasın diye hep katlı başlar; içerik kullanıcı isterse oktan açılır.
  const [open, setOpen] = useState(false);
  useCollapseOnDone(!live, setOpen);
  const text = useSmoothText(thinking, live);
  const seconds = useThoughtSeconds(live, open);
  const summary = live && !open ? thoughtSummary(text) : "";
  // Süre yalnız açıkken (sayaç işlerken) ya da akış bittiğinde yazılır; katlı akışta saniye
  // saniye yeniden çizim yok. Geçmişten gelen düşünmenin ölçüsü yoktur: satır yalnız "Düşündü"
  // der. Eskiden "birkaç saniye" yazıyordu; hemen üstteki tur başlığı ("14 sn çalıştı") kesin
  // süreyi verirken ikinci, muğlak bir süre çelişkili görünüyordu.
  const duration =
    seconds !== undefined && (open || !live) ? formatElapsed(seconds * 1000, lang) : "";
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={t("transcript.thinkingToggle")}
        aria-expanded={open}
        className={`${ROW_CLASS} min-w-0`}
      >
        <Icon name="brain" size={16} className="text-tx3" />
        <span className={`shrink-0 font-medium ${live ? "cz-shimmer" : "text-tx3"}`}>
          {live ? t("transcript.thinkingStatus") : t("transcript.thought")}
        </span>
        {duration ? (
          <>
            <span className="shrink-0 text-tx3">·</span>
            <span className="shrink-0 text-tx3">{duration}</span>
          </>
        ) : null}
        {summary ? (
          <>
            <span className="shrink-0 text-tx3">·</span>
            <span className="min-w-0 truncate text-tx3">{summary}</span>
          </>
        ) : null}
        <RowChevron open={open} />
      </button>
      {open ? (
        // Gövde yüksekliği sınırlı: uzun düşünme sohbeti sonsuza kadar uzatmasın (ZCode kuralı).
        <div className="ml-2 max-h-60 overflow-auto whitespace-pre-wrap border-line2 border-l pl-3.5 text-[14px] leading-[1.7] text-tx3">
          {text}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Asistan bloğu: düşünme (katlanabilir, akarken açık) ve yanıt metni.
 */
/**
 * `memo`: akış sırasında yalnız **son** asistan bloğu değişir (indirgeyici dokunulmayan öğelerin
 * kimliğini korur), ama üst bileşen her parça karesinde yeniden çizildiği için uzun bir oturumda
 * bütün eski yanıtlar da yeniden çiziliyordu. Ezberleme bunu tek bloğa indirir.
 */
const AssistantBlock = memo(function AssistantBlock({ item }: { item: AssistantItem }) {
  const text = useSmoothText(item.text, item.streaming);
  // Düşünme, yanıt metni başlamadan akarken canlıdır: ekranda ilerleyen tek şey odur.
  const live = item.streaming && !item.text.trim() && Boolean(item.thinking);
  return (
    // Düşünme satırından metne 12px: Markdown'ın blok arasıyla aynı (eskiden 20px, geçiş kopuk).
    <div className="flex flex-col gap-3">
      {item.thinking ? <ThinkingBlock thinking={item.thinking} live={live} /> : null}
      {text ? (
        // Seçim menüsü ("Yanıtla") yalnız bu işaretli bloklarda açılır; düşünme ve araçlar dışarıda.
        <div data-quotable>
          <Markdown text={text} />
        </div>
      ) : null}
    </div>
  );
});

/** Tur sonu eylem satırı: Kopyala, dallandır, model ve süre. Dosya kartlarının altında durur. */
function AssistantActions({
  item,
  ordinal,
  onFork,
  lang,
}: {
  item: AssistantItem;
  /** Metinli asistan mesajları arasındaki sıra (1'den); dallandırma için. */
  ordinal: number;
  onFork: ((at: ForkPoint) => void) | undefined;
  lang: "tr" | "en";
}) {
  const { t } = useTranslation();
  // Katalogdaki görünen ad; yoksa model kimliği. Tam "sağlayıcı/kimlik" ipucunda.
  const displayName = useModels((s) =>
    item.model
      ? s.catalog.find(
          (c) => c.id === item.model && (!item.provider || c.provider === item.provider),
        )?.name
      : undefined,
  );
  if (item.streaming || (!item.model && item.durationMs === undefined)) return null;
  const full = `${item.provider ? `${item.provider}/` : ""}${item.model ?? ""}`;
  return (
    // ZCode'un eylem satırı gibi: durağan hâlde görünmez, turun üzerine gelince (ya da içindeki
    // düğme odaklanınca) belirir. Böylece yanıtın altındaki boşluk ZCode ile aynı kalır; eskiden
    // "model · süre" satırı hep görünür olduğu için composer'a olan boşluk dar görünüyordu.
    <div className="flex items-center gap-[2px] text-tx3 opacity-0 transition-opacity group-hover/turn:opacity-100 focus-within:opacity-100">
      <CopyButton
        text={item.text}
        className="flex h-6 w-6 items-center justify-center rounded-[6px] hover:bg-hov hover:text-tx"
      />
      {onFork && ordinal > 0 ? (
        <button
          type="button"
          title={t("transcript.forkTitle")}
          onClick={() => onFork({ assistantOrdinal: ordinal })}
          className="flex h-6 w-6 items-center justify-center rounded-[6px] hover:bg-hov hover:text-tx"
        >
          <Icon name="branch" size={14} stroke={1.6} />
        </button>
      ) : null}
      <span className="pl-2 text-[12px]" title={full}>
        {displayName ?? item.model ?? ""}
        {item.durationMs !== undefined ? ` · ${formatTurnDuration(item.durationMs, lang)}` : ""}
      </span>
    </div>
  );
}

/**
 * Kullanıcı balonu; altında üzerine gelince görünen Kopyala / Geri sar / Dallandır satırı.
 * `memo`: balonlar hiç değişmez ama akış sırasında üst bileşen her karede yeniden çiziliyor;
 * çağıran `onRewind`/`onFork` kimliklerini `useCallback` ile sabitler.
 */
const UserBubble = memo(function UserBubble({
  item,
  ordinal,
  onRewind,
  onFork,
  space,
}: {
  item: Extract<TranscriptItem, { type: "user" }>;
  /** Kullanıcı mesajları arasındaki sıra (1'den). */
  ordinal: number;
  onRewind: ((userOrdinal: number) => void) | undefined;
  onFork: ((at: ForkPoint) => void) | undefined;
  /** Sanallaştırmada satır altı boşluk sınıfı; ölçüm boşluğu da kapsasın diye balonun kendisinde. */
  space?: string;
}) {
  const { t } = useTranslation();
  const openLightbox = useLightbox((s) => s.open);
  const images = item.images ?? [];
  // Modele giden talimat blokları balonda çizilmez: kullanıcı yazdığını (komut etiketiyle) görür,
  // kopyala da aynı metni verir.
  const text = useMemo(() => collapsePrompt(item.text), [item.text]);
  const quotes = useMemo(() => promptQuotes(item.text), [item.text]);
  const iconBtn =
    "flex h-6 w-6 items-center justify-center rounded-[6px] hover:bg-hov hover:text-tx";
  return (
    <div
      id={`msg-${item.id}`}
      data-anchor-key={`u-${item.id}`}
      // Üst boşluk **dolgu**: kenar boşluğu (margin) ölçülen kutuya girmez, sanallaştırmanın
      // yükseklik modeli her kullanıcı satırını 4px eksik sayardı.
      className={`group pt-1 flex max-w-xl flex-col items-end gap-2 self-end ${space ?? ""}`}
    >
      {images.length > 0 ? (
        <div className="flex flex-wrap justify-end gap-[6px]">
          {images.map((img, i) => (
            <img
              key={`${item.id}-${i}`}
              src={dataUrl(img)}
              alt={img.name ?? t("transcript.imageAlt")}
              onClick={() => openLightbox(dataUrl(img))}
              className="max-h-[180px] max-w-[260px] cursor-zoom-in rounded-[10px] border border-line2 object-cover"
            />
          ))}
        </div>
      ) : null}
      {/* Balon ZCode'un kullanıcı balonu: dolgu rengi kutu, sağ üst köşe daha az yuvarlak. */}
      {text || quotes.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-xl rounded-tr-[4px] border border-line bg-card px-4 py-3 text-[14px] leading-[1.6]">
          {quotes.map((q) => (
            // "Yanıtla" alıntısı: soru metninin üstünde, soluk ve üç satıra kısaltılmış.
            <div
              key={q}
              title={q}
              className="line-clamp-3 whitespace-pre-wrap break-words border-l-2 border-line2 pl-[10px] text-[13px] leading-[1.5] text-tx2"
            >
              {q}
            </div>
          ))}
          {text ? (
            <Clamp
              text={text}
              render={(visible) => (
                // Bulma vurgusu yalnız bu bloğu tarar: alıntılar ve "Tümünü göster" düğmesi
                // veri modelinde aranmıyor, sayılırsa satır içi sıra kayardı.
                <div data-find-text>
                  <PromptText text={text} upto={visible.length} className="whitespace-pre-wrap" />
                </div>
              )}
            />
          ) : null}
        </div>
      ) : null}
      <div className="flex items-center gap-[2px] text-tx3 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <CopyButton text={text} className={iconBtn} />
        {onRewind ? (
          <button
            type="button"
            title={t("transcript.rewindTitle")}
            onClick={() => onRewind(ordinal)}
            className={iconBtn}
          >
            <Icon name="loop" size={14} stroke={1.6} />
          </button>
        ) : null}
        {onFork && ordinal > 1 ? (
          <button
            type="button"
            title={t("transcript.forkUserTitle")}
            onClick={() => onFork({ userOrdinal: ordinal })}
            className={iconBtn}
          >
            <Icon name="branch" size={14} stroke={1.6} />
          </button>
        ) : null}
      </div>
    </div>
  );
});

/** Dipten bu kadar piksel uzaklaşınca "en alta in" düğmesi çıkar. */
const JUMP_GAP = 120;

/** Sohbet akışı: kullanıcı balonu, çalışma dizisi (düşünme + araç kartları), asistan metni, onay kartı. */
export function Transcript({
  rt,
  onDecide,
  onPlanDecide,
  onQuestionAnswer,
  onExtensionUi,
  onFork,
  onRewind,
  cwd,
  onOpenFile,
  openRoots,
  knownPaths,
  onUndo,
  sessionId,
  onDismissError,
  reserveRight = 0,
  onQuote,
  onSideChat,
  compact = false,
  findKey,
}: Props) {
  const { t } = useTranslation();
  const reviewerOn = useSettings((s) => s.settings?.reviewerOn ?? false);
  const lang = useLocale();
  const ref = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // Son görülen kullanıcı balonunun kimliği: yeni mesaj gönderilince (Enter) nerede okunursa
  // okunsun dibe inilir. Kimlik karşılaştırması transkriptin yeniden akmasına takılmaz.
  const lastUserId = useRef<string | null>(null);
  // Dipten bu kadar uzaklaşınca "en alta in" düğmesi belirir.
  const [away, setAway] = useState(false);
  // Tur sürerken geçen süre: sağlayıcı ilk token'ı geciktirdiğinde (sessiz bekleyiş) sayacın
  // işlemesi ekranın canlı olduğunu gösterir. Saat yalnız tur boyunca kurulur.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (rt.status !== "working") return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [rt.status]);
  const elapsedMs = rt.runStartedAt ? Math.max(0, now - rt.runStartedAt) : 0;
  const home = usePaths((s) => s.home);
  const loadPaths = usePaths((s) => s.load);
  useEffect(() => void loadPaths(), [loadPaths]);

  /** "İncele": gölge modda bir denetçi koşusu başlatır; sonuç `review` olayıyla gelir. */
  const startReview = async () => {
    if (!sessionId) return;
    const result = await invoke("review:run", { sessionId });
    if (result.started) return;
    const key =
      result.reason === "no-changes"
        ? "transcript.reviewNoChanges"
        : result.reason === "busy"
          ? "transcript.reviewBusy"
          : "transcript.reviewDisabled";
    toast.info(t(key));
  };

  // Metindeki yol çipleri: konuşmada dokunulan dosyalar bilinen sayılır, çıplak ad onlara bağlanır.
  // Bağımlılık `rt.transcript` değil hedeflerin metni: dizi her parça karesinde yeniden kuruluyor
  // ve bağlam değeri değişince transkriptteki bütün kod çipleri yeniden çiziliyordu.
  // Ayraç NUL: dosya adı satır sonu içerebilir, yol listesi ondan bölünmemeli.
  const toolTargets = rt.transcript
    .map((i) =>
      i.type === "tool" && i.target && i.kind !== "terminal" && i.kind !== "search" ? i.target : "",
    )
    .filter(Boolean)
    .join("\0");
  const knownKey = (knownPaths ?? []).join("\0");
  // biome-ignore lint/correctness/useExhaustiveDependencies: bağımlılık dizilerin kimliği değil içeriği
  const known = useMemo(() => {
    const base = cwd ?? "";
    const fromTools = toolTargets
      .split("\0")
      .filter(Boolean)
      .map((target) => (isAbsolutePath(target) ? target : joinPath(base, target)));
    return [...new Set([...(knownPaths ?? []), ...fromTools])];
  }, [toolTargets, knownKey, cwd]);
  // `openRoots` çağrı yerlerinde dizi sabiti olarak veriliyor; kimliği değil içeriği bağımlılıktır.
  const rootsKey = (openRoots ?? []).join("\0");
  // biome-ignore lint/correctness/useExhaustiveDependencies: openRoots yerine içerik anahtarı
  const openPath = useMemo(
    () =>
      onOpenFile
        ? {
            isPath: (text: string) => looksLikePath(text, known),
            resolve: (text: string) =>
              resolveMention(text, { home, known, roots: [...(openRoots ?? []), cwd ?? ""] }),
            open: onOpenFile,
          }
        : undefined,
    [onOpenFile, known, home, rootsKey, cwd],
  );
  // Yol çipleri yalnız diskteki dosyaya bağlanır. Ajan bir dosyaya dokununca ya da tur bitince
  // önceden yok çıkan yollar yeniden sorulur: metin dosyadan önce yazılmış olabilir.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tetikleyiciler; gövde onları okumaz
  useEffect(() => forgetMissingPaths(), [known, rt.status]);

  // Sohbet kaydırması çapayla yönetilir: içerik sonradan gruplanınca (canlı turda araç kartları
  // eşiği aşıp tek satıra katlanınca) yükseklik değişse bile görünen satır yerinde kalır;
  // dipteyse akış takip edilir. Seçim varken otomatik dibe iniş durur.
  const follow = useScrollAnchor({
    scrollRef: ref,
    contentRef: content,
    pinnedRef: stick,
    blocked: hasSelection,
    onChange: (gap) => setAway(gap > JUMP_GAP),
  });

  // Yeni kullanıcı balonu (Enter): yukarıda okurken gönderilen mesaj ekran dışında kalmasın.
  // Gönderme anında seçim olsa bile dibe inilir ve otomatik takip yeniden açılır.
  // Bekleyen kart (izin/plan/soru) da hook'un ölçümüne girer: kart sona eklenir, dipteysek görünür.
  useEffect(() => {
    const lastUser = rt.transcript.findLast((i) => i.type === "user");
    const sent = lastUser !== undefined && lastUser.id !== lastUserId.current;
    if (lastUser) lastUserId.current = lastUser.id;
    if (sent) follow();
  }, [follow, rt.transcript]);

  /**
   * Transkriptten türeyen bütün yapılar tek yerde ve ezberlenmiş olarak hesaplanır.
   *
   * Neden `useMemo`: bu blok satır satır dolaşır (gruplama, tur sonları, tur başına araç listesi,
   * dizi süreleri) ve eskiden **her** çizimde baştan koşuyordu. Tur sürerken saniyede bir işleyen
   * süre sayacı bile bütün listeyi yeniden grupluyordu; uzun bir oturumda bu, saniyede bir O(n)
   * iş demekti. Artık yalnız transkript ya da tur durumu değişince hesaplanır.
   *
   * `canRewind` dışarıda: `rt.permissions` değişimi (izin kartı) gruplamayı etkilemez.
   */
  const view = useMemo(() => {
    const busy = rt.status !== "idle";
    // Kullanıcı mesajı sırası (1'den); geri sar ve dallandır için engine aynı kuralla sayar.
    const userOrdinals = new Map<string, number>();
    let u = 0;
    for (const item of rt.transcript) if (item.type === "user") userOrdinals.set(item.id, ++u);

    // Bir turun kapanışı: tur sonunda araçlarla kesilmeyen metinli asistan mesajları. Arka plan
    // bitişi gibi ek dürtmeler aynı turda ikinci bir kapanış doğurabiliyor; hepsi sonuç olarak
    // çizilir, rozet ve dosya satırı yalnızca dizinin son mesajında kalır. Araçla bitip kapanış
    // metni olmayan turun sonu yoktur; dizisi "yarım kaldı" olarak katlanır.
    const {
      results: turnEnds,
      finals: turnFinals,
      last: lastEnd,
    } = findTurnEnds(rt.transcript, busy);
    // Dallandırma sırası: metinli asistan mesajları (engine aynı kuralla sayar).
    const ordinals = new Map<string, number>();
    let n = 0;
    for (const item of rt.transcript)
      if (item.type === "assistant" && item.text.trim()) ordinals.set(item.id, ++n);

    // Sonuçtan önceki her şey tek çalışma dizisinde toplanır: araç kartları, düşünmeler ve
    // ara anlatımlar. Akan ara anlatım da önceki dizinin içine girer: dışarıda kalınca sütunun
    // 18px'lik parça aralığını alıyor, satır tamamlanıp diziye katlanınca yukarı zıplıyordu.
    // Tur sonu (kapanış) mesajı dışarıda kalır ki yanıt, çalışma günlüğünden ayrı dursun.
    const rawGroups: Array<Run | TranscriptItem> = [];
    for (const item of rt.transcript) {
      const last = rawGroups[rawGroups.length - 1];
      const isEnd = item.type === "assistant" && turnEnds.has(item.id);
      const inRun =
        item.type === "tool" ||
        (item.type === "assistant" && !isEnd && (!item.streaming || (busy && Array.isArray(last))));
      if (inRun) {
        if (Array.isArray(last)) last.push(item);
        else rawGroups.push([item]);
        continue;
      }
      rawGroups.push(item);
    }
    // Gizli dürtme (arka plan bildirimi vb.) turu ortadan böler: her parça kendi özet satırını
    // alınca tek yanıtın altında "51,6 sn çalıştı" + "3,5 sn çalıştı" gibi iki satır görünüyordu.
    // Parçalar tek diziye iner, ara raporlar satırın altında görünür kalır (bkz. turnRuns).
    // Tur sürerken son ara rapordan sonrası (canlı bölüm) ayrı kalır: iş, eski raporun altında akar.
    const groups = mergeTurnRuns(rawGroups, busy ? liveSegmentStart(rawGroups, turnEnds) : -1);
    // Canlı bölüm birleşmeden sonraki dizinde: canlı dizi, başlık, sayaç ve katlama buna bakar.
    const liveFrom = busy ? liveSegmentStart(groups, turnEnds) : -1;

    // Tur başına araç kartları: son kullanıcı mesajından tur sonuna kadar olanlar. Turun kullanıcı
    // sırası da tutulur: "Geri al" yedeği o sırayla anahtarlıdır.
    const turnTools = new Map<string, ToolCallItem[]>();
    const turnOrdinal = new Map<string, number>();
    let bucket: ToolCallItem[] = [];
    let ordinal = 0;
    for (const item of rt.transcript) {
      if (item.type === "user") {
        bucket = [];
        ordinal++;
      } else if (item.type === "tool") bucket.push(item);
      else if (turnFinals.has(item.id)) {
        turnTools.set(item.id, bucket);
        turnOrdinal.set(item.id, ordinal);
      }
    }

    // Önünde çalışma dizisi olan tur sonları: başlığı o dizi çizer. Dizisi olmayan turda (yalnız
    // düşünme + yanıt) başlığı yanıt bloğu çizer; ZCode'da "Worked for" satırı **her turda** vardır
    // (araç çalışmasa bile: `resolveConversationTurnWorkStatus` süresi olan her turda satır açar).
    const turnHasRun = new Set<string>();
    for (let i = 1; i < groups.length; i++) {
      const g = groups[i];
      if (!g || Array.isArray(g) || g.type !== "assistant" || !turnFinals.has(g.id)) continue;
      // Geriye doğru bak: araya giren **çizilmeyen** sınır öğeleri (gizli dürtme) ve komut
      // işaretleri atlanır, yoksa dizisi olan turda ikinci bir başlık daha çiziliyordu
      // ("54 sn çalıştı" iki kez).
      for (let j = i - 1; j >= 0; j--) {
        const prev = groups[j];
        if (!prev) break;
        if (Array.isArray(prev)) {
          turnHasRun.add(g.id);
          break;
        }
        if (prev.type === "boundary" || prev.type === "marker") continue;
        // Aynı turun ara kapanış mesajı (dürtmeden sonra gelen ara rapor) da turun işidir: atla,
        // yoksa onun ardındaki dizi görülmez ve turda ikinci bir başlık çizilir.
        if (prev.type === "assistant" && turnEnds.has(prev.id)) continue;
        break;
      }
    }

    // Dizinin ait olduğu turun süresi: başlıkla yanıt altındaki satır aynı sayıyı yazsın diye
    // tur sonu mesajının ölçüsü diziye taşınır (`runDuration` yalnız araçların aralığını ölçer ve
    // modelin üretim süresini dışarıda bırakır; iki satır bu yüzden farklı görünüyordu).
    const runTurnMs = new Map<number, number>();
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (!g || Array.isArray(g) || g.type !== "assistant" || !turnFinals.has(g.id)) continue;
      if (g.durationMs === undefined) continue;
      for (let j = i - 1; j >= 0; j--) {
        const prev = groups[j];
        if (!prev) break;
        if (Array.isArray(prev)) {
          runTurnMs.set(j, g.durationMs);
          break;
        }
        if (prev.type === "boundary" || prev.type === "marker") continue;
        if (prev.type === "assistant" && turnEnds.has(prev.id)) continue;
        break;
      }
    }

    // Süren turun dizisi: son çalışma dizisi, tur bitene kadar açık kalır.
    // Yalnızca son kullanıcı mesajından (ya da son ara rapordan) sonraki dizi canlıdır: "son dizi"
    // demek yeni tur başlarken henüz aracı olmadığı için önceki turun katlanmış dizisini seçiyor ve
    // onu yeniden açıyordu. Dizisi olmayan süren turda başlığı ilk asistan öğesi taşır: ZCode'da
    // çalışma satırı tur boyunca vardır (`workStatus` running).
    const { liveRun, liveHead } = busy
      ? findLiveRows(groups, turnFinals, liveFrom)
      : { liveRun: -1, liveHead: -1 };
    // Canlı sayaç canlı bölümün başından işler: rapordan önceki iş katlanmış dizinin başlığında
    // zaten sayılıyor, turun başından saymak aynı süreyi iki başlıkta birden gösteriyordu.
    const liveStart = groups[liveFrom];
    const liveFirst = Array.isArray(liveStart) ? liveStart[0] : liveStart;
    const liveStartedAt = liveFirst ? itemTime(liveFirst) : undefined;
    // Canlılık tek yerde: alttaki durum satırı. Araç kartı ve metin kendi içeriklerini gösterirken
    // de tur sürüyor; Pi'deki gibi spinner akış boyunca döner, ekranda sessiz boşluk kalmaz.
    // Ardından kapanış metni gelmeyen ya da kapanışı hata/kesme ile biten diziler açık kalır.
    const expandedRuns = findExpandedRuns(groups, liveRun, turnFinals, liveFrom);

    return {
      busy,
      userOrdinals,
      turnEnds,
      turnFinals,
      lastEnd,
      ordinals,
      groups,
      turnTools,
      turnOrdinal,
      turnHasRun,
      runTurnMs,
      liveRun,
      liveHead,
      liveStartedAt,
      expandedRuns,
    };
  }, [rt.transcript, rt.status]);

  // Türeyen yapılar `view` içinde ezberlenir; burada yalnız adları açılır.
  const {
    userOrdinals,
    turnEnds,
    turnFinals,
    lastEnd,
    ordinals,
    groups,
    turnTools,
    turnOrdinal,
    turnHasRun,
    runTurnMs,
    liveRun,
    liveHead,
    liveStartedAt,
    expandedRuns,
  } = view;
  const liveMs = liveStartedAt === undefined ? elapsedMs : Math.max(0, now - liveStartedAt);

  const canRewind = rt.status === "idle" && !rt.permissions.some((r) => !r.run);
  // Tur çubuğu balonu iki satır gösterir (ZCode paritesi): kullanıcı sorgusunun özeti ve asistan
  // yanıtının özeti. Bir tur, kullanıcı item'ından sonraki, sıradaki kullanıcı item'ına kadar olan
  // asistan metinlerinin tamamıdır. Dizi kimliği her karede değişmesin diye anahtar önizlemeleri de
  // içerir; akış sırasında ikinci satır böyle canlı güncellenir.
  const railTurns: { id: string; userText: string; assistantTexts: string[]; running: boolean }[] =
    [];
  for (const item of rt.transcript) {
    if (item.type === "user") {
      railTurns.push({
        id: item.id,
        userText: collapsePrompt(item.text),
        assistantTexts: [],
        running: false,
      });
      continue;
    }
    if (item.type === "assistant" && railTurns.length > 0)
      railTurns[railTurns.length - 1]?.assistantTexts.push(item.text);
  }
  // Son tur ve oturum "working" ise yanıt satırı "hâlâ çalışıyor" ikamesini gösterir; "waiting"
  // (izin/plan/soru kartı) turu kullanıcı beklettiği için metin yokluğu doğru bilgidir.
  const railLast = railTurns[railTurns.length - 1];
  if (railLast && rt.status === "working") railLast.running = true;

  // İkame metinler de anahtara girer: dil değişince balon kendiliğinden tazelenir.
  const railAssistantEmpty = t("transcript.railAssistantEmpty");
  const railAssistantRunning = t("transcript.railAssistantRunning");
  const railUserFallback = t("transcript.railUserFallback");
  const railKey = [
    // Durum da anahtara girer: son tur metinsizken "çalışıyor" → "boş" geçişi balonu tazelesin.
    rt.status,
    railUserFallback,
    railAssistantEmpty,
    railAssistantRunning,
    ...railTurns.map(
      (turn) =>
        `${turn.id}\0${turn.userText.slice(0, 200)}\0${turn.assistantTexts.join("").slice(0, 200)}`,
    ),
  ].join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: bağımlılık dizinin kimliği değil içeriği
  const railItems = useMemo<RailItem[]>(
    () =>
      railTurns.map((turn, index) => ({
        id: turn.id,
        ordinal: index + 1,
        userPreview: buildPreviewText({ texts: [turn.userText], fallback: railUserFallback }),
        ...resolveAssistantPreview({
          texts: turn.assistantTexts,
          running: turn.running,
          emptyFallback: railAssistantEmpty,
          runningFallback: railAssistantRunning,
        }),
      })),
    [railKey],
  );

  // Bekleyen kart (izin/plan/soru) listenin son elemanıdır ve turu kullanıcı bekletir: alt dolgu
  // kısalır, kart composer'a yaklaşır; aradaki 30px'lik boşluk kapanır.
  const cardPending = Boolean(rt.permissions.length > 0 || rt.planReview || rt.question);

  /**
   * Uzun oturumlarda tur penceresi.
   *
   * Kısa sohbette pencere uygulanmaz (`virtualWindow` eşiğin altında tamamını döner), yani
   * davranış bugünküyle birebir aynı kalır. Uzun sohbette görünmeyen turlar DOM'a basılmaz;
   * yerleri **boşlukla** tutulur ki toplam yükseklik değişmesin — sohbetin kaydırma çapası
   * (`scrollAnchor`) geometriye güvenir, toplam yükseklik oynarsa sohbet zıplar.
   *
   * Pencere yalnız **sınırları değiştiğinde** state'e yazılır: her kaydırma karesinde render
   * tetiklemek, ezberleme ve `useMemo` ile kazandığımızı geri verirdi.
   */
  // Başlangıç değeri **ilk tur sayısına göre** hesaplanır, boş bir pencereyle başlanmaz: kap
  // ölçülmeden (ilk kare, DOM'suz çizim) bile sohbet çizilir. Ölçüm gelince effect tazeler.
  const [win, setWin] = useState<VirtualWindow>(() =>
    virtualWindow({ count: view.groups.length, scrollTop: 0, viewport: 0, heights: [] }),
  );
  const heightCache = useRef(new RowHeightCache());
  const rowKeys = useMemo(() => view.groups.map((g, gi) => rowKeyOf(g, gi)), [view.groups]);
  // Pencereyi çizen yardımcılar (atlama, ölçüm) ref üzerinden okur: kimlikleri sabit kalsın.
  const rowKeysRef = useRef(rowKeys);
  rowKeysRef.current = rowKeys;
  const virtualizing = rowKeys.length > VIRTUAL_MIN_ROWS;

  const recompute = useCallback(() => {
    // Kap yoksa (DOM'suz çizim, test) sıfır ölçüyle hesaplanır: `virtualWindow` bu durumda
    // listenin sonunu döner, boş ekran değil.
    const el = ref.current;
    const next = virtualWindow({
      count: rowKeys.length,
      scrollTop: el?.scrollTop ?? 0,
      viewport: el?.clientHeight ?? 0,
      heights: heightCache.current.series(rowKeys),
    });
    setWin((prev) =>
      prev.start === next.start &&
      prev.end === next.end &&
      prev.padTop === next.padTop &&
      prev.padBottom === next.padBottom
        ? prev
        : next,
    );
  }, [rowKeys]);

  // Çizilen satırların gerçek yükseklikleri önbelleğe alınır: pencere kaydığında bir tur
  // yeniden çizilirse eski yüksekliği hazır olur ve boşluk tahmini düzelir. Sanallaştırmada satır
  // aralığı dolguyla verildiği için ölçülen yükseklik boşluğu da içerir (modelin birimi adım).
  const measureRows = useCallback(() => {
    const box = content.current;
    if (!box) return;
    for (const row of box.querySelectorAll<HTMLElement>("[data-anchor-key]")) {
      const key = row.dataset.anchorKey;
      if (key) heightCache.current.set(key, row.getBoundingClientRect().height);
    }
  }, []);

  /**
   * Bir mesaja atlar (tur çubuğu buradan çağırır).
   *
   * Hedef satır çiziliyse ölçülmüş konuma yumuşak kaydırma yeter. Sanallaştırmada satır DOM'da
   * olmayabilir: ilk yazım **yükseklik modelinden** yapılır — pencere `scrollTop`a göre kurulduğu
   * için hedef aynı karede çizilir — sonraki karede ölçülmüş konumla tam oturtulur. Model
   * kendisiyle tutarlı olduğundan (pencere ve boşluklar aynı diziden) ilk yazım hedefi görünür
   * alana getirir, ikinci yazım yalnız bandın içindeki ölçüm farkını düzeltir.
   */
  const jumpToMessage = useCallback((itemId: string): boolean => {
    const index = rowKeysRef.current.indexOf(`u-${itemId}`);
    if (index < 0) return false;
    let pass = 0;
    const seek = () => {
      const el = ref.current;
      const box = content.current;
      if (!el || !box) return;
      const elTop = el.getBoundingClientRect().top;
      const node = document.getElementById(`msg-${itemId}`);
      // Ölçülmüş konum (varsa) ya da model: her ikisi de kaydırma kabının koordinatında.
      const top = node
        ? node.getBoundingClientRect().top - elTop + el.scrollTop
        : box.getBoundingClientRect().top -
          elTop +
          el.scrollTop +
          sumRowHeights(heightCache.current.series(rowKeysRef.current), 0, index);
      el.scrollTo({
        top: Math.max(0, top - JUMP_TOP_PAD),
        // Yakın mesaj (satır çizili) yumuşak kaysın; uzak mesajda ölçüm gelene kadar beklemeden
        // otur, düzeltme turları da anlık yazsın.
        behavior: pass === 0 && node ? "smooth" : "auto",
      });
      pass += 1;
      if (!node && pass < 3) requestAnimationFrame(seek);
    };
    seek();
    return true;
  }, []);

  /**
   * Sohbet içi bulma (⌘F). Eşleşmeler veri modelinden sayılır (`transcriptFind.ts`): sanal
   * listede ekran dışındaki turlar DOM'da yoktur, tarayıcının sayfa içi araması onları göremez.
   * Ekrandaki vurgu çizili satırlarda ayrıca boyanır (`findHighlight.ts`).
   */
  const findOpen = useFind((s) => Boolean(findKey) && s.open && s.sessionId === findKey);
  const findQuery = useFind((s) => s.query);
  const findPending = useFind((s) => s.pending);
  const query = findOpen ? findQuery.trim() : "";
  const matches = useMemo(
    () => (query ? findMatches(groups, query, turnEnds) : []),
    [groups, query, turnEnds],
  );
  const [current, setCurrent] = useState(-1);
  // ⌘K isabetinden gelen hedef; sorgu ilk kez hesaplanınca tüketilir.
  const findTarget = useRef<FindTarget | null>(null);
  const [seekNonce, setSeekNonce] = useState(0);
  const lastSeek = useRef("");
  // Geçerli eşleşmeye kaydırma bekliyor mu: adım ve yeni sorguda evet, akış güncellemesinde hayır.
  const revealing = useRef(false);
  const currentMatch = current >= 0 ? matches[current] : undefined;
  const currentKey = currentMatch ? rowKeys[currentMatch.row] : undefined;
  const findRef = useRef({ query, currentKey, inRow: currentMatch?.inRow ?? 0 });
  findRef.current = { query, currentKey, inRow: currentMatch?.inRow ?? 0 };

  // ⌘K içerik isabeti: palet oturumu açtı; çubuk sorguyla açılır, hedef mesaj seçilir. Oturum
  // zaten açıksa transkript yeniden bağlanmaz, bu yüzden istek store'dan dinlenir.
  useEffect(() => {
    if (!findKey || findPending?.sessionId !== findKey) return;
    const request = useFind.getState().take(findKey);
    if (!request) return;
    findTarget.current = request.target;
    useFind.getState().openFor(findKey, request.query);
    setSeekNonce((n) => n + 1);
  }, [findKey, findPending]);

  // Çubuğu açan transkript kapanınca (oturum değişti) çubuk da kapanır: açık kalırsa başka
  // oturumda Esc turu durdurmaz, çubuğu bekler.
  useEffect(
    () => () => {
      clearFind();
      const s = useFind.getState();
      if (findKey && s.sessionId === findKey && s.open) s.close();
    },
    [findKey],
  );

  /** Görünen ilk satırın sırası; yeni sorgu oradan sonraki ilk eşleşmeyle başlar. */
  const topVisibleRow = useCallback((): number => {
    const el = ref.current;
    const box = content.current;
    if (!el || !box) return 0;
    const top = el.getBoundingClientRect().top + JUMP_TOP_PAD;
    for (const row of box.querySelectorAll<HTMLElement>("[data-anchor-key]")) {
      if (row.getBoundingClientRect().bottom <= top) continue;
      const index = rowKeysRef.current.indexOf(row.dataset.anchorKey ?? "");
      if (index >= 0) return index;
    }
    return 0;
  }, []);

  // Sorgu değişince (ya da ⌘K hedefi gelince) geçerli eşleşme baştan seçilir; yalnız eşleşmeler
  // değiştiyse (yanıt akıyor) seçim yerinde kalır ve kaydırma yapılmaz.
  // `seekNonce` yalnız tetikleyicidir: ⌘K aynı sorguyla yeniden gelse de hedef seçilsin.
  // biome-ignore lint/correctness/useExhaustiveDependencies: transkript yalnız hedef çözümünde okunur
  useEffect(() => {
    const target = findTarget.current;
    if (target && query) {
      findTarget.current = null;
      lastSeek.current = query;
      const next = pickMatch(matches, target, rt.transcript);
      revealing.current = next >= 0;
      setCurrent(next);
      return;
    }
    if (lastSeek.current === query) {
      setCurrent((c) => (matches.length === 0 ? -1 : Math.min(Math.max(c, 0), matches.length - 1)));
      return;
    }
    lastSeek.current = query;
    const next = firstMatchFrom(matches, topVisibleRow());
    revealing.current = next >= 0;
    setCurrent(next);
  }, [query, matches, seekNonce, topVisibleRow]);

  const stepFind = useCallback(
    (delta: 1 | -1) => {
      revealing.current = true;
      setCurrent((c) => stepMatch(c, matches.length, delta));
    },
    [matches.length],
  );

  /**
   * Vurguyu boyar ve gerekiyorsa geçerli eşleşmeye kaydırır. Satır çizili değilse (sanal pencere
   * dışında) önce yükseklik modelinden satıra gidilir; pencere kayınca satır çizilir, sonraki
   * karede aralık bulunup ortalanır. Katlı dizi `reveal` ile açılır, o da bir kare sürer.
   */
  const paint = useCallback(() => {
    const box = content.current;
    const el = ref.current;
    const { query: q, currentKey: key, inRow } = findRef.current;
    if (!box || !el || !q) {
      clearFind();
      return;
    }
    const range = paintFind(box, q, key ? { rowKey: key, inRow } : null);
    if (!revealing.current || !key) return;
    const view = el.getBoundingClientRect();
    if (range) {
      revealing.current = false;
      const rect = range.getBoundingClientRect();
      // Üstteki başlık şeridi ve bulma çubuğu payı: eşleşme onların altında kalmasın.
      if (rect.top < view.top + 64 || rect.bottom > view.bottom - 24) {
        stick.current = false;
        el.scrollTo({ top: Math.max(0, el.scrollTop + rect.top - view.top - el.clientHeight / 2) });
      }
      return;
    }
    const index = rowKeysRef.current.indexOf(key);
    if (index < 0) return;
    const node = box.querySelector<HTMLElement>(`[data-anchor-key="${CSS.escape(key)}"]`);
    const top = node
      ? node.getBoundingClientRect().top - view.top + el.scrollTop
      : box.getBoundingClientRect().top -
        view.top +
        el.scrollTop +
        sumRowHeights(heightCache.current.series(rowKeysRef.current), 0, index);
    stick.current = false;
    el.scrollTo({ top: Math.max(0, top - JUMP_TOP_PAD) });
  }, []);

  // Boyama tetikleyicileri: sorgu/seçim değişimi ve içerik değişimi (pencere kayması, akan yanıt,
  // açılan dizi). İçerik gözlemcisi kare başına bir boyamaya birleştirilir.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tetikleyiciler; gövde ref'ten okur
  useEffect(() => {
    if (!query) {
      clearFind();
      return;
    }
    const box = content.current;
    let frame = requestAnimationFrame(() => {
      frame = 0;
      paint();
    });
    if (!box || typeof MutationObserver === "undefined") return () => cancelAnimationFrame(frame);
    const observer = new MutationObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        paint();
      });
    });
    observer.observe(box, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [query, current, currentKey, paint]);

  // Kaydırma, kap boyutu ve içerik değişimi pencereyi tazeler. Kaydırma dinleyicisi rAF ile
  // birleştirilir: kare başına en çok bir hesap.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        recompute();
      });
    };
    el.addEventListener("scroll", schedule, { passive: true });
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            schedule();
          });
    ro?.observe(el);
    if (content.current) ro?.observe(content.current);
    return () => {
      el.removeEventListener("scroll", schedule);
      ro?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [recompute]);

  // Ölçüm birimi moda bağlı (sanallaştırmada satır dolgusu ölçüme girer): sohbet eşiği **canlı**
  // geçebildiği için (150. tur) eski ölçümler yanlış olur, atılır ve yeniden ölçülür.
  const wasVirtualizing = useRef(virtualizing);
  useEffect(() => {
    if (wasVirtualizing.current === virtualizing) return;
    wasVirtualizing.current = virtualizing;
    heightCache.current.clear();
    recompute();
  }, [virtualizing, recompute]);

  // Ölçüm ve pencere hesabı her commit'te tazelenir: yükseklik ölçümü bir sonraki karenin
  // boşluğunu düzeltir, sınır değişmediyse state'e yazılmaz (döngü kurmaz).
  useLayoutEffect(() => {
    measureRows();
    recompute();
  });

  return (
    <AgentBadgeProvider sessionId={sessionId ?? ""}>
      <OpenPathContext.Provider value={openPath}>
        {/* Mesaj çubuğu kaydırma kabının **dışında**, kendi şeridinde durur: kabın sol dolgusuna
            ya da içine mutlak konumla bırakıldığında çizgiler metnin üzerine biniyordu. */}
        <div className="relative flex min-h-0 flex-1">
          {compact ? null : <TurnRail items={railItems} scrollRef={ref} onJump={jumpToMessage} />}
          {findOpen ? (
            <FindBar
              current={current}
              total={matches.length}
              onStep={stepFind}
              right={reserveRight + 16}
            />
          ) : null}
          <div
            ref={ref}
            // Kaydırma kabı kimliği: düzeni ölçen e2e testi kabı sınıfından (`both-edges`)
            // aramak zorunda kalmasın.
            {...(compact ? {} : testId(TEST_IDS.chatScroll))}
            // Üst kenarda 24px solma: kaydırılan kart başlık şeridinin altında keskin bir çizgiyle
            // yarım kesiliyordu. En üstteyken içerik `pt-14` payının altında başladığı için
            // maske hiçbir şeyi soldurmaz; yalnız yukarı kayan içerikte devreye girer.
            className={`flex-1 overflow-y-auto ${compact ? "pt-3" : "pt-14"} [mask-image:linear-gradient(to_bottom,transparent,black_24px)] [overflow-anchor:none] [scrollbar-gutter:stable_both-edges] ${
              cardPending ? "pb-[14px]" : "pb-5"
            }`}
            // Sağ dolgu: yüzen panelin payı + çubuk şeridi (solda da aynı pay var, sohbet
            // kenar çubuğu ile panel arasında ortada kalsın). Kolonun kendi yatay dolgusu
            // `CHAT_COLUMN` içinde.
            style={{ paddingRight: chatPadRight(reserveRight > 0) }}
          >
            <div
              ref={content}
              {...(compact ? {} : testId(TEST_IDS.chatColumn))}
              // Sanallaştırmada aralık `gap` ile değil satır dolgusuyla verilir: atlanan satır
              // boşluğunu da götürürdü ve toplam yükseklik pencere her kaydığında oynardı
              // (`ROW_SPACING_CLASS` / `ROW_HEIGHT_ESTIMATE`).
              className={`${compact ? "w-full px-3" : CHAT_COLUMN} flex flex-col ${virtualizing ? "" : "gap-5"}`}
            >
              {win.padTop > 0 ? <div aria-hidden style={{ height: win.padTop }} /> : null}
              {groups.slice(win.start, win.end).map((g, i) => {
                const gi = win.start + i;
                const key = rowKeyOf(g, gi);
                const space = virtualizing ? ROW_SPACING_CLASS : "";
                return Array.isArray(g) ? (
                  // Kaydırma çapası üst düzey satırda durur: katlanma iç DOM'u değiştirse de
                  // satırın konumu ölçülebilir kalır.
                  <div key={key} data-anchor-key={key} className={space}>
                    <RunBlock
                      run={g.filter(isRunItem)}
                      cwd={cwd ?? ""}
                      home={home}
                      lang={lang}
                      endIds={turnEnds}
                      live={gi === liveRun}
                      liveMs={liveMs}
                      turnMs={runTurnMs.get(gi)}
                      keepOpen={expandedRuns.has(gi)}
                      onOpenFile={onOpenFile}
                      reveal={currentMatch?.row === gi}
                    />
                  </div>
                ) : g.type === "marker" ? (
                  // Komut sonucu işareti kendi satırında çizilir: tur grubuna girmez (komut modele
                  // gitmediği için tur yoktur), katlanmaz ve kaydırma çapası kendi kimliğidir.
                  <div key={key} data-anchor-key={key} className={space}>
                    <MarkerRow item={g} />
                  </div>
                ) : g.type === "user" ? (
                  <UserBubble
                    key={key}
                    item={g}
                    ordinal={userOrdinals.get(g.id) ?? 0}
                    onRewind={onRewind && canRewind ? onRewind : undefined}
                    onFork={onFork}
                    space={space}
                  />
                ) : g.type === "assistant" && (g.text.trim() || g.thinking || !g.streaming) ? (
                  // Düşünme deltası ilk geldiğinde metni boş bir öğe transcript'e ekleniyor; onu
                  // çizmeyince görünmez boşluk yaratıp "Çalışıyor…" göstergesini kaydırıyordu.
                  // Düşünme artık çizildiği için bu öğe boş kalmıyor: model düşünürken de görünür.
                  <div
                    key={key}
                    id={`msg-${g.id}`}
                    data-anchor-key={key}
                    className={`group/turn flex flex-col gap-[14px] ${space}`}
                  >
                    {(turnFinals.has(g.id) && !turnHasRun.has(g.id)) || gi === liveHead ? (
                      <TurnHead
                        item={g}
                        live={gi === liveHead || g.streaming}
                        liveMs={liveMs}
                        lang={lang}
                      />
                    ) : null}
                    <AssistantBlock item={g} />
                    {cwd !== undefined && turnFinals.has(g.id) && !g.streaming ? (
                      <TurnFiles
                        tools={turnTools.get(g.id) ?? []}
                        text={g.text}
                        cwd={cwd}
                        home={home}
                        onOpen={onOpenFile}
                        onUndo={
                          onUndo && rt.status === "idle" && turnOrdinal.get(g.id)
                            ? () => onUndo(turnOrdinal.get(g.id) ?? 0)
                            : undefined
                        }
                      />
                    ) : null}
                    {/* Zamanlanmış görev kartı yanıtın altında: çalışma dizisi katlanınca da
                        Düzenle / Şimdi çalıştır görünür kalır. Yan sohbette de çizilir (cwd yok). */}
                    {turnFinals.has(g.id) && !g.streaming ? (
                      <ScheduleCards tools={turnTools.get(g.id) ?? []} />
                    ) : null}
                    {/* Tur sonu kontrolü yalnızca son turun altında; yeni tur başlayınca silinir.
                        Başarısız kontrol kırmızı değil nötr yazılır: metin zaten "başarısız" der. */}
                    {rt.checks && g.id === lastEnd ? (
                      <div className={`text-[12px] ${rt.checks.ok ? "text-green" : "text-tx2"}`}>
                        {rt.checks.ok
                          ? t("transcript.checksPassed", {
                              commands: rt.checks.commands.join(", "),
                            })
                          : t("transcript.checksFailed", { command: rt.checks.failed ?? "" })}
                      </div>
                    ) : null}
                    {/* Kod incelemesi: bulgular ait olduğu turun altında; modele geri gitmez (gölge mod). */}
                    {rt.review && turnOrdinal.get(g.id) === rt.review.turn ? (
                      <ReviewCard review={rt.review} sessionId={sessionId ?? ""} />
                    ) : null}
                    {reviewerOn &&
                    sessionId &&
                    g.id === lastEnd &&
                    rt.review?.phase !== "started" ? (
                      <button
                        type="button"
                        onClick={() => void startReview()}
                        className="self-start text-[12px] text-tx3 hover:text-tx2"
                      >
                        {t("transcript.reviewButton")}
                      </button>
                    ) : null}
                    {turnFinals.has(g.id) ? (
                      <AssistantActions
                        item={g}
                        ordinal={ordinals.get(g.id) ?? 0}
                        onFork={onFork}
                        lang={lang}
                      />
                    ) : null}
                  </div>
                ) : null;
              })}
              {win.padBottom > 0 ? <div aria-hidden style={{ height: win.padBottom }} /> : null}
              {rt.permissions.map((request) => (
                <PermissionCard
                  key={request.requestId}
                  request={request}
                  onDecide={(d) => onDecide(request.requestId, d)}
                />
              ))}
              {/* Worktree ajanının değişikliği sohbette karara bağlanır; panel açmak gerekmez.
                  Kart tur bitince çıkar: tur sürerken en altta durup akan yanıtın arkasında
                  kalıyordu, izin kartlarının arasına girip yanlış tıklatıyordu. */}
              {sessionId && rt.status === "idle" ? (
                <AgentReviewCards sessionId={sessionId} />
              ) : null}
              {rt.planReview ? (
                <PlanReviewCard
                  review={rt.planReview}
                  onDecide={(d) => onPlanDecide(rt.planReview?.requestId ?? "", d)}
                />
              ) : null}
              {rt.question ? (
                <QuestionCard
                  request={rt.question}
                  onAnswer={(answers) => onQuestionAnswer(rt.question?.requestId ?? "", answers)}
                />
              ) : null}
              {rt.extensionUi && onExtensionUi ? (
                <ExtensionUiCard
                  request={rt.extensionUi}
                  onRespond={(value) => onExtensionUi(rt.extensionUi?.requestId ?? "", value)}
                />
              ) : null}
              {rt.lastError ? (
                // Hata ZCode'un çubuğu gibi renksiz akar: özet tek satır, gövde "Ayrıntılar"da,
                // sağda kopyala / günlüğü aç / kapat. Kırmızı yalnız yıkıcı eylemde kalır.
                <ErrorBar
                  {...splitError(rt.lastError)}
                  action={{
                    label: t("common.openLogs"),
                    run: () => void invoke("app:openLogs", undefined).catch(() => undefined),
                  }}
                  onDismiss={onDismissError}
                />
              ) : null}
              {rt.status === "working" && !cardPending ? (
                <Working
                  // Düşünme durumu artık kendi bloğunda akıyor; bu satır turun sürdüğünü söyler
                  // (sessiz bekleyişte tek canlı işaret).
                  // Kart beklerken gizlenir: onay/soru kartı ilerlemenin kendisidir (ZCode kuralı).
                  label={t("transcript.working")}
                  // Yalnız dönen yay: ZCode'un tur sonu göstergesi (`ChatLoading`) de simgedir.
                  // Süren işi araç satırı söylüyor ("Çalıştırılıyor cd … && pnpm test"); satırda
                  // bir de "Çalışıyor…" yazmak aynı şeyi iki kez söylüyordu.
                  spinnerOnly
                />
              ) : null}
            </div>
            {/* Sıfır yükseklikli yapışkan şerit: düğme akışı bozmadan görünür alanın altında durur. */}
            {away ? (
              <div className="sticky bottom-0 z-10 h-0">
                <button
                  type="button"
                  aria-label={t("transcript.toBottom")}
                  title={t("transcript.toBottom")}
                  onClick={() => {
                    const el = ref.current;
                    if (!el) return;
                    stick.current = true;
                    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
                  }}
                  className="-translate-x-1/2 absolute bottom-3 left-1/2 flex h-7 w-7 items-center justify-center rounded-full border border-line bg-card text-tx3 transition-colors hover:bg-card2 hover:text-tx"
                >
                  <Icon name="down" size={16} />
                </button>
              </div>
            ) : null}
          </div>
        </div>
        {onQuote ? (
          <SelectionReply root={content} onReply={onQuote} onSideChat={onSideChat} />
        ) : null}
      </OpenPathContext.Provider>
    </AgentBadgeProvider>
  );
}
