import type { SearchBackend, ToolCallItem, ToolKind } from "@codezal/contracts";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ClampFade, ClampToggle } from "../components/Clamp";
import { useHighlightedLines } from "../components/CodeView";
import { CopyButton } from "../components/CopyButton";
import { FlipNumber } from "../components/FlipNumber";
import { Icon } from "../components/Icon";
import type { IconName } from "../icons";
import {
  buildPatchRows,
  dedentRows,
  isUnifiedDiff,
  lineNumberOf,
  parseToolDiff,
  plainRows,
} from "../lib/diff";
import { FileTypeIcon } from "../lib/fileIcons";
import { langForPath, type Token } from "../lib/highlight";
import { toolLatency } from "../lib/perf";
import { activeStepOf, TASK_LIST_TOOL, taskListSteps } from "../lib/progress";
import { useToolCardOpen } from "../lib/toolCardOpen";
import {
  groupFamily,
  liveStep,
  type StopLabels,
  stopLabels,
  summarizeTools,
  type ToolEntry,
  terminalNotRun,
} from "../lib/toolGroups";
import { shortPath } from "../lib/turnFiles";
import { useAgentBadge, useAgentRun } from "./AgentBadge";

const KIND_ICON: Record<ToolKind, IconName> = {
  read: "eye",
  search: "search",
  create: "filePlus",
  edit: "edit",
  delete: "trash",
  terminal: "terminal",
  audit: "shield",
  other: "mcp",
};

/** Diff çıktısındaki eklenen ve silinen satır sayısı (+++/--- başlıkları hariç). */
export function diffCounts(output: string): { add: number; del: number } {
  const lines = output.split("\n");
  return {
    add: lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length,
    del: lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length,
  };
}

/**
 * Kartın `+N −N` sayacı. Yazma/düzenleme sürerken aracın çıktısı (diff) henüz yoktur; sayaç o an
 * modelin ürettiği kısmi girdiden ölçülen **canlı** değeri okur (motordan `tool_preview` akar —
 * ZCode da akış sırasında böyle davranır). Çağrı bitince canlı ölçü düşer, sayı diff'ten hesaplanır:
 * son değer her zaman gerçek diff'tir.
 */
function changeCounts(item: ToolCallItem): { add: number; del: number } {
  if (item.added !== undefined || item.removed !== undefined)
    return { add: item.added ?? 0, del: item.removed ?? 0 };
  return diffCounts(item.output ?? "");
}

/**
 * Kuyruktan kırpılan tek satır metin: dosya yolu sığmazsa baş tarafı üç noktaya gider, ad görünür kalır.
 * RTL yön + izole (bdi) içerik: noktalama sırası bozulmadan taşma sola alınır.
 */
export function TailText({ text, className = "" }: { text: string; className?: string }) {
  return (
    <span
      className={`min-w-0 truncate ${className}`}
      style={{ direction: "rtl", textAlign: "left" }}
      title={text}
    >
      <bdi>{text}</bdi>
    </span>
  );
}

/** Açık kartta gösterilen önizleme satırı; gerisi "Tümünü göster" ile açılır. */
const OUTPUT_PREVIEW = 20;
/** Araç çıktısında çizilen en çok satır: dev çıktı kartı kilitlemesin. */
const OUTPUT_LIMIT = 400;

/**
 * Komut gövdesi: ZCode'un komut kartı — `$ komut` satırı, altında mono çıktı bloğu. Çıktı beş
 * satırda sınırlanıp kendi içinde kaydırılır (ZCode aynı sınırı kullanır): uzun çıktı açık kartı
 * sohbetin ortasında sonsuza uzatmaz. Satır numarası yoktur, terminal çıktısı diff değildir.
 */
export function CommandBody({
  command,
  output,
  running,
  waiting,
  empty,
  onOpenFile,
}: {
  command: string;
  output: string;
  running: boolean;
  /** Süren komutun boş çıktısı yerine yazılan durum satırı ("çıktı bekleniyor…"). */
  waiting: string;
  empty: string;
  onOpenFile?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLPreElement>(null);
  // Akış sürerken çıktı dibe yapışık kalır; kullanıcı yukarı kaydırınca takip durur, dibe
  // dönünce yeniden başlar (ZCode'un terminal çıktısı da böyle davranır).
  const follow = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || !follow.current) return;
    el.scrollTop = el.scrollHeight;
  });
  const text = output.trim().length > 0 ? output.replace(/\n$/, "") : running ? waiting : empty;
  return (
    <div className="mt-1 space-y-3 rounded-xl border border-line bg-card2 px-3 py-3">
      <div className="flex items-start gap-2 text-[14px]">
        <span className="shrink-0 text-tx3">$</span>
        <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words font-code text-[12.5px] text-tx2">
          {command}
        </pre>
        <CopyButton
          text={output}
          label
          size={12}
          className="flex shrink-0 items-center gap-[4px] text-tx3 hover:text-tx"
        />
      </div>
      <pre
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 8;
        }}
        // Çıktı `$` iminin değil **komut metninin** hizasından başlar (ZCode'da da öyle).
        className="ml-[11px] max-h-[5lh] overflow-auto whitespace-pre-wrap break-words font-code text-[12.5px] leading-[1.65] text-tx2"
      >
        {text}
      </pre>
      {onOpenFile ? (
        <div className="flex items-center gap-3 text-[12px] text-tx3">
          {onOpenFile ? (
            <button type="button" className="hover:text-tx" onClick={onOpenFile}>
              {t("tool.openInFile")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Satırı shiki belirteçleriyle çizer; değişen aralık varsa o aralık vurgu zeminine alınır (renk
 * korunur). Belirteç yoksa (dil bilinmiyor ya da vurgulama sürüyor) düz metin çizilir.
 */
function lineSpans(
  text: string,
  tokens: Token[] | undefined,
  highlight: [number, number] | null,
  tone: string,
) {
  const source: Token[] = tokens && tokens.length > 0 ? tokens : [{ text }];
  const bounds: number[] = [0];
  let pos = 0;
  for (const tok of source) {
    pos += tok.text.length;
    bounds.push(pos);
  }
  const [from, to] = highlight ?? [-1, -1];
  const parts: Array<{ text: string; token: Token; marked: boolean; key: string }> = [];
  source.forEach((tok, index) => {
    const start = bounds[index] ?? 0;
    const end = bounds[index + 1] ?? text.length;
    // Değişen aralık belirtecin ortasına düşebilir: parça sınıra göre bölünür.
    const cuts = [
      start,
      ...(highlight && from > start && from < end ? [from] : []),
      ...(highlight && to > start && to < end ? [to] : []),
      end,
    ].sort((a, b) => a - b);
    for (let i = 0; i < cuts.length - 1; i += 1) {
      const s = cuts[i] ?? start;
      const e = cuts[i + 1] ?? end;
      if (e <= s) continue;
      parts.push({
        text: text.slice(s, e),
        token: tok,
        marked: highlight !== null && s >= from && e <= to,
        key: `${index}-${s}`,
      });
    }
  });
  return parts.map((part) => (
    <span
      key={part.key}
      style={{
        color: part.token.color,
        fontStyle: part.token.italic ? "italic" : undefined,
        fontWeight: part.token.bold ? 600 : undefined,
        // Değişen parça satır dolgusundan **belirgin** ayrılır ve metni yüksek kontrasta geçer:
        // sözdizimi rengi (ör. yeşil dize) kendi zemininde eriyordu ("yeşil üzerine yeşil").
        ...(part.marked && tone
          ? {
              backgroundColor: `var(${tone === "--add" ? "--addWord" : "--delWord"})`,
              color: "var(--tx)",
              borderRadius: 3,
            }
          : {}),
      }}
    >
      {part.text}
    </span>
  ));
}

/**
 * Renklendirilmiş diff / çıktı satırları; araç kartı, tur altı dosya listesi ve sağ paneldeki
 * Değişiklikler sekmesi aynı çizimi paylaşır.
 *
 * Üç biçim gelir ve tek satır biçimine çevrilir: ham yama (`diff --git … @@`, ör. `git diff`),
 * Pi'nin araç diff'i (`+12 metin`) ve diff olmayan çıktı (okuma, arama). Cetvel **tek** sütundur:
 * Pi satır başına tek numara verir, iki sütun aynı sayıyı iki kez yazıyordu. Ortak girinti atılır
 * (bkz. `dedentRows`), aradaki değişmeyen bloklar tek satırda toplanır.
 */
export function DiffLines({
  output,
  kind,
  empty,
  path,
}: {
  output: string;
  kind: ToolKind;
  empty: string;
  /** Dosya yolu: sözdizimi vurgusu (shiki) dili buradan bulunur; yoksa düz metin çizilir. */
  path?: string | undefined;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const patch = output ? isUnifiedDiff(output) : false;
  const all = useMemo(() => {
    if (!output) return [];
    if (patch) return dedentRows(buildPatchRows(output));
    const isDiff = kind === "edit" || kind === "create" || kind === "delete";
    return dedentRows((isDiff ? parseToolDiff(output) : plainRows(output)).slice(0, OUTPUT_LIMIT));
  }, [output, patch, kind]);
  // Ham yama kırpılmaz: Değişiklikler sekmesi dosyanın tüm hunk'larını gösterir.
  const clamped = !patch && all.length > OUTPUT_PREVIEW;
  const rows = useMemo(
    () => (clamped && !open ? all.slice(0, OUTPUT_PREVIEW) : all),
    [all, clamped, open],
  );
  // Cetvel genişliği en uzun numaraya göre ve tüm satırlardan ölçülür: "Tümünü göster" ile
  // açılınca sütun genişleyip kodu kaydırmasın.
  const gutter = useMemo(() => {
    let digits = 2;
    for (const row of all) {
      const no = row.type === "line" ? lineNumberOf(row.line) : null;
      if (no !== null) digits = Math.max(digits, String(no).length);
    }
    return `calc(${digits}ch + 17px)`;
  }, [all]);
  // Satır indeksleri: yalnız içerik satırları sayılır (başlık/ayraç satırları değil).
  const { codeText, codeIndex } = useMemo(() => {
    const texts: string[] = [];
    const index = rows.map((row) => {
      if (row.type !== "line") return -1;
      texts.push(row.line.text);
      return texts.length - 1;
    });
    return { codeText: texts.join("\n"), codeIndex: index };
  }, [rows]);
  const lang = path ? langForPath(path) : null;
  const tokens = useHighlightedLines(codeText, lang);
  return (
    <div className="flex flex-col">
      <ClampFade open={!clamped || open}>
        <div className="overflow-x-auto py-2">
          {/* `w-max min-w-full`: satırlar en uzun satır kadar genişler, yatay kaydırmada ekleme/
              silme dolgusu kodun sonuna kadar uzanır (satır kutusu sütun genişliğinde kalıyordu). */}
          <div className="flex w-max min-w-full flex-col font-code text-[12.5px] leading-[1.7]">
            {rows.map((row, i) => {
              if (row.type === "hunk")
                return (
                  <div
                    key={`h-${i}`}
                    className="border-line border-b bg-bg2 py-[4px] text-[11.5px] text-tx2"
                  >
                    <span className="sticky left-0 inline-block px-[10px]">{row.text}</span>
                  </div>
                );
              if (row.type === "gap")
                // Değişmeyen blok: cetvel çizgisi kesilmez, metin kod sütununun hizasında durur.
                return (
                  <div
                    key={`g-${i}`}
                    className="flex border-line border-y bg-bg2 text-[11.5px] text-tx3"
                  >
                    <span
                      style={{ width: gutter }}
                      className="sticky left-0 z-[1] shrink-0 border-line border-r bg-bg2"
                    />
                    <span className="sticky py-[2px] pl-[20px]" style={{ left: gutter }}>
                      {t("changes.unmodifiedLines", { count: row.count })}
                    </span>
                  </div>
                );
              const l = row.line;
              // Satırın kendisi normal renkte okunur; ekleme/silme bilgisini satır dolgusu, soldaki
              // 3px ray ve satır numarası taşır. Metni kırmızı/yeşil boyamak uzun diff'lerde okumayı
              // zorlaştırıyordu.
              const tone = l.kind === "add" ? "--add" : l.kind === "del" ? "--del" : "";
              const rowStyle = tone
                ? { backgroundColor: `var(${tone === "--add" ? "--addBg" : "--delBg"})` }
                : undefined;
              const gutterStyle = tone
                ? {
                    width: gutter,
                    backgroundColor: `var(${tone === "--add" ? "--addWord" : "--delWord"})`,
                    boxShadow: `inset 3px 0 0 var(${tone})`,
                  }
                : { width: gutter, backgroundColor: "var(--bg)" };
              const signTone =
                l.kind === "add" ? "text-add" : l.kind === "del" ? "text-del" : "text-tx3";
              return (
                <div key={`l-${i}`} style={rowStyle} className="flex text-tx">
                  <span
                    style={gutterStyle}
                    className={`sticky left-0 z-[1] shrink-0 select-none border-line border-r px-[8px] text-right text-[11.5px] tabular-nums ${
                      tone ? signTone : "text-tx3"
                    }`}
                  >
                    {lineNumberOf(l) ?? ""}
                  </span>
                  <span className={`w-[20px] shrink-0 select-none text-center ${signTone}`}>
                    {l.kind === "add" ? "+" : l.kind === "del" ? "-" : ""}
                  </span>
                  <span className="whitespace-pre pr-[12px]">
                    {lineSpans(l.text, tokens[codeIndex[i] ?? -1], l.highlight, tone)}
                  </span>
                </div>
              );
            })}
            {all.length === 0 ? (
              <div className="px-3 font-mono text-[12px] text-tx3">{empty}</div>
            ) : null}
          </div>
        </div>
      </ClampFade>
      {clamped ? (
        <div className="flex justify-center pb-[6px]">
          <ClampToggle
            open={open}
            count={all.length - OUTPUT_PREVIEW}
            onClick={() => setOpen((v) => !v)}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Arama yolunun etiketi: sağlayıcının yerleşik araması ya da DuckDuckGo (`html.`/`lite.` uç
 * noktaları aynı etiketi paylaşır — kullanıcı için ikisi de DuckDuckGo'dur). Alan eski kayıtlarda
 * ve arama dışı çağrılarda yoktur; o zaman etiket yazılmaz.
 */
function searchBackendLabel(backend: SearchBackend | undefined, t: TFunction): string {
  if (backend === "native") return t("tool.searchNative");
  if (backend === "searxng") return t("tool.searchSearxng");
  if (backend === "brave") return t("tool.searchBrave");
  return backend === undefined ? "" : t("tool.searchDuckDuckGo");
}

function meta(item: ToolCallItem, t: TFunction) {
  if (item.status === "running") {
    // Denetim kartı çalışırken aracın yayınladığı son ilerleme satırı görünür.
    if (item.kind === "audit") {
      const last = progressLine(item);
      if (last) return { text: last, tone: "muted" as const };
    }
    // "çalışıyor…" yazılmaz: satır fiili zaten sürekli biçimde ("Çalıştırılıyor") ve parıltılı;
    // yanına bir de durum metni koymak aynı şeyi iki kez söylüyordu.
    return { text: "", tone: "muted" as const };
  }
  if (item.status === "blocked") return { text: t("tool.blocked"), tone: "muted" as const };
  if (item.status === "stopped") return { text: t("tool.stopped"), tone: "muted" as const };
  if (item.status === "denied") return { text: t("tool.denied"), tone: "bad" as const };
  if (item.status === "error") {
    // Korumalı alandaki başarısız komut: hata bir yazma engelinden de gelmiş olabilir, söylenir.
    const text =
      item.kind === "terminal" && item.sandboxed
        ? `${t("tool.sandboxed")} · ${t("tool.error")}`
        : t("tool.error");
    return { text, tone: "bad" as const };
  }
  const out = item.output ?? "";
  if (item.kind === "edit" || item.kind === "create") {
    const { add, del } = changeCounts(item);
    if (add || del) return { text: `+${add} −${del}`, tone: "good" as const };
    return { text: t("tool.done"), tone: "good" as const };
  }
  if (item.kind === "read") {
    const n = out ? out.split("\n").length : 0;
    return { text: n ? t("tool.lines", { count: n }) : "", tone: "muted" as const };
  }
  if (item.kind === "search") {
    const n = out ? out.split("\n").length : 0;
    const matches = t("tool.matches", { count: n });
    const backend = searchBackendLabel(item.searchBackend, t);
    // Hangi yolla arandığı ölçünün önüne yazılır: sağlayıcının yerleşik araması ile DuckDuckGo
    // sonucu ekranda aynı görünüyordu, ikisi de aynı arayüzü kullanıyor.
    return {
      text: backend ? `${backend} · ${matches}` : matches,
      tone: "muted" as const,
    };
  }
  // Korumalı alanda koşan komut bunu söyler: kullanıcı hangi komutun sınırlı çalıştığını görür.
  if (item.kind === "terminal" && item.sandboxed)
    return { text: t("tool.sandboxed"), tone: "muted" as const };
  // Terminal başarısında sağda metin yok: varsayılan durumu göstermek gürültü, hata zaten yukarıda.
  return { text: "", tone: "muted" as const };
}

/** Başarısız çağrıda fiil sonucu söyler: "Oluşturuldu · hata" yerine "Oluşturulamadı". Çalışırken fiil sürekli biçimdedir ("Çalıştırılıyor"): bitmiş görünen "Çalıştırıldı" etiketi takılmış hissi veriyordu. */
function titleOf(item: ToolCallItem, t: TFunction): string {
  if (item.status === "running") return t(`tool.activeTitle.${item.kind}`);
  if (terminalNotRun(item)) return t("tool.notRun");
  if (item.status !== "error" && item.status !== "denied") return item.title;
  if (item.kind === "terminal" || item.kind === "other") return item.title;
  return t(`tool.failedTitle.${item.kind}`);
}

/** Hedef yolu kısaltır (cwd'ye göreli, ~), terminalde komutu olduğu gibi bırakır. */
function targetOf(item: ToolCallItem, cwd: string, home: string): string {
  // Terminal/silme satırında komut olduğu gibi yazılır (ZCode ham komutu gösterir).
  if (item.kind === "terminal" || item.kind === "delete") return item.command ?? item.target ?? "";
  const target = item.target ?? "";
  if (!target.startsWith("/")) return target;
  return shortPath(target, cwd, home);
}

/** Çalışan kartta boş çıktı yerine durumu söyleyen satır; denetimde avcı/doğrulayıcı ayrılır. */
function runningEmpty(item: ToolCallItem, t: TFunction): string {
  if (item.kind !== "audit") return t("tool.waitingOutput");
  return item.toolName === "audit_verify" ? t("tool.auditVerifyWaiting") : t("tool.auditWaiting");
}

/** Hatalı çıktının ilk dolu satırı; kart açılmadan satırın altında görünür, uzunsa kırpılır. */
function errorLine(item: ToolCallItem): string {
  const line =
    (item.output ?? "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

/**
 * Satır çerçevesi: ikon, fiil, hedef, ölçü, ok. ZCode'un araç satırı gibi **içerik genişliğinde**
 * ve sola yaslı: sütunu baştan sona dolduran satırda ok 720px öteye savruluyor, iki kelimelik bir
 * çağrı kocaman bir boşlukla okunuyordu. `self-start` şart — flex kolonda varsayılan `stretch`
 * satırı yine tam genişliğe gerer. Satır dolgusu hover'da değişmez (kart, grup ve düşünme satırı
 * aynı hizada kalır); yalnız ok belirir.
 */
export const ROW_CLASS =
  "group/row inline-flex max-w-full items-center gap-2 self-start rounded-[8px] py-[4px] text-left text-[14px]";
/** İkincil satırların (hata ayrıntısı) sol hizası: ikon (16px) + satır boşluğu (8px). */
const ROW_INDENT = "pl-[24px]";

/**
 * Satırın ok işareti: metnin hemen ardında durur, sağa bakar ve satır açılınca 90° döner
 * (ZCode'da olduğu gibi). Durağan hâlde görünmez, satırın üzerine gelince belirir. Ok her zaman
 * yer kapladığı için belirirken satır genişliği oynamaz; klavyeyle gezen de görebilsin diye
 * odaklanan satırda da çıkar.
 */
export function RowChevron({ open, always = false }: { open: boolean; always?: boolean }) {
  return (
    <Icon
      name="chevronRight"
      size={16}
      stroke={2}
      className={`shrink-0 text-tx3 transition-all duration-200 ${
        open
          ? "rotate-90 opacity-100"
          : always
            ? "opacity-70"
            : "opacity-0 group-hover/row:opacity-100 group-focus-visible/row:opacity-100"
      }`}
    />
  );
}

export function ToolCard({
  item,
  attempts = [],
  cwd = "",
  home = "",
  onOpen,
}: {
  item: ToolCallItem;
  /** Aynı hedefe önceki başarısız denemeler; kart tek satırda "N. deneme" olarak gösterir. */
  attempts?: ToolCallItem[];
  cwd?: string | undefined;
  home?: string | undefined;
  /** "Dosyada aç": hedefi çağıranın görünümünde açar (sağ panel, asistan çıktı görünümü). */
  onOpen?: ((path: string) => void) | undefined;
}) {
  const { t } = useTranslation();
  // PRD 11: araç olayından kartın çizilmesine geçen süre (yalnız canlı beklenen satırlar).
  useEffect(() => toolLatency.rendered(item.id), [item.id]);
  // Açık/kapalı durumu modül düzeyinde tutulur: oturum değiştirip dönünce açtığın kart açık kalır.
  const [open, toggleOpen] = useToolCardOpen(item.id);
  // Alt ajan bağı: `explore` gibi çağrılar bir alt oturum açar; kart rozetlenir ve canlı izi
  // tek düğmeyle açılır. Sağlayıcı yoksa (panel, önizleme) davranış değişmez.
  const agentBadge = useAgentBadge();
  const agentRun = useAgentRun(item.id) ?? null;
  // Alt ajana bağlı kart (explore/agent çağrısı) satır içi açılmaz: ayrıntı zaten sağ paneldeki
  // Ajanlar sekmesinde canlı akar, bu yüzden satır doğrudan o paneli açar. Koşu düşürülmüşse
  // (temizlendi ya da kırpıldı) kart normal davranışına döner: satır içi açılır.
  const agentLinked = agentRun !== null && agentBadge !== null;
  // Adım listesi kartı: satırda "şu an ne yapılıyor" ve "3/7" yazar (ZCode'un todo kartı gibi).
  // Liste yoksa (araç henüz sonuç döndürmedi) kart bilinen meta'ya düşer.
  const steps = item.toolName === TASK_LIST_TOOL ? taskListSteps(item.output ?? "") : [];
  const activeStep = activeStepOf(steps);
  const doneSteps = steps.filter((s) => s.done).length;
  const stepMeta =
    steps.length > 0
      ? {
          text: `${doneSteps}/${steps.length}`,
          tone: doneSteps === steps.length ? "good" : "muted",
        }
      : undefined;
  const m = stepMeta ?? meta(item, t);
  const failed = item.status === "error" || item.status === "denied";
  const blocked = item.status === "blocked";
  // Diff rozeti iki renkli basılır (+ yeşil, − kırmızı); başarısız kartlar meta'daki tek renk metni kullanır.
  const diffBadge =
    !failed && (item.kind === "edit" || item.kind === "create") ? changeCounts(item) : null;
  // Hata meta metni ("hata", "Düzenlenemedi") kırmızı: gri kaldığında başarısız komut, başarılı
  // olandan yalnız bir kelimeyle ayrılıyordu.
  const tone = m.tone === "good" ? "text-green" : m.tone === "bad" ? "text-red" : "text-tx3";
  // İkon rengi türü anlatır, durumu değil: yeni dosya ve başarıyla biten komut yeşil, gerisi nötr.
  const iconTone =
    item.kind === "create" || (item.kind === "terminal" && item.status === "done")
      ? "text-green"
      : "text-tx3";
  // Süren satırın fiili parlar (dönen yay kaldırıldı: ZCode da yükleme simgesi çizmez, süren
  // işi parıltılı fiille söyler). Hatalı satırın fiili nötr kalır: hatayı kırmızı meta metni
  // ("Düzenlenemedi") ve altındaki ayrıntı satırı söyler; satırın tamamı kırmızıya boyanmaz.
  const labelTone = item.status === "running" ? "cz-shimmer" : "text-tx2";
  const target = activeStep?.label ?? targetOf(item, cwd, home);
  // Adım listesi kartı kendi ikonunu taşır: `other` türünün MCP ikonu bir yapılacaklar listesi
  // için yanıltıcıydı (ZCode'un todo satırı da liste ikonu kullanır).
  const iconName: IconName = item.toolName === TASK_LIST_TOOL ? "list" : KIND_ICON[item.kind];
  const isPath = item.kind !== "terminal" && item.kind !== "delete" && target.includes("/");
  // ZCode dosya satırında adı ve klasörü ayırır: "Edit progress.ts  apps/.../lib/". Tek parça yol
  // satırı uzun tutup adı kaydırıyordu; ayrıca ad, dosyayı açan düğme olur.
  const name = isPath ? (target.split("/").pop() ?? target) : target;
  const dir = isPath ? target.slice(0, Math.max(0, target.length - name.length - 1)) : "";
  // Komut olduğu gibi gösterilir: ZCode ham komutu yazar (`cd … && …` dahil). Eskiden `cd <cwd>`
  // öneki kırpılıyordu; kullanıcının ZCode ekranıyla karşılaştırdığında gördüğü fark buydu.
  const head = item.kind === "terminal" ? `$ ${item.command ?? ""}` : (item.target ?? "");
  // Komut kartı: terminal ve silme çağrıları çıktıyı diff gibi değil, komut + çıktı olarak çizer.
  const isCommand = item.kind === "terminal" || item.kind === "delete";
  const commandLine = item.command ?? item.target ?? "";
  const attemptNo = attempts.length + 1;
  // "Dosyada aç" ham yolu ister: satırdaki hedef kısaltılmış (cwd/home ile), panel ve önizleme
  // ise tam yolla açıyor. Terminal ve denetim satırlarının açılacak dosyası yok.
  const filePath = item.kind === "terminal" || item.kind === "audit" ? "" : (item.target ?? "");
  // Kapalı satır kenarlıksız: onlarca kart alt alta gelince kutu duvarı olmasın. Hata, meta metni
  // ("Düzenlenemedi", "1 hata") ve altındaki ayrıntı satırıyla okunur — renkle değil; engellenen
  // çağrı da hata değildir, aynı nötr tonda kalır. Açık karta çerçeve gelir ama satır içeriği
  // kaymaz: çerçeve 8px dışa taşar (negatif marj + aynı ölçüde iç dolgu), böylece kenarlık ikona ve
  // oka basmaz, ayırıcı çizgiler de kenarlığa yapışmaz; başlık satırı kapalı komşularıyla aynı
  // hizada kalır. Satıra çerçeve **çizilmez**: ZCode'da çerçeveyi açılan gövde kartı taşır (komut
  // kartı, diff kartı). Eskiden satır da çerçevelenince satır + kart iç içe iki kutu gibi duruyordu.
  const frame = "border-transparent";
  const detail = (failed || blocked) && !open ? errorLine(item) : "";
  // Süren alt ajanın son etkinliği kartın altında tek satır akar; kullanıcı kartı açmadan görür.
  const agentActivity =
    agentRun && item.status === "running" && !detail ? (agentRun.activity ?? "") : "";
  /** Satır tıklaması: alt ajan koşusunda paneli açar, diğer kartlarda gövdeyi açar/kapatır. */
  const activate = () => {
    if (agentLinked) {
      agentBadge.open(agentRun);
      return;
    }
    toggleOpen();
  };

  return (
    <div className={`overflow-hidden rounded-[8px] border ${frame}`}>
      {/* Satır `div role="button"`dır, `<button>` değil: içinde dosyayı açan gerçek bir düğme var
          ve iç içe düğme geçersiz HTML'dir (React de hydration hatası basar). ZCode'un araç satırı
          da bu yüzden div'dir; Enter/Space ile açılma elle bağlanır. */}
      {/* biome-ignore lint/a11y/useSemanticElements: satır <button> olamaz — içinde dosyayı açan
          gerçek bir düğme var; iç içe düğme geçersiz HTML'dir ve React hydration hatası verir. */}
      <div
        role="button"
        tabIndex={0}
        {...(agentLinked ? {} : { "aria-expanded": open })}
        onClick={activate}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          activate();
        }}
        className={`${ROW_CLASS} cursor-pointer`}
      >
        <Icon name={iconName} size={16} className={iconTone} />
        <span className={`shrink-0 font-medium ${labelTone}`}>{titleOf(item, t)}</span>
        {isPath ? (
          <>
            <FileTypeIcon name={name} size={15} />
            {onOpen ? (
              <button
                type="button"
                title={t("transcript.openPath")}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen(item.target ?? "");
                }}
                className="shrink-0 text-[14px] text-tx2 hover:underline"
              >
                {name}
              </button>
            ) : (
              <span className="shrink-0 text-[14px] text-tx2">{name}</span>
            )}
            <span className="min-w-0 truncate text-[14px] text-tx3">{dir}</span>
          </>
        ) : isCommand && open ? null : (
          <span className="min-w-0 truncate text-[14px] text-tx3">{target}</span>
        )}
        {attempts.length > 0 ? (
          <span className="shrink-0 rounded-[4px] border border-line px-[5px] py-[1px] text-[11px] text-tx3">
            {t("tool.attempt", { count: attemptNo })}
          </span>
        ) : null}
        {agentRun ? (
          <span className="shrink-0 rounded-[4px] border border-line px-[5px] py-[1px] text-[11px] text-tx3">
            {t("agents.badge")}
          </span>
        ) : null}
        {/* Diff rozeti iki renkli, rakamlar hizalı (sütun oynamaz); öteki ölçüler tek renk. */}
        {diffBadge && (diffBadge.add || diffBadge.del) ? (
          // Sayılar rakam rakam çevrilir: yazma/düzenleme sürerken canlı ölçü her tazelendiğinde
          // yalnız değişen basamak oynar, satır zıplamaz (ZCode'un sayaç rozeti).
          <span className="shrink-0 font-mono text-[13px] tabular-nums">
            <span className="text-green">
              +<FlipNumber value={diffBadge.add} />
            </span>{" "}
            <span className="text-red">
              −<FlipNumber value={diffBadge.del} />
            </span>
          </span>
        ) : m.text ? (
          <span className={`shrink-0 font-mono text-[13px] tabular-nums ${tone}`}>{m.text}</span>
        ) : null}
        {agentLinked ? <RowChevron open={false} always /> : <RowChevron open={open} />}
      </div>
      {detail ? (
        <div
          className={`truncate ${ROW_INDENT} pr-[9px] pb-[6px] font-mono text-[12px] text-tx3`}
          title={detail}
        >
          {detail}
        </div>
      ) : null}
      {agentActivity ? (
        <div className={`truncate ${ROW_INDENT} pr-[9px] pb-[6px] font-mono text-[12px] text-tx3`}>
          {agentActivity}
        </div>
      ) : null}
      {open ? (
        <div className="pb-2">
          {attempts.map((a, i) => (
            <div key={a.id} className="border-b border-line">
              <div className="flex items-center gap-2 px-[11px] py-[7px] text-[12px] text-tx3">
                <span className="font-mono">{t("tool.attempt", { count: i + 1 })}</span>
                <span className="font-mono text-tx2">
                  {a.status === "blocked"
                    ? t("tool.blocked")
                    : a.status === "denied"
                      ? t("tool.denied")
                      : t("tool.error")}
                </span>
              </div>
              <DiffLines
                output={a.output ?? ""}
                kind={a.kind}
                empty={t("tool.noOutput")}
                path={a.target}
              />
            </div>
          ))}
          {isCommand ? (
            // Komut kartı kendi çerçevesini çizer (ZCode'un komut çıktısı gibi): satır başlığı yok.
            <CommandBody
              command={commandLine}
              output={item.output ?? ""}
              running={item.status === "running"}
              waiting={runningEmpty(item, t)}
              empty={t("tool.noOutput")}
              onOpenFile={onOpen && filePath ? () => onOpen(filePath) : undefined}
            />
          ) : (
            // Kutu satırın sol çizgisinde başlar (ikonun ve sohbet metninin hizası); yanlardan
            // içeri çekilince satırla kutu arasında kayık bir basamak oluşuyordu.
            <div className="mt-1 overflow-hidden rounded-xl border border-line">
              <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-[12px] text-tx3">
                <span className="min-w-0 flex-1 truncate font-mono">{head}</span>
                <CopyButton
                  text={item.output ?? ""}
                  label
                  size={12}
                  className="flex shrink-0 items-center gap-[4px] hover:text-tx"
                />
                {onOpen && filePath ? (
                  <button
                    type="button"
                    className="shrink-0 hover:text-tx"
                    onClick={() => onOpen(filePath)}
                  >
                    {t("tool.openInFile")}
                  </button>
                ) : null}
              </div>
              <DiffLines
                output={item.output ?? ""}
                kind={item.kind}
                empty={item.status === "running" ? runningEmpty(item, t) : t("tool.noOutput")}
                path={item.target}
              />
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Denetim gibi uzun koşan araçların yayınladığı en son ilerleme satırı; kartta da aynı satır
 * gösterilir. Canlı satır bunu hedef yerine yazar, ilerleme açmadan görünsün.
 */
function progressLine(item: ToolCallItem): string {
  return (
    (item.output ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .at(-1) ?? ""
  );
}

/**
 * Canlı grup satırının süren adımı: fiil ve hedef **ayrı** döner. ZCode'un komut grubu da
 * "Terminal · Running npm test" biçiminde yazar — etiket · süren fiil · komut. Fiil hedeften
 * ayrıldığı için hedef tek başına kırpılır (TailText): uzun komut fiili yutmaz.
 * Süren çağrı yoksa boş döner; satır o zaman dosya adlarını yazar. Hatalı çağrı zaten gruba
 * girmez (kendi satırında okunur), o yüzden burada hata dalı yoktur.
 */
function liveStepText(
  entries: ToolEntry[],
  cwd: string,
  home: string,
  t: TFunction,
): { verb: string; target: string; running: boolean } {
  const step = liveStep(entries);
  if (step?.item.status !== "running") return { verb: "", target: "", running: false };
  // Denetimde ilerleme satırı ("3/6 birim tarandı · 2 aday") hedeften daha çok bilgi verir.
  const progress = step.item.kind === "audit" ? progressLine(step.item) : "";
  if (progress) return { verb: "", target: progress, running: true };
  return {
    verb: t(`tool.activeTitle.${step.item.kind}`),
    target: targetOf(step.item, cwd, home),
    running: true,
  };
}

/**
 * Katlanmış satırın etiketi ve dosya adları: aynı türden ardışıklar "5 okundu · a.ts, b.ts…"
 * olur, karışık türlerde (okuma + arama) başlık tür sayımına döner ("2 okundu · 1 arandı").
 * Canlı satırda yalnız süren adım yokken hesaplanır: satır her olayda yeniden çizildiği için
 * süren çağrı varken bu iş hiç yapılmaz (bkz. `ToolGroup`).
 */
function collapsedRow(
  entries: ToolEntry[],
  item: ToolCallItem,
  cwd: string,
  home: string,
  lang: "tr" | "en",
  t: TFunction,
): { label: string; names: string[] } {
  // Okumada yalnızca dosya adı, aramada desen ya da görev metni olduğu gibi. Terminal
  // komutlarında liste çizilmez: iki komut virgülle birleşince satır komut çöplüğüne dönüyordu
  // (ZCode'un komut grubu da yalnızca "Terminal · 2 commands" yazar).
  const listed = item.kind !== "terminal" && item.kind !== "delete";
  const names = !listed
    ? []
    : entries.map((e) => {
        const target = targetOf(e.item, cwd, home);
        return item.kind === "read" && target.includes("/")
          ? (target.split("/").pop() ?? target)
          : target;
      });
  const mixed = entries.some((e) => e.item.kind !== item.kind);
  const labels: StopLabels = {
    error: (n) => t("transcript.toolErrors", { count: n }),
    blocked: (n) => t("transcript.toolBlocked", { count: n }),
    denied: (n) => t("transcript.toolDenied", { count: n }),
  };
  if (mixed) return { label: summarizeTools(entries, labels, lang), names };
  // Tek türde hatalı komut da sayılır ("3 çalıştırıldı", biri sıfır dışı çıkmış olabilir); hiç
  // çalışmamış (engellenen/reddedilen) çağrı sayılmaz, ayrıca yazılır.
  const blocked = entries.filter((e) => e.item.status === "blocked").length;
  const denied = entries.filter((e) => e.item.status === "denied").length;
  const ran = entries.length - blocked - denied;
  const parts: string[] = ran
    ? [
        t("transcript.groupLabel", {
          count: ran,
          title: lang === "tr" ? item.title.toLocaleLowerCase("tr") : item.title,
        }),
      ]
    : [];
  parts.push(...stopLabels({ errors: 0, blocked, denied }, labels));
  return { label: parts.join(" · "), names };
}

/**
 * Katlanmış araç satırı: ardışık keşif çağrıları (okuma/arama) "5 okundu · a.ts, b.ts…" olur,
 * karışık türler toplandığında başlık tür sayımına döner ("2 okundu · 1 arandı"); terminal
 * komutları "3 çalıştırıldı". Açılınca kartlar tek tek görünür.
 *
 * `live` (turun son adımı ve tur sürüyor) satır ZCode'un komut grubu gibi yazılır:
 * "Terminal · Çalıştırılıyor npm test" — tür etiketi (parıldar) · süren fiil · komut. ZCode
 * sayacı **çalışma bitince** yazar ("2 commands, 1 failed"), süren grupta komutu gösterir;
 * bu yüzden canlı satırda sayaç yoktur. Süren çağrı yoksa sağda dosya adları listelenir.
 */
export function ToolGroup({
  entries,
  cwd = "",
  home = "",
  lang,
  live = false,
  onOpen,
}: {
  entries: ToolEntry[];
  cwd?: string | undefined;
  home?: string | undefined;
  lang: "tr" | "en";
  /** Turun son adımı ve tur sürüyor: satır "etiket · süren fiil · hedef" biçiminde yazılır. */
  live?: boolean | undefined;
  onOpen?: ((path: string) => void) | undefined;
}) {
  const { t } = useTranslation();
  // Gruplanan çağrılar ayrı kart açmaz; ekrana grup satırıyla gelirler, ölçü de burada biter.
  useEffect(() => {
    for (const e of entries) toolLatency.rendered(e.item.id);
  }, [entries]);
  // Grup satırının anahtarı ilk çağrının kimliğidir: grup üyeleri turlar arasında değişmez.
  const [open, toggleOpen] = useToolCardOpen(`group-${entries[0]?.item.id ?? ""}`);
  const first = entries[0];
  if (!first) return null;
  const { kind } = first.item;
  const mixed = entries.some((e) => e.item.kind !== kind);
  const step = live ? liveStepText(entries, cwd, home, t) : undefined;
  // Ad listesi süren adım yokken gerekir: katlanmış satırda ve canlı satırda süren çağrı
  // bittiğinde. Canlı satır her olayda yeniden çizildiği için süren adım varken hiç hesaplanmaz.
  const collapsed =
    live && step?.running ? undefined : collapsedRow(entries, first.item, cwd, home, lang, t);
  // Tür etiketi ZCode'un grup adıdır: terminal grubu "Terminal", keşif grubu "Keşif".
  const liveLabel = t(
    groupFamily(kind) === "terminal" ? "transcript.groupTerminal" : "transcript.groupExplore",
  );
  return (
    <div className="flex flex-col gap-[2px]">
      <button
        type="button"
        onClick={toggleOpen}
        title={t("transcript.groupToggle")}
        className={`${ROW_CLASS} border border-transparent`}
      >
        <Icon name={mixed ? "list" : KIND_ICON[kind]} size={16} className="text-tx3" />
        {live && step?.running ? (
          <>
            {/* ZCode'un süren grup satırı: tür etiketi (parlar) · süren fiil · komut. */}
            <span className="shrink-0 font-medium text-[14px] cz-shimmer">{liveLabel}</span>
            <span className="shrink-0 text-tx3">·</span>
            {step.verb ? <span className="shrink-0 text-[14px] text-tx2">{step.verb}</span> : null}
            <TailText text={step.target} className="text-[14px] text-tx3" />
          </>
        ) : (
          <>
            {/* Süren çağrı yokken (ya da tur bittiğinde) satır sayımını yazar: ZCode sayacı
                çalışma bitince söyler ("2 commands, 1 failed"). */}
            <span className="shrink-0 font-medium text-[14px] text-tx2">{collapsed?.label}</span>
            <span
              className="min-w-0 truncate text-[14px] text-tx3"
              title={collapsed?.names.join("\n")}
            >
              {collapsed?.names.join(", ")}
            </span>
          </>
        )}
        <RowChevron open={open} />
      </button>
      {open ? (
        // Grup içeriği girintisiz: kartlar sohbet çerçevesinin kenarında, canlı turda da
        // diğer satırlarla aynı sol/sağ çizgide çizilir. Kart kimliği ilk çağrıda sabit kalır.
        <div className="flex flex-col gap-[2px]">
          {entries.map((e) => (
            <ToolCard
              key={e.anchorId}
              item={e.item}
              attempts={e.attempts}
              cwd={cwd}
              home={home}
              onOpen={onOpen}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
