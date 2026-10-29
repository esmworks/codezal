import { create } from "zustand";
import { loadJson, saveJson } from "../lib/storage";

/**
 * Panel şeridinde açılan sekmeler. "Terminal" tek bir sekme değildir: her terminal kendi
 * sekmesini açar (`terminal:<anahtar>`) ve adını sıra numarasından alır (Terminal 1, Terminal 2…).
 * "İşler" oturumun arka plan işleridir (Claude'daki "Background tasks" gibi): liste ve seçili
 * işin ayrıntısı aynı sekmede, geri okuyla gezilir.
 */
export type PanelTab =
  | "Tarayıcı"
  | "Dosyalar"
  | "Değişiklikler"
  | "Bulgular"
  | "İşler"
  | `terminal:${string}`;

/** Sabit adlı sekmeler: ikon ve etiket tabloları yalnız bunları tanır. */
export type BasePanelTab = Exclude<PanelTab, `terminal:${string}`>;

const TERM_PREFIX = "terminal:";

/** "İşler" sekmesinde ayrıntısı açık iş: alt ajan / ayrık koşu ya da arka plan komutu. */
export interface JobRef {
  /** İşin sahibi oturum; oturum değişince seçim düşer. */
  sessionId: string;
  kind: "agent" | "bg";
  /** Ajanda iz kimliği (`AgentJobRow.traceId`), komutta görev kimliği (`bg-N`). */
  id: string;
}

/** Terminal sekmesinin oturum anahtarı; terminal olmayan sekmede null. */
export function termKeyOf(tab: PanelTab): string | null {
  return tab.startsWith(TERM_PREFIX) ? tab.slice(TERM_PREFIX.length) : null;
}

/** Sekme terminal değilse sabit adlı hâlini döndürür; ikon/etiket tablosunda bu anahtar kullanılır. */
export function baseTabOf(tab: PanelTab): BasePanelTab | null {
  return termKeyOf(tab) ? null : (tab as BasePanelTab);
}

/**
 * Her oturumda açılabilen sekmeler. Terminal yoktur: palette "Yeni terminal" olarak girer ve
 * açılan her terminal şeride kendi sekmesini ekler.
 */
export const BASE_PANEL_TABS: BasePanelTab[] = ["Tarayıcı", "Dosyalar", "Değişiklikler"];

/**
 * Yalnız içeriği olduğunda açılabilen sekmeler: denetim run'ı olmayan oturumda "Bulgular", ajanı
 * ya da arka plan komutu olmayan oturumda "İşler" palet ve boş durum karolarında görünmez (boşta
 * duran sekme kullanıcıya iş yapıyormuş gibi görünüyordu). Sekme sahibi içeriğe göre ekler.
 */
export const RESULT_PANEL_TABS: BasePanelTab[] = ["Bulgular", "İşler"];

/** Sabit adlı tüm sekmeler; kayıtlı listeden geçerli olanları süzmek için. */
export const PANEL_TABS: BasePanelTab[] = [...BASE_PANEL_TABS, ...RESULT_PANEL_TABS];

const KNOWN_TABS = new Set<string>(PANEL_TABS);

/**
 * Kayıtlı sekme listesini süzer. Eski sürümün tek "Terminal" sekmesi ve terminal sekmeleri
 * düşer (kabuk yeniden başlatmada yoktur, ölü sekme açılmasın); etkin sekme açık değilse ilk
 * geçerli sekmeye dönülür.
 */
export function sanitizeTabs(
  tabs: unknown,
  active: unknown,
): { tabs: PanelTab[]; active: PanelTab } {
  const list = (Array.isArray(tabs) ? tabs : []).filter(
    (tab): tab is PanelTab => typeof tab === "string" && KNOWN_TABS.has(tab),
  );
  const open = [...new Set(list)];
  return { tabs: open, active: open.find((tab) => tab === active) ?? open[0] ?? "Tarayıcı" };
}

/** Kayıtlı sayfa yokken gömülü tarayıcının açtığı adres. */
export const BROWSER_HOME = "https://www.codezal.com";

/** Kayıtlı adres boş ya da `about:blank` ise tarayıcı boş beyaz sayfa yerine ana sayfayı açar. */
export function sanitizeBrowserUrl(url: unknown): string {
  if (typeof url !== "string") return BROWSER_HOME;
  const v = url.trim();
  return v && v !== "about:blank" ? v : BROWSER_HOME;
}

/** Açık bir terminalin şerit bilgisi; kabuğun kendisi `panel/TerminalTab.tsx`'te aynı anahtarla durur. */
export interface TerminalTabMeta {
  /** Şeritteki sıra numarası ("Terminal 2"). Sekme kapanıp yenisi açılınca boşalan numara verilir. */
  num: number;
  /** Kabuk bu projede açıldı; panel sekmeleri projeler arası ortak olduğu için cwd sekmede taşınır. */
  cwd: string;
  /** Kabuk kapandı: sekme soluk çizilir, açılınca kendiliğinden yeni kabuk başlatılmaz. */
  exited: boolean;
}

interface Persisted {
  tabs: PanelTab[];
  active: PanelTab;
  browserUrl: string;
  treeWidth: number;
  /** Proje kökü (cwd) → o projede son açılan dosya. Anahtar cwd olduğu için dosya projeler arası taşınmaz. */
  openFiles: Record<string, string>;
}

interface PanelState extends Persisted {
  full: boolean;
  /** Açık terminaller: anahtar → şerit bilgisi. Kalıcı değil: yeniden başlatmada kabuk yoktur. */
  terms: Record<string, TerminalTabMeta>;
  /** "İşler" sekmesinde ayrıntısı açık iş; null ise liste görünür. Kalıcı değil. */
  job: JobRef | null;
  recentFiles: string[];
  openTab: (tab: PanelTab) => void;
  closeTab: (tab: PanelTab) => void;
  setActive: (tab: PanelTab) => void;
  setFull: (full: boolean) => void;
  toggleFull: () => void;
  setBrowserUrl: (url: string) => void;
  setTreeWidth: (w: number) => void;
  setOpenFile: (cwd: string, path: string | null) => void;
  /** Proje kökünde yeni terminal sekmesi açar ve sekme kimliğini döndürür. */
  addTerminal: (cwd: string) => PanelTab;
  /** Aynı projede açık terminal varsa onu öne alır, yoksa yenisini açar (⌘J). */
  showTerminal: (cwd: string) => void;
  /** Kabuk kapanınca sekme işaretlenir; yeniden başlatılınca işaret geri alınır. */
  setTerminalExited: (key: string, exited: boolean) => void;
  /** "İşler" sekmesini açar; iş verilirse ayrıntısını, null ise listeyi gösterir. */
  showJob: (job: JobRef | null) => void;
  /** Başka oturumun seçili işini bırakır: oturum değişince eski oturumun ayrıntısı kalmaz. */
  clearJobExcept: (sessionId: string) => void;
}

const KEY = "codezal.panel";
const raw = loadJson<Persisted>(KEY, {
  tabs: [],
  active: "Tarayıcı",
  browserUrl: BROWSER_HOME,
  // Tasarımdaki 168px'te sık kullanılan adlar (CHANGELOG.md, pnpm-workspace.yaml) kırpılıyordu.
  treeWidth: 200,
  openFiles: {},
});
const persisted: Persisted = {
  ...raw,
  ...sanitizeTabs(raw.tabs, raw.active),
  browserUrl: sanitizeBrowserUrl(raw.browserUrl),
};

function persist(s: PanelState) {
  // Terminal sekmeleri yazılmaz: yeniden açılışta kabuk yok.
  const tabs = s.tabs.filter((tab) => baseTabOf(tab));
  saveJson(KEY, {
    tabs,
    active: baseTabOf(s.active) ? s.active : (tabs[0] ?? "Tarayıcı"),
    browserUrl: s.browserUrl,
    treeWidth: s.treeWidth,
    openFiles: s.openFiles,
  });
}

/** Aktif projedeki açık dosya; başka projenin dosyası bu yüzden asla dönmez. */
export function useOpenFile(cwd: string): string | null {
  return usePanel((s) => (cwd ? (s.openFiles[cwd] ?? null) : null));
}

/** Terminal anahtarı üreteci: anahtar yalnız bu oturumda benzersiz olmalı. */
let termSeq = 0;

export const usePanel = create<PanelState>((set, get) => ({
  ...persisted,
  full: false,
  terms: {},
  job: null,
  openFiles: persisted.openFiles,
  recentFiles: loadJson<string[]>("codezal.recentFiles", []),
  openTab: (tab) => {
    const tabs = get().tabs.includes(tab) ? get().tabs : [...get().tabs, tab];
    set({ tabs, active: tab });
    persist(get());
  },
  closeTab: (tab) => {
    const cur = get();
    const idx = cur.tabs.indexOf(tab);
    const tabs = cur.tabs.filter((t) => t !== tab);
    const active =
      cur.active === tab ? (tabs[Math.max(0, idx - 1)] ?? tabs[0] ?? cur.active) : cur.active;
    // Terminal sekmesinin kaydı da düşer; kabuğu kapatan taraf `Panel` (killTerminal).
    const terms = { ...cur.terms };
    const key = termKeyOf(tab);
    if (key) delete terms[key];
    set({ tabs, active, terms, job: tab === "İşler" ? null : cur.job });
    persist(get());
  },
  setActive: (active) => {
    set({ active });
    persist(get());
  },
  setFull: (full) => set({ full }),
  toggleFull: () => get().setFull(!get().full),
  setBrowserUrl: (browserUrl) => {
    set({ browserUrl });
    persist(get());
  },
  setTreeWidth: (treeWidth) => {
    set({ treeWidth });
    persist(get());
  },
  setOpenFile: (cwd, path) => {
    if (!cwd) return;
    const openFiles = { ...get().openFiles };
    if (path) openFiles[cwd] = path;
    else delete openFiles[cwd];
    const recentFiles = path
      ? [path, ...get().recentFiles.filter((f) => f !== path)].slice(0, 8)
      : get().recentFiles;
    set({ openFiles, recentFiles });
    saveJson("codezal.recentFiles", recentFiles);
    persist(get());
  },
  addTerminal: (cwd) => {
    const terms = get().terms;
    // Boşalan numara yeniden kullanılır: 2 kapatılıp yeni terminal açılınca adı yine 2 olur.
    const used = new Set(Object.values(terms).map((m) => m.num));
    let num = 1;
    while (used.has(num)) num += 1;
    termSeq += 1;
    const key = `t${termSeq}`;
    const tab: PanelTab = `${TERM_PREFIX}${key}`;
    set({
      terms: { ...terms, [key]: { num, cwd, exited: false } },
      tabs: [...get().tabs, tab],
      active: tab,
    });
    persist(get());
    return tab;
  },
  showTerminal: (cwd) => {
    const found = Object.entries(get().terms).find(([, meta]) => meta.cwd === cwd);
    if (found) get().openTab(`${TERM_PREFIX}${found[0]}`);
    else get().addTerminal(cwd);
  },
  showJob: (job) => {
    set({ job });
    get().openTab("İşler");
  },
  clearJobExcept: (sessionId) => {
    const job = get().job;
    if (job && job.sessionId !== sessionId) set({ job: null });
  },
  setTerminalExited: (key, exited) => {
    const meta = get().terms[key];
    if (!meta || meta.exited === exited) return;
    set({ terms: { ...get().terms, [key]: { ...meta, exited } } });
  },
}));
