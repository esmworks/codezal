import type {
  AgentEvent,
  AppMode,
  ExtensionUiValue,
  ImageAttachment,
  IpcRequest,
  IpcResponse,
  ModelRef,
  PermissionDecision,
  PermissionMode,
  PlanDecision,
  QuestionAnswers,
  SessionSummary,
  ThinkingLevel,
} from "@codezal/contracts";
import { deriveSessionTitle, promptQuotes } from "@codezal/contracts";
import { create, type StoreApi } from "zustand";
import { invoke, on } from "../api";
import { worktreeParent } from "../lib/format";
import { i18n } from "../lib/i18n";
import { toolLatency } from "../lib/perf";
import { collapsePrompt } from "../lib/promptText";
import { fallbackSession } from "../lib/sessionFallback";
import { homeCommandPorts, sessionCommandPorts } from "../session/commandPorts";
import { runSlashCommand } from "../session/commands";
import { addQuote, emptyDraft } from "../session/composerParts";
import { useAgents } from "./agents";
import { useApp } from "./app";
import { draftFor, useDrafts } from "./drafts";
import { useModels } from "./models";
import { emptyRuntime, reduceEvent, type SessionRuntime, uid } from "./reduce";
import { runtimeEvictions } from "./runtimeCache";
import { humanizeError, toast } from "./toast";

export { reduceEvent, type SessionRuntime, type SessionStatus } from "./reduce";

/**
 * Oturum başına olay imleci: snapshot ile canlı akışın uzlaştırma noktası. Sonraki olayın
 * `seq`'i `seq + 1` olmalı; epoch değişmişse ya da sıra atlanmışsa akışta kopukluk vardır.
 */
const cursors = new Map<string, { epoch: string; seq: number }>();

/**
 * Açılış sürmekte olan oturumlar: snapshot işlemelen çıkmadan gelen canlı olaylar burada bekletilir.
 * Bekletme, boş bir runtime'a uygulanan olayların snapshot ile ezilmesini önler (açılış yarışı).
 */
const openingSessions = new Map<string, AgentEvent[]>();

/**
 * Yeniden açma freni: iki tam snapshot arası en az bu süre olur. Snapshot pahalıdır (disk okuma +
 * koca transcript + tam yeniden çizim); kopuk olay ardı ardına gelse de arayüz boğulmaz.
 */
const RESNAPSHOT_MIN_INTERVAL_MS = 3000;

/** Oturum başına son yeniden açma anı ve fren penceresinde bekleyen artçı istek. */
const resnapshots = new Map<
  string,
  { at: number; timer: ReturnType<typeof setTimeout> | undefined }
>();

/**
 * Oturum silinince (ya da arşivden kalıcı silinince) o oturuma bağlı bütün istemci durumunu
 * bırakır: alt ajan izleri, olay imleci ve bekleyen yeniden açma.
 * Tek yerde toplanmasının sebebi iki silme yolunun da aynı temizliği yapması gerektiği.
 */
function forgetSessionState(id: string): void {
  useAgents.getState().forgetSession(id);
  // Taslak da düşer: oturum başına saklanan taslak base64 görsel taşıyabilir ve silinen oturum
  // uygulama kapanana kadar bellekte kalırdı.
  useDrafts.getState().clear(id);
  // Silinen oturumun imleci de düşer: aynı kimlikle yeni oturum açılırsa eski sırayla karışmasın.
  cursors.delete(id);
  // Bekleyen artçı yeniden açma varsa iptal edilir: silinmiş oturumu açmaya çalışmasın.
  const resnap = resnapshots.get(id);
  if (resnap?.timer) clearTimeout(resnap.timer);
  resnapshots.delete(id);
  dropRecency(id);
}

/** Silinen oturumların runtime ve okunmamış kaydını store'dan çıkarır (liste çağıranda kalır). */
function withoutSessions(
  s: Pick<SessionsState, "runtime" | "unread">,
  gone: Iterable<string>,
): Pick<SessionsState, "runtime" | "unread"> {
  const runtime = { ...s.runtime };
  const unread = { ...s.unread };
  for (const id of gone) {
    delete runtime[id];
    delete unread[id];
  }
  return { runtime, unread };
}

/** Oturumların son açılma sırası (en eski başta): bellekteki runtime'ı sınırlamak için. */
const recency: string[] = [];

function touchRecency(id: string): void {
  const at = recency.indexOf(id);
  if (at >= 0) recency.splice(at, 1);
  recency.push(id);
}

/** Kalıcı silinen oturum LRU sırasından da çıkar. */
function dropRecency(id: string): void {
  const at = recency.indexOf(id);
  if (at >= 0) recency.splice(at, 1);
}

/**
 * Son açılanların dışında kalan, boşta ve bekleyen kartı olmayan oturumların runtime'ını bırakır.
 * Yeniden açılınca `open` runtime'ı bulamaz ve `sessions:open` ile snapshot'tan kurar. İmleç ve
 * bekleyen yeniden açma da silinir: kalsaydı düşürülen oturumun sonraki olayı "sıra atlandı"
 * sayılıp oturumu kendiliğinden yeniden yüklerdi.
 */
function trimRuntimeCache(): void {
  const { runtime } = useSessions.getState();
  const keep = new Set<string>(openingSessions.keys());
  const active = useApp.getState().activeSessionId;
  if (active) keep.add(active);
  // Açık yan sohbetler panelde durur; ana oturumla birlikte bellekte kalır.
  for (const side of Object.values(useSessions.getState().side)) keep.add(side.id);
  const evict = runtimeEvictions(runtime, recency, keep);
  if (evict.length === 0) return;
  for (const id of evict) {
    cursors.delete(id);
    const resnap = resnapshots.get(id);
    if (resnap?.timer) clearTimeout(resnap.timer);
    resnapshots.delete(id);
    dropRecency(id);
  }
  useSessions.setState((s) => {
    const next = { ...s.runtime };
    for (const id of evict) delete next[id];
    return { runtime: next };
  });
}

/** Gap sonrası oturumu yeniden açar (resnapshot); açılış zaten sürüyorsa beklemeden çıkar. */
function resnapshot(id: string): void {
  if (openingSessions.has(id)) return;
  const entry = resnapshots.get(id) ?? { at: 0, timer: undefined };
  const wait = RESNAPSHOT_MIN_INTERVAL_MS - (Date.now() - entry.at);
  // Fren penceresi: isteği düşürmek yerine kalan süre sonunda bir kez çalıştır; aksi hâlde kopuk
  // olaydan sonra akış susarsa (tur sonu) arayüz bayat snapshot'ta kilitli kalırdı.
  if (wait > 0) {
    if (!entry.timer) {
      entry.timer = setTimeout(() => {
        entry.timer = undefined;
        resnapshot(id);
      }, wait);
      resnapshots.set(id, entry);
    }
    return;
  }
  entry.at = Date.now();
  entry.timer = undefined;
  resnapshots.set(id, entry);
  void useSessions
    .getState()
    .open(id, true)
    .catch(() => undefined);
}

/** Ana oturumun yan sohbeti (panel kapalıyken de uygulama açık kaldıkça durur). */
export interface SideChat {
  id: string;
  /**
   * Açılışta kopyalanan ortak geçmişin transkript uzunluğu: panel yalnız sonrasını çizer
   * (ana sohbet zaten solda duruyor).
   */
  base: number;
  /** Panel görünüyor mu; ✕ yalnız paneli kapatır, konuşma yeniden açılınca kaldığı yerden sürer. */
  open: boolean;
}

interface SessionsState {
  list: SessionSummary[];
  /**
   * Ana oturum kimliği → yan sohbeti. Bellekte durur; ana oturumla birlikte silinir, kalanları
   * uygulama açılışında main temizler.
   */
  side: Record<string, SideChat>;
  /**
   * Yan sohbet panelini açar. Önceden açılmışsa (✕ ile kapatılmış olsa da) aynı konuşma döner;
   * yoksa ana oturumun geçmişi salt okunur, listede görünmeyen bir dala kopyalanır. Alıntı
   * panelin taslağına yazılır: panel o anda kapalıysa da kaybolmaz.
   */
  openSide: (parentId: string, quote?: string) => Promise<SideChat>;
  /** Paneli kapatır; yan sohbet silinmez, yeniden açılınca kaldığı yerden sürer. */
  closeSide: (parentId: string) => void;
  /** Yan sohbeti kenar çubuğunda görünen ayrı oturuma çevirir; yeni oturumun özetini döner. */
  promoteSide: (parentId: string) => Promise<SessionSummary>;
  runtime: Record<string, SessionRuntime>;
  /** Kullanıcı görmeden biten turlar (okunmamış sohbet işareti). */
  unread: Record<string, boolean>;
  markRead: (id: string) => void;
  loadList: () => Promise<void>;
  create: (
    options: IpcRequest<"sessions:create">,
    firstPrompt: string,
    images?: ImageAttachment[],
  ) => Promise<SessionSummary | null>;
  open: (id: string, force?: boolean) => Promise<void>;
  /**
   * Giriş ekranlarının komut kapısı: metin yerel bir komutsa (`/yardım`, `/model`, `/geçmiş`)
   * yürütür ve `true` döner; çağıran gönderimi bırakır. Oturum henüz yoktur, seçimler genel
   * tercihe yazılır. Giriş ekranında gönderim, oturum açılmadan önce proje/sağlayıcı
   * denetimlerinden geçer; komut o denetimlerden **önce** sorulmalıdır — yoksa `/yardım` yazan
   * kullanıcı "sağlayıcı bağlı değil" hatası görürdü.
   */
  runCommand: (text: string) => Promise<boolean>;
  /** Ajan boştaysa yeni tur; çalışıyorsa yönlendirme (steer) olarak sıradaki modele girer. */
  prompt: (id: string, text: string, images?: ImageAttachment[]) => Promise<void>;
  /** Çalışırken kuyruğa alır: ajanın işi tamamen bitince ayrı tur olarak işlenir (followUp). */
  followUp: (id: string, text: string, images?: ImageAttachment[]) => Promise<void>;
  /** Bekleyen yönlendirme/takip mesajlarını temizler (Pi clearQueue). */
  clearQueue: (id: string) => Promise<void>;
  /**
   * Bağlamı şimdi özetler (`/compact`). Tur sürerken reddedilir; sonuç çağırana döner ki
   * arayüz kullanıcıya ne olduğunu söyleyebilsin.
   */
  compact: (id: string) => Promise<IpcResponse<"sessions:compact">>;
  /** Oturumu kopyalar; `at` verilirse o noktaya kadar (Dallandır). Yeni kimliği döner. */
  fork: (id: string, at?: ForkPoint) => Promise<string>;
  /**
   * N. kullanıcı mesajının öncesine geri sarar; yazıldığı biçimdeki metnini ve "Yanıtla"
   * alıntılarını döner (kutuya konur).
   */
  rewind: (id: string, userOrdinal: number) => Promise<{ text: string; quotes: string[] }>;
  abort: (id: string) => Promise<void>;
  /** Kalıcı hedef (`/goal`): set/stop/pause/resume; durum goal olaylarıyla akar. */
  goal: (
    id: string,
    action: "set" | "stop" | "pause" | "resume",
    text?: string,
    maxIter?: number,
  ) => Promise<void>;
  respond: (id: string, requestId: string, decision: PermissionDecision) => Promise<void>;
  /** Plan onay kartı: onay uygulamaya geçirir, ret geri bildirimle modele döner. */
  respondPlan: (id: string, requestId: string, decision: PlanDecision) => Promise<void>;
  /** Soru kartı: soru başına seçilen etiketler + serbest metin modele döner. */
  respondQuestion: (id: string, requestId: string, answers: QuestionAnswers) => Promise<void>;
  /** Eklenti `ctx.ui` kartı: seçim eklentiye döner (confirm boolean, select/input metin). */
  respondExtensionUi: (id: string, requestId: string, value: ExtensionUiValue) => Promise<void>;
  /** İzin modu: hem bu oturuma (canlı + meta) hem genel tercihe yazılır, sonraki görev de onunla başlar. */
  setPermission: (id: string, permission: PermissionMode) => Promise<void>;
  /** Model ve düşünme: bu oturuma yazılır ve genel tercih olur (sonraki görev onunla başlar). */
  setModel: (id: string, model: ModelRef) => Promise<void>;
  setThinking: (id: string, thinking: ThinkingLevel) => Promise<void>;
  /** Hata bandını kullanıcı kapattı: sonraki hata olayına kadar bir daha çizilmez. */
  dismissError: (id: string) => void;
  rename: (id: string, name: string) => Promise<void>;
  /** Başlığı son mesajlara göre modelle yeniden üretir. */
  regenerateTitle: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** Toplu silme: açık sohbet silinenler arasındaysa tek seferde silinmeyen komşuya geçilir. */
  removeMany: (ids: string[]) => Promise<void>;
  setPinned: (id: string, pinned: boolean) => Promise<void>;
  setArchived: (id: string, archived: boolean) => Promise<void>;
  /** Bir klasörün tüm oturumlarını arşivler (kenar çubuğu "Klasörü sil"). */
  /** Klasörün yalnızca verilen kipteki oturumlarını arşivler; diğer bölümler dokunulmaz. */
  archiveCwd: (cwd: string, mode: AppMode) => Promise<void>;
  purgeArchived: () => Promise<number>;
  /**
   * Olayı runtime'a uygular. `span` yalnız toplu delta yolunda verilir: birleştirilmiş olay
   * tek başına son sırayı taşıdığı için imleç karşılaştırması aralığın tamamına bakmalıdır.
   */
  applyEvent: (event: AgentEvent, span?: { from: number; to: number }) => void;
}

/** Dallandırma noktası: metinli N. asistan mesajından sonra ya da N. kullanıcı mesajından önce. */
export type ForkPoint = { assistantOrdinal: number } | { userOrdinal: number };

async function deliverUserMessage(
  set: StoreApi<SessionsState>["setState"],
  id: string,
  text: string,
  images: ImageAttachment[] | undefined,
  working: boolean,
  mode: "steer" | "followUp",
): Promise<void> {
  const withImages = images && images.length > 0;
  const entryId = uid("u");
  set((s) => {
    const rt = s.runtime[id] ?? emptyRuntime();
    return {
      runtime: {
        ...s.runtime,
        [id]: {
          ...rt,
          transcript: [
            ...rt.transcript,
            {
              type: "user",
              id: entryId,
              text,
              at: Date.now(),
              ...(withImages ? { images } : {}),
            },
          ],
        },
      },
    };
  });
  try {
    // Çalışırken yazılan mesaj varsayılan olarak yönlendirme kuyruğuna girer; görseller de aynı
    // yoldan taşınır, böylece busy iken görselli mesaj yeni tur başlatmaya çalışıp kaybolmaz.
    if (working && mode === "steer") {
      await invoke("sessions:steer", { id, text, ...(withImages ? { images } : {}) });
    } else if (working) {
      await invoke("sessions:followUp", { id, text, ...(withImages ? { images } : {}) });
    } else {
      await invoke("sessions:prompt", { id, text, ...(withImages ? { images } : {}) });
    }
  } catch (error) {
    // Mesaj motora ulaşmadıysa balon da kalmamalı; yoksa geri sarma engine'de bulunmayan
    // bir sıraya denk gelir.
    set((s) => {
      const rt = s.runtime[id];
      if (!rt) return {};
      return {
        runtime: {
          ...s.runtime,
          [id]: { ...rt, transcript: rt.transcript.filter((x) => x.id !== entryId) },
        },
      };
    });
    throw error;
  }
}

export const useSessions = create<SessionsState>((set, get) => ({
  list: [],
  side: {},
  runtime: {},
  unread: {},

  markRead: (id) => {
    if (!get().unread[id]) return;
    set((s) => ({ unread: { ...s.unread, [id]: false } }));
  },

  loadList: async () => {
    const list = await invoke("sessions:list", {});
    // Ajan koşusu oturumları kenar çubuğunda görünmez: ana oturumun Ajanlar kutusundan açılır.
    // Yan sohbetler de görünmez: ana oturumun yüzen panelinde açılırlar.
    set({ list: list.filter((x) => !x.parentSessionId && !x.sideOf) });
  },
  // Giriş ekranı komut kapısı (bkz. arayüz sözleşmesi): komut yürüdüyse `true`.
  runCommand: (text) => runSlashCommand(text, homeCommandPorts()),
  create: async (options, firstPrompt, images) => {
    // Komut kapısı giriş ekranlarında da geçerli: `/yardım`, `/model` ya da `/geçmiş` yazan
    // kullanıcı için boş bir oturum açılmaz, komut burada yürür ve `null` dönülür. Kapı iki yerde
    // durmak zorunda çünkü ilk mesaj bu yolda oturum açılmadan **önce** görülür; oturum içindeki
    // yol (`prompt`) kapıyı kendi çağrısında işletir.
    if (await runSlashCommand(firstPrompt, homeCommandPorts())) return null;
    const summary = await invoke("sessions:create", options);
    const rt = emptyRuntime();
    rt.permission = options.permission ?? "ask";
    rt.model = options.model ?? null;
    rt.thinking = options.thinking ?? null;
    set((s) => ({
      list: [
        {
          ...summary,
          name: options.name ?? deriveSessionTitle(firstPrompt, i18n.t("session.newTask")),
        },
        ...s.list,
      ],
      runtime: { ...s.runtime, [summary.id]: rt },
    }));
    touchRecency(summary.id);
    trimRuntimeCache();
    // İlk mesaj bekletmeden gönderilir: karşılama ekranı prompt onayını bekleyip boş görünmesin.
    // Gönderim `deliverUserMessage`'dan geçer — balonu o ekler ve reddedilirse geri alır. Eskiden
    // balon buraya elle eklenip istek ateşlenip unutuluyordu: hata yalnız konsola düşüyor, kullanıcı
    // mesajı gönderilmiş sanıyordu (motor ise hiç almamış oluyordu).
    void deliverUserMessage(set, summary.id, firstPrompt, images, false, "steer").catch((error) => {
      toast.error(humanizeError(error));
    });
    return summary;
  },
  open: async (id, force) => {
    if (!force && get().runtime[id]) {
      touchRecency(id);
      return;
    }
    // Zaten açık bir açılış varsa ikinci istek aynı sonucu bekletir; gap yeniden tetiklenmez.
    if (openingSessions.has(id)) return;
    openingSessions.set(id, []);
    if (force) cursors.delete(id);
    try {
      const {
        summary,
        transcript,
        context,
        usage,
        permission,
        model,
        thinking,
        backgrounds,
        goal,
        lastSeq,
        epoch,
        runId,
        buffered,
        permissions,
        planReview,
        question,
        subagents,
        subagentTraces,
      } = await invoke("sessions:open", { id });
      // Yeniden açılışta bekleyen kartlar snapshot'tan döner; yoksa kart kaybolur, kapı bekler.
      const awaiting = Boolean(permissions?.some((r) => !r.run) || planReview || question);
      set((s) => ({
        runtime: {
          ...s.runtime,
          [id]: {
            ...emptyRuntime(),
            transcript,
            context: context ?? null,
            permission: permission ?? null,
            model: model ?? null,
            thinking: thinking ?? null,
            // Açılış anında tur sürüyorsa runtime "tur açık" kurulur: aksi hâlde gelen akış
            // olayları stale-run kapısında düşer ve oturum, model çalışırken donuk görünür.
            activeRunId: runId,
            ...(awaiting ? { status: "waiting" as const } : {}),
            permissions: permissions ?? [],
            planReview: planReview ?? null,
            question: question ?? null,
            ...(backgrounds?.length ? { backgrounds } : {}),
            ...(subagents?.length ? { subagents } : {}),
            ...(usage ? { usage } : {}),
            ...(goal ? { goal } : {}),
          },
        },
        list: s.list.some((x) => x.id === id)
          ? s.list.map((x) => (x.id === id ? summary : x))
          : summary.parentSessionId || summary.sideOf
            ? s.list
            : [summary, ...s.list],
      }));
      // Alt ajan izleri (biten koşular oturum dosyasından): panel uygulama yeniden başlasa da dolu.
      if (subagentTraces?.length) useAgents.getState().seed(id, subagentTraces);
      cursors.set(id, { epoch, seq: lastSeq });
      // 1) Snapshot ile açılış çağrısı arasında yayınlanan olaylar (main tamponu),
      // 2) Bekleme kuyruğuna düşen canlı olaylar: ikisi de seq ile süzülüp sırayla uygulanır.
      const queued = openingSessions.get(id) ?? [];
      openingSessions.delete(id);
      // Aynı olay iki yoldan da gelir: main olayı tampona yazıp aynı anda yayınlar, renderer de
      // açılış sürerken yayını kuyruğa alır. Seq'e göre tekilleştirilmezse ikinci kopya "sıra
      // atlandı" sanılıp resnapshot tetikler ve akan turda yeniden açma fırtınası doğar.
      const merged = new Map<number, AgentEvent>();
      for (const event of [...buffered, ...queued]) {
        // Savunma: main zaten filtreliyor; renderer da kendi imlecine göre süzer.
        if (event.seq > lastSeq) merged.set(event.seq, event);
      }
      for (const event of [...merged.values()].sort((a, b) => a.seq - b.seq)) {
        get().applyEvent(event);
      }
      touchRecency(id);
      trimRuntimeCache();
    } catch (error) {
      // Kayıp/geçersiz oturum kimliğinde liste bayat olabilir; tazele ve hatayı çağırana bırak.
      await get()
        .loadList()
        .catch(() => undefined);
      throw error;
    } finally {
      // Bekletme kuyruğunun kalmış olması hata yolu demektir; olayları düşürmek yerine
      // imleci sileriz: sonraki olay gap sayılır ve oturum yeniden açılır.
      openingSessions.delete(id);
    }
  },
  prompt: async (id, text, images) => {
    // Komut kapısı: yerel komutlar (`/model`, `/mod`, `/düşünme`, `/compact`, `/yardım`, …) burada
    // yürür — komut bir istem metni değil **eylemdir**, modele gitmez. Kısayol komutları
    // (`/plan`, `/sor`, `/debug`, `/denetim`) buradan geçer: metin talimata genişleyip modele
    // gider. Depo katmanında olmasının sebebi tek kapı olması: oturum ve asistan ekranları aynı
    // yolu kullanıyor; yakalama ekranlara dağılsaydı biri unutulurdu.
    // Geçersiz argüman hata fırlatır: balon eklenmez, Composer taslağı geri yükler.
    if (await runSlashCommand(text, sessionCommandPorts(id))) return;
    await deliverUserMessage(
      set,
      id,
      text,
      images,
      get().runtime[id]?.status === "working",
      "steer",
    );
  },
  followUp: async (id, text, images) =>
    deliverUserMessage(set, id, text, images, get().runtime[id]?.status === "working", "followUp"),
  clearQueue: async (id) => {
    await invoke("sessions:clearQueue", { id });
  },
  compact: async (id) => {
    const result = await invoke("sessions:compact", { id });
    // Doluluk göstergesi özetten sonra hemen düşsün: motor da `context` olayı yayar ama
    // yanıttaki ölçü elimizde olduğu için bir tur beklemeye gerek yok.
    if (result.ok && result.context) {
      const ctx = result.context;
      set((s) => {
        const rt = s.runtime[id];
        if (!rt) return {};
        return { runtime: { ...s.runtime, [id]: { ...rt, context: ctx } } };
      });
    }
    return result;
  },
  fork: async (id, at) => {
    const summary = await invoke("sessions:fork", { id, ...(at ?? {}) });
    set((s) => ({ list: [summary, ...s.list.filter((x) => x.id !== summary.id)] }));
    return summary.id;
  },
  rewind: async (id, userOrdinal) => {
    const r = await invoke("sessions:rewind", { id, userOrdinal });
    set((s) => {
      const rt = s.runtime[id] ?? emptyRuntime();
      return {
        runtime: {
          ...s.runtime,
          [id]: {
            ...rt,
            transcript: r.transcript,
            context: r.context ?? null,
            ...(r.usage ? { usage: r.usage } : {}),
            lastError: null,
          },
        },
      };
    });
    // Kutuya talimat bloğu değil kullanıcının yazdığı gelir (`/plan istek`, `@/yol`); alıntılar
    // yine alıntı olarak döner.
    return { text: collapsePrompt(r.editorText), quotes: promptQuotes(r.editorText) };
  },
  abort: (id) => invoke("sessions:abort", { id }),
  goal: async (id, action, text, maxIter) => {
    // set: hedef metni kullanıcı balonu olarak da göster; motor Pi'ye kickoff mesajını yazar.
    if (action === "set" && text) {
      set((s) => {
        const rt = s.runtime[id] ?? emptyRuntime();
        return {
          runtime: {
            ...s.runtime,
            [id]: {
              ...rt,
              transcript: [...rt.transcript, { type: "user", id: uid("u"), text, at: Date.now() }],
            },
          },
        };
      });
    }
    await invoke("sessions:goal", {
      id,
      action,
      ...(text ? { text } : {}),
      ...(maxIter ? { maxIter } : {}),
    });
  },
  setPermission: async (id, permission) => {
    set((s) => {
      const rt = s.runtime[id];
      return rt ? { runtime: { ...s.runtime, [id]: { ...rt, permission } } } : {};
    });
    useModels.getState().setPermission(permission);
    await invoke("sessions:setPermission", { id, permission });
  },
  setModel: async (id, model) => {
    set((s) => {
      const rt = s.runtime[id];
      return rt ? { runtime: { ...s.runtime, [id]: { ...rt, model } } } : {};
    });
    useModels.getState().setModel(model);
    await invoke("sessions:setModel", { id, model });
  },
  setThinking: async (id, thinking) => {
    set((s) => {
      const rt = s.runtime[id];
      return rt ? { runtime: { ...s.runtime, [id]: { ...rt, thinking } } } : {};
    });
    useModels.getState().setThinking(thinking);
    await invoke("sessions:setThinking", { id, thinking });
  },
  dismissError: (id) => {
    set((s) => {
      const rt = s.runtime[id];
      return rt ? { runtime: { ...s.runtime, [id]: { ...rt, lastError: null } } } : {};
    });
  },
  respond: async (id, requestId, decision) => {
    await invoke("permissions:respond", { requestId, decision });
    set((s) => {
      const rt = s.runtime[id];
      return rt
        ? {
            runtime: {
              ...s.runtime,
              // Ayrık koşunun kartı ana oturumun durumunu değiştirmez; kendi kartı turu sürdürür.
              [id]: {
                ...rt,
                permissions: rt.permissions.filter((r) => r.requestId !== requestId),
                ...(rt.permissions.some((r) => r.requestId === requestId && !r.run)
                  ? { status: "working" as const }
                  : {}),
              },
            },
          }
        : {};
    });
  },
  respondPlan: async (id, requestId, decision) => {
    await invoke("plans:respond", { requestId, decision });
    set((s) => {
      const rt = s.runtime[id];
      return rt
        ? { runtime: { ...s.runtime, [id]: { ...rt, planReview: null, status: "working" } } }
        : {};
    });
  },
  respondQuestion: async (id, requestId, answers) => {
    await invoke("questions:respond", { requestId, answers });
    set((s) => {
      const rt = s.runtime[id];
      return rt
        ? { runtime: { ...s.runtime, [id]: { ...rt, question: null, status: "working" } } }
        : {};
    });
  },
  respondExtensionUi: async (id, requestId, value) => {
    await invoke("sessions:respondExtensionUi", { sessionId: id, requestId, value });
    set((s) => {
      const rt = s.runtime[id];
      return rt ? { runtime: { ...s.runtime, [id]: { ...rt, extensionUi: null } } } : {};
    });
  },
  rename: async (id, name) => {
    await invoke("sessions:rename", { id, name });
    set((s) => ({ list: s.list.map((x) => (x.id === id ? { ...x, name } : x)) }));
  },
  regenerateTitle: async (id) => {
    const { name } = await invoke("sessions:regenerateTitle", { id });
    set((s) => ({ list: s.list.map((x) => (x.id === id ? { ...x, name } : x)) }));
  },
  setPinned: async (id, pinned) => {
    await invoke("sessions:setPinned", { id, pinned });
    set((s) => ({ list: s.list.map((x) => (x.id === id ? { ...x, pinned } : x)) }));
  },
  setArchived: async (id, archived) => {
    await invoke("sessions:setArchived", { id, archived });
    const leave = archived ? leaveIfActive(get().list, new Set([id])) : undefined;
    set((s) => ({ list: s.list.map((x) => (x.id === id ? { ...x, archived } : x)) }));
    leave?.();
  },
  archiveCwd: async (cwd, mode) => {
    const ids = new Set(
      get()
        // Kenar çubuğu projenin worktree oturumlarını da bu grupta gösterir; birlikte arşivlenir.
        .list.filter(
          (s) => (s.cwd === cwd || worktreeParent(s.cwd) === cwd) && s.mode === mode && !s.archived,
        )
        .map((s) => s.id),
    );
    await Promise.all([...ids].map((id) => invoke("sessions:setArchived", { id, archived: true })));
    const leave = leaveIfActive(get().list, ids);
    set((s) => ({ list: s.list.map((x) => (ids.has(x.id) ? { ...x, archived: true } : x)) }));
    leave();
  },
  purgeArchived: async () => {
    // Silinecek kimlikler önce alınır: yanıt geldikten sonra liste güncellendiği için
    // hangi oturumların izlerinin bırakılacağı bilinemezdi.
    const purged = get()
      .list.filter((x) => x.archived)
      .map((x) => x.id);
    const n = await invoke("sessions:purgeArchived", undefined);
    for (const id of purged) forgetSessionState(id);
    // Kalıcı silinen oturumun transkripti ve okunmamış işareti de bellekten düşer; yalnız
    // listeden çıkarmak runtime'ı uygulama kapanana dek tutuyordu.
    set((s) => ({ list: s.list.filter((x) => !x.archived), ...withoutSessions(s, purged) }));
    return n;
  },
  openSide: async (parentId, quote) => {
    const seedQuote = (id: string) => {
      if (quote) useDrafts.getState().set(id, addQuote(draftFor(id) ?? emptyDraft(), quote));
    };
    const current = get().side[parentId];
    if (current) {
      seedQuote(current.id);
      const entry = { ...current, open: true };
      set((s) => ({ side: { ...s.side, [parentId]: entry } }));
      return entry;
    }
    const summary = await invoke("sessions:side", { id: parentId });
    await get().open(summary.id);
    seedQuote(summary.id);
    const entry: SideChat = {
      id: summary.id,
      base: get().runtime[summary.id]?.transcript.length ?? 0,
      open: true,
    };
    set((s) => ({ side: { ...s.side, [parentId]: entry } }));
    return entry;
  },
  closeSide: (parentId) => {
    const entry = get().side[parentId];
    if (!entry?.open) return;
    set((s) => ({ side: { ...s.side, [parentId]: { ...entry, open: false } } }));
  },
  promoteSide: async (parentId) => {
    const entry = get().side[parentId];
    if (!entry) throw new Error("side chat not open");
    const summary = await invoke("sessions:promoteSide", { id: entry.id });
    set((s) => {
      const side = { ...s.side };
      delete side[parentId];
      return { side, list: [summary, ...s.list.filter((x) => x.id !== summary.id)] };
    });
    // İzin ana oturumunkine döndü: runtime snapshot'tan tazelenir ki çip eski "plan"da kalmasın.
    await get().open(entry.id, true);
    return summary;
  },
  remove: (id) => get().removeMany([id]),
  removeMany: async (ids) => {
    const gone = new Set<string>();
    // Sırayla: her biri kendi IPC çağrısını yapar; biri düşerse öncekiler yine listeden kalkar.
    try {
      for (const id of ids) {
        await invoke("sessions:delete", { id });
        gone.add(id);
      }
    } finally {
      if (gone.size > 0) {
        const leave = leaveIfActive(get().list, gone);
        // Ana oturumla motor yan sohbetini de sildi; panel kaydı ve runtime'ı da düşer.
        const sides = [...gone].flatMap((id) => {
          const side = get().side[id];
          return side ? [side.id] : [];
        });
        for (const id of [...gone, ...sides]) forgetSessionState(id);
        set((s) => {
          const side = { ...s.side };
          for (const id of gone) delete side[id];
          return {
            side,
            list: s.list.filter((x) => !gone.has(x.id)),
            ...withoutSessions(s, [...gone, ...sides]),
          };
        });
        leave();
      }
    }
  },
  applyEvent: (event, span) => {
    // Açılış sürerken gelen olaylar bekletilir: boş runtime'a uygulanıp snapshot ile ezilmesinler.
    const opening = openingSessions.get(event.sessionId);
    if (opening) {
      opening.push(event);
      return;
    }
    // Toplu delta tek olay olarak gelir ama birden çok sırayı kapsar: boşluk denetimi aralığın
    // başına, imleç aralığın sonuna bakar. Son sıraya bakılsaydı her delta yığını "sıra atlandı"
    // sanılıp düşürülür ve akış ekranda hiç görünmezdi (içerik ancak snapshot'tan gelirdi).
    const from = span?.from ?? event.seq;
    const to = span?.to ?? event.seq;
    // Motor yeniden başlamış (epoch değişmiş) ya da sıra atlanmış: yerel durumu bayat sayıp
    // resnapshot isteriz. Olay burada düşer; yeni snapshot sonrası doğru akış kurulur.
    // Zaten uygulanmış sıra (tekrar teslim) boşluk değildir: yeniden açma tetiklemeden yoksayılır.
    const cursor = cursors.get(event.sessionId);
    if (cursor) {
      if (event.epoch !== cursor.epoch || from > cursor.seq + 1) {
        resnapshot(event.sessionId);
        return;
      }
      if (to <= cursor.seq) return;
    }
    // Hiç açılmamış oturumun olayı runtime kurmaz: olaylardan kurulan yarım runtime (transcript'siz,
    // kartsız) `open`ı "zaten açık" sanıp snapshot'ı atlatıyordu; bekleyen izin kartı hiç
    // görünmüyordu. Liste ve okunmamış işareti yine güncellenir, durum açılışta snapshot'tan gelir.
    const known = Boolean(get().runtime[event.sessionId]);
    if (known) cursors.set(event.sessionId, { epoch: event.epoch, seq: to });
    set((s) => {
      const rt = s.runtime[event.sessionId];
      const list =
        event.type === "run_start" || event.type === "run_end"
          ? s.list.map((x) =>
              x.id === event.sessionId
                ? { ...x, live: event.type === "run_start", modifiedAt: event.at }
                : x,
            )
          : s.list;
      // Okunmamış: kullanıcıya görünmeyen sohbette tur bittiğinde yanar, yeni tur başlayınca söner.
      let unread = s.unread;
      if (event.type === "run_start" && s.unread[event.sessionId])
        unread = { ...s.unread, [event.sessionId]: false };
      else if (event.type === "run_end" && event.sessionId !== useApp.getState().activeSessionId)
        unread = { ...s.unread, [event.sessionId]: true };
      if (!rt) return { list, unread };
      return { runtime: { ...s.runtime, [event.sessionId]: reduceEvent(rt, event) }, list, unread };
    });
    // Alt ajan canlı izi ayrı depoda tutulur: hacimli araç akışı transcript indirgeyicisine girmez.
    if (event.type === "subagent_trace")
      useAgents.getState().applyTrace(event.sessionId, event.runId, event.item);
    // Kalıcı hedef bitişi GoalCard üstünden de görülür ama kullanıcı başka sohbette olabilir:
    // kritik geçişler bildirimle de haber verilir.
    if (event.type === "goal") {
      if (event.note === "done") toast.success(i18n.t("goal.doneToast"));
      else if (event.note === "blocked") toast.info(i18n.t("goal.blockedToast"));
      else if (event.note === "max_iter") toast.info(i18n.t("goal.maxIterToast"));
      else if (event.note === "stopped") toast.info(i18n.t("goal.stoppedToast"));
    }
    // Eklenti bildirimleri ve hataları: kart beklemez, sağ altta kısa süreli görünür.
    if (event.type === "extension_notify") {
      toast.info(i18n.t("extensionUi.notify", { message: event.message }));
    } else if (event.type === "extension_error") {
      // `plugin` null ise (ctx.ui köprüsü) mesaj zaten tam cümle; saran kalıp "eklenti eklentisi
      // hata verdi" tekrarını üretirdi.
      toast.error(
        event.plugin === null
          ? event.message
          : i18n.t("extensionUi.error", { plugin: event.plugin, message: event.message }),
      );
    }
  },
}));

/**
 * Açık sohbet `gone` içindeyse ekran silinmiş oturumda "Yükleniyor…" diye takılmasın: aynı
 * bölümdeki komşu sohbete, yoksa ana ekrana geçilir. Komşu değişiklikten önceki listeden
 * seçildiği için hesap önce yapılır, geçiş liste güncellendikten sonra döndürülen işlevle.
 */
function leaveIfActive(list: SessionSummary[], gone: ReadonlySet<string>): () => void {
  const app = useApp.getState();
  const active = app.activeSessionId;
  if (!active || !gone.has(active)) return () => {};
  const next = fallbackSession(list, active, gone);
  return () => {
    // Bu arada kullanıcı başka yere geçtiyse dokunma.
    if (useApp.getState().activeSessionId !== active) return;
    if (next) app.openSession(next.id, next.mode);
    else app.goHome();
  };
}

// Kullanıcı bir sohbeti açtığında okunmuş sayılır.
useApp.subscribe((state) => {
  if (state.activeSessionId) useSessions.getState().markRead(state.activeSessionId);
});

// Metin/düşünme parçaları ağdan sık ve küçük gelir; her birinde store'u güncellemek yerine
// kare başına bir kez birleştirip uygularız. Diğer olaylar sıralamayı korumak için önce kuyruğu boşaltır.
const pendingDeltas: AgentEvent[] = [];
let flushScheduled = false;
function flushDeltas(): void {
  flushScheduled = false;
  if (pendingDeltas.length === 0) return;
  /** Birleşmiş parça ve kapsadığı sıra aralığı; imleç aralığın sonuna taşınır. */
  const batches: Array<{ event: AgentEvent; from: number; to: number }> = [];
  for (const ev of pendingDeltas) {
    const last = batches[batches.length - 1];
    // Kuyruk yalnız metin/düşünme parçası taşır; tür daraltması hem tip hem güvenlik içindir.
    const isDelta = ev.type === "text_delta" || ev.type === "thinking_delta";
    if (last && isDelta && last.event.type === ev.type && last.event.messageId === ev.messageId) {
      // Metin birleşir, diğer alanlar (ör. canlı token sayısı) en güncel olaydan gelir.
      last.event = { ...last.event, ...ev, delta: last.event.delta + ev.delta };
      last.to = ev.seq;
    } else {
      batches.push({ event: ev, from: ev.seq, to: ev.seq });
    }
  }
  pendingDeltas.length = 0;
  const apply = useSessions.getState().applyEvent;
  for (const b of batches) apply(b.event, { from: b.from, to: b.to });
}
on("agent:event", (event) => {
  if (event.type === "text_delta" || event.type === "thinking_delta") {
    pendingDeltas.push(event);
    if (!flushScheduled) {
      flushScheduled = true;
      requestAnimationFrame(flushDeltas);
    }
    return;
  }
  flushDeltas();
  // PRD 11 araç kartı gecikmesi: yalnız ekrandaki oturumun **yeni** satırları ölçülür. Önizlemeden
  // devralan `tool_start` yeni kart açmaz; onu beklemek sahipsiz kayıt bırakırdı.
  if (
    (event.type === "tool_start" || event.type === "tool_preview") &&
    event.sessionId === useApp.getState().activeSessionId &&
    !useSessions
      .getState()
      .runtime[event.sessionId]?.transcript.some((i) => i.id === event.toolCallId)
  )
    toolLatency.expect(event.toolCallId, event.at);
  useSessions.getState().applyEvent(event);
});

// Zamanlanmış görev oturumu da normal sohbet gibi sidebar'da görünür: görev başlarken oturum
// hemen listeye düşsün; bitişte ad/süre bilgisi tazelensin diye listeyi yeniden çekeriz.
on("schedule:started", () => void useSessions.getState().loadList());
on("schedule:ran", () => void useSessions.getState().loadList());
// Otomatik arşiv taraması gibi arayüzün istemediği değişiklikler: listeyi tazele.
on("sessions:changed", () => void useSessions.getState().loadList());
