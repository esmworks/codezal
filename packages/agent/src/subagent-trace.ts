import {
  type SubagentKind,
  SubagentRun,
  type SubagentRunStatus,
  type SubagentTrace,
  type ToolCallItem,
  TranscriptItem,
  type Usage,
} from "@codezal/contracts";
import type { Locale } from "@codezal/i18n";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentEventBus } from "./event-bus.js";
import {
  outputOfResult,
  outputOfTool,
  resolvedTargetOf,
  type ToolStop,
  textOf,
  toUsage,
} from "./mapping.js";
import { describeTool } from "./tool-info.js";

/** Tek iz öğesinde taşınan çıktı üst sınırı (karakter); panel özet gösterir, tam metin değil. */
export const TRACE_OUTPUT_MAX = 4_000;
/**
 * Bir oturumda tutulan bitmiş koşu üst sınırı. Uzun oturumda koşu listesi sınırsız büyümesin;
 * süren koşulara dokunulmaz, en eski bitenler düşer (arayüz bitenleri ayrıca temizler).
 */
export const MAX_FINISHED_RUNS = 20;
/** Araç kısmi çıktısı en çok bu aralıkla yayınlanır; aksi halde IPC delta seliyle boğulur. */
export const TOOL_UPDATE_MIN_MS = 200;
/** Çıktı hızının ölçüldüğü kayan pencere. */
export const RATE_WINDOW_MS = 5_000;
/** Süren koşuda bellekte tutulan iz öğesi üst sınırı (renderer'ın `AGENT_TRACE_MAX` ile aynı). */
export const TRACE_LIVE_MAX = 300;
/**
 * Biten koşunun saklanan izi: son bu kadar öğe, öğe başına bu kadar karakter. Pi oturum
 * dosyasını açılışta bütünüyle okur; 20 koşu × 300 öğe × 4 KB dosyayı şişirirdi.
 */
export const TRACE_KEEP_ITEMS = 200;
export const TRACE_KEEP_CHARS = 1_500;
/** Biten koşunun oturum dosyasındaki kaydı (`appendCustomEntry`; modele gitmez). */
export const SUBAGENT_RUN_TYPE = "codezal-subagent-run";
/**
 * Kaydedilmeyen koşu türleri: keşif ve denetim avcı/doğrulayıcıları. Salt-okunur, tek
 * kullanımlıktır; bir denetim onlarca koşu açar ve her kayıt oturum dosyasını büyütür (Pi dosyayı
 * açılışta bütünüyle okur). Eski sürümün yazdığı bu türden kayıtlar da yüklenmez.
 */
export const UNSAVED_KINDS: ReadonlySet<SubagentKind> = new Set([
  "explore",
  "audit-hunter",
  "audit-verifier",
]);

/** Oturum kaydı: koşu başlığı ve sıkıştırılmış izi. */
export interface SubagentRecord {
  run: SubagentRun;
  items: TranscriptItem[];
}

/** İzleyicinin motordan aldığı bağlar. */
export interface TrackerHooks {
  /**
   * Hiç çalışmadan durdurulan çağrının nedeni (plan engeli / hook reddi). Alt ajanın izin kapısı ve
   * hook'ları işareti ana oturum kimliğiyle bırakır; kart "hata" yerine "engellendi"/"reddedildi"
   * çizilsin diye bitişte bir kez sorulur (işaret tüketilir).
   */
  stopOf?: (toolCallId: string) => ToolStop | undefined;
  /** Koşu bitti: motor kaydı ana oturumun dosyasına yazar. */
  onFinish?: (record: SubagentRecord) => void;
}

/** Saklanacak iz: son öğeler, uzun çıktı ve metin kırpılmış. */
export function compactTrace(items: readonly TranscriptItem[]): TranscriptItem[] {
  return items.slice(-TRACE_KEEP_ITEMS).map((item) => {
    if (item.type === "tool" && item.output !== undefined)
      return { ...item, output: clipTrace(item.output, TRACE_KEEP_CHARS) };
    if (item.type === "assistant") return { ...item, text: clipTrace(item.text, TRACE_KEEP_CHARS) };
    return item;
  });
}

/**
 * Oturum kayıtlarından biten alt ajan koşuları (eskiden yeniye). Şemaya uymayan kayıt atlanır:
 * bozuk ya da eski biçimli bir kayıt oturumu açılmaz hâle getirmemeli.
 */
export function subagentRecordsOf(entries: readonly unknown[]): SubagentRecord[] {
  const out: SubagentRecord[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (e.type !== "custom" || e.customType !== SUBAGENT_RUN_TYPE) continue;
    const data = (typeof e.data === "object" && e.data !== null ? e.data : {}) as {
      run?: unknown;
      items?: unknown;
    };
    const run = SubagentRun.safeParse(data.run);
    if (!run.success || run.data.status === "running" || run.data.status === "queued") continue;
    if (UNSAVED_KINDS.has(run.data.kind)) continue;
    const items = Array.isArray(data.items)
      ? data.items.flatMap((raw) => {
          const parsed = TranscriptItem.safeParse(raw);
          return parsed.success ? [parsed.data] : [];
        })
      : [];
    out.push({ run: run.data, items });
  }
  return out;
}

/** Alt ajan başlangıç bilgisi: kim, hangi etiketle, hangi ana araç çağrısına bağlı. */
export interface SubagentStart {
  kind: SubagentKind;
  label: string;
  /** Modelin verdiği görev metni; panel başlığında ve araç kartı ipucunda görünür. */
  task?: string;
  /** Ana transcript'teki araç çağrısı kimliği; karttan alt ajan sekmesine geçişi kurar. */
  parentToolCallId?: string;
  model?: string;
  thinkingLevel?: string;
}

/** İzlenecek oturumun ihtiyaç duyduğumuz yüzü (Pi `AgentSession` yapısal olarak uyar). */
export interface WatchableSession {
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
}

interface InternalRun {
  id: string;
  kind: SubagentKind;
  label: string;
  task?: string;
  parentToolCallId?: string;
  model?: string;
  thinkingLevel?: string;
  status: SubagentRunStatus;
  startedAt: number;
  endedAt?: number;
  activity?: string;
  steps: number;
  usage: Usage;
  /** Son penceredeki çıktı token örnekleri (hız hesabı). */
  samples: { at: number; output: number }[];
  tokensPerSec?: number;
  /** Açık araç öğeleri: kısmi çıktı ve bitiş güncellemesi tam öğeyi yeniden yaymak için gerekir. */
  items: Map<string, ToolCallItem>;
  /**
   * Koşunun izi (yayınlanan öğelerin son hâli). Oturum yeniden açılınca panel bununla dolar;
   * koşu bitince sıkıştırılır ve kaydedilir.
   */
  trace: TranscriptItem[];
  /** `write` çağrılarının argümanları; sonuçta diff yoksa içerikten sentezlenir. */
  toolArgs: Map<string, Record<string, unknown>>;
  lastUpdateAt: Map<string, number>;
}

const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

const addUsage = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  cost: a.cost + b.cost,
});

/** Uzun çıktıyı kırpar; kırpma olduysa sonuna işaret koyar. */
export function clipTrace(text: string, max = TRACE_OUTPUT_MAX): string {
  return text.length > max ? `${text.slice(0, max)}\n[…]` : text;
}

/**
 * Alt ajan izleyicisi: alt oturumun Pi olaylarını ana oturumun transcript öğelerine çevirip
 * `subagent_trace` olarak yayar, koşu başlığını `subagents` snapshot'ıyla günceller.
 *
 * Neden motorun içinde: Pi SDK bilgisi `packages/agent` dışına çıkmaz (AGENTS.md); arayüz yalnız
 * normalize olayları görür. Alt ajanlar bellekte ayrı oturumlarda çalıştığı için araç akışları
 * normalde ana transcript'e karışmaz — bu sınıf onları ayrı bir kanala taşır.
 */
export class SubagentTracker {
  readonly #bus: AgentEventBus;
  readonly #sessionId: string;
  readonly #lang: Locale;
  readonly #now: () => number;
  readonly #hooks: TrackerHooks;
  readonly #runs = new Map<string, InternalRun>();
  #seq = 0;

  constructor(
    bus: AgentEventBus,
    sessionId: string,
    lang: Locale = "tr",
    now: () => number = Date.now,
    hooks: TrackerHooks = {},
  ) {
    this.#bus = bus;
    this.#sessionId = sessionId;
    this.#lang = lang;
    this.#now = now;
    this.#hooks = hooks;
  }

  /** Yeni alt ajan koşusu açar; koşu başlığı hemen yayınlanır. */
  begin(start: SubagentStart): SubagentHandle {
    // Sayaç süreçle sıfırlanır; oturum dosyasından yüklenen koşunun kimliğiyle çakışma olmasın.
    let id = "";
    do id = `sub-${this.#now().toString(36)}-${(++this.#seq).toString(36)}`;
    while (this.#runs.has(id));
    const run: InternalRun = {
      id,
      kind: start.kind,
      label: start.label,
      status: "running",
      startedAt: this.#now(),
      steps: 0,
      usage: emptyUsage(),
      samples: [],
      items: new Map(),
      trace: [],
      toolArgs: new Map(),
      lastUpdateAt: new Map(),
      ...(start.task ? { task: start.task } : {}),
      ...(start.parentToolCallId ? { parentToolCallId: start.parentToolCallId } : {}),
      ...(start.model ? { model: start.model } : {}),
      ...(start.thinkingLevel ? { thinkingLevel: start.thinkingLevel } : {}),
    };
    this.#pruneFinished();
    this.#runs.set(id, run);
    this.publish();
    return new SubagentHandle(this, run);
  }

  get size(): number {
    return this.#runs.size;
  }

  /** Bitmiş koşuları sınırlar: uzun oturumda liste birikmesin, sürenler her zaman kalır. */
  #pruneFinished(): void {
    const finished = [...this.#runs.values()].filter((run) => run.status !== "running");
    if (finished.length < MAX_FINISHED_RUNS) return;
    finished.sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
    for (const run of finished.slice(0, finished.length - MAX_FINISHED_RUNS + 1)) {
      this.#runs.delete(run.id);
    }
  }

  /** Koşu başlıklarının anlık görüntüsü (başlama sırasına göre). */
  get runs(): SubagentRun[] {
    return [...this.#runs.values()].map((run) => this.#snapshot(run));
  }

  /** Koşuların izleri (oturum açılışı); süren koşuda canlı, bitende sıkıştırılmış hâl. */
  traces(): SubagentTrace[] {
    return [...this.#runs.values()].map((run) => ({ runId: run.id, items: run.trace.slice() }));
  }

  /**
   * Oturum dosyasından gelen biten koşuları yükler. Yalnız bellekte olmayanlar eklenir; böylece
   * açılıştan sonra başlayan koşunun `subagents` yayını (yerine koyma semantiği) eskileri silmez.
   */
  restore(records: readonly SubagentRecord[]): void {
    for (const { run, items } of records.slice(-MAX_FINISHED_RUNS)) {
      if (this.#runs.has(run.id)) continue;
      const startedAt = run.startedAt ?? run.endedAt ?? 0;
      this.#runs.set(run.id, {
        id: run.id,
        kind: run.kind,
        label: run.label,
        status: run.status,
        startedAt,
        steps: run.steps ?? 0,
        usage: run.usage ?? emptyUsage(),
        samples: [],
        items: new Map(),
        trace: items.slice(),
        toolArgs: new Map(),
        lastUpdateAt: new Map(),
        ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
        ...(run.task ? { task: run.task } : {}),
        ...(run.parentToolCallId ? { parentToolCallId: run.parentToolCallId } : {}),
        ...(run.model ? { model: run.model } : {}),
        ...(run.thinkingLevel ? { thinkingLevel: run.thinkingLevel } : {}),
      });
    }
  }

  /** Geri sarma: kesme noktasından sonra başlamış biten koşular düşer (o dal artık yok). */
  dropAfter(cutoff: number): void {
    let changed = false;
    for (const [id, run] of this.#runs) {
      if (run.status === "running" || run.startedAt <= cutoff) continue;
      this.#runs.delete(id);
      changed = true;
    }
    if (changed) this.publish();
  }

  /** Alt ajan durumunu yayınlar (replace semantiği); iç kullanım. */
  publish(): void {
    this.#bus.emit({
      type: "subagents",
      sessionId: this.#sessionId,
      at: this.#now(),
      runs: this.runs,
    });
  }

  /** Tek iz öğesi yayınlar ve koşunun izine işler (aynı kimlik güncellenir); iç kullanım. */
  emitItem(runId: string, item: TranscriptItem): void {
    const run = this.#runs.get(runId);
    if (run) {
      const idx = run.trace.findIndex((i) => i.id === item.id);
      if (idx >= 0) run.trace[idx] = item;
      else {
        run.trace.push(item);
        if (run.trace.length > TRACE_LIVE_MAX)
          run.trace.splice(0, run.trace.length - TRACE_LIVE_MAX);
      }
    }
    this.#bus.emit({
      type: "subagent_trace",
      sessionId: this.#sessionId,
      at: this.#now(),
      runId,
      item,
    });
  }

  /** Koşuyu kapatır ve son durumu yayınlar. */
  end(runId: string, status: Exclude<SubagentRunStatus, "queued">): void {
    const run = this.#runs.get(runId);
    if (run?.status !== "running") return;
    run.status = status;
    run.endedAt = this.#now();
    run.trace = compactTrace(run.trace);
    this.publish();
    if (UNSAVED_KINDS.has(run.kind)) return;
    // Hız ölçüsü anlık bir değer: kayıtta anlamı yok.
    const { tokensPerSec: _rate, ...snapshot } = this.#snapshot(run);
    this.#hooks.onFinish?.({ run: snapshot, items: run.trace });
  }

  /** Koşuya canlı etkinlik metni yazar (araç akışı olmayan adımlar için). İç kullanım. */
  setActivity(runId: string, text: string): void {
    const run = this.#runs.get(runId);
    if (!run) return;
    run.activity = text.slice(0, 160);
    this.publish();
  }

  #snapshot(run: InternalRun): SubagentRun {
    return {
      id: run.id,
      label: run.label,
      kind: run.kind,
      status: run.status,
      startedAt: run.startedAt,
      steps: run.steps,
      ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
      ...(run.activity ? { activity: run.activity } : {}),
      ...(run.task ? { task: run.task } : {}),
      ...(run.parentToolCallId ? { parentToolCallId: run.parentToolCallId } : {}),
      ...(run.model ? { model: run.model } : {}),
      ...(run.thinkingLevel ? { thinkingLevel: run.thinkingLevel } : {}),
      ...(run.usage.output > 0
        ? {
            usage: run.usage,
            tokens: run.usage.output,
            ...(run.tokensPerSec === undefined ? {} : { tokensPerSec: run.tokensPerSec }),
          }
        : {}),
    };
  }

  /** @internal Alt ajan olayını işler. */
  handleEvent(runId: string, event: AgentSessionEvent): void {
    const run = this.#runs.get(runId);
    if (run?.status !== "running") return;
    switch (event.type) {
      case "tool_execution_start": {
        const args = (event.args ?? {}) as Record<string, unknown>;
        const info = describeTool(event.toolName, args, this.#lang);
        if (event.toolName === "write") run.toolArgs.set(event.toolCallId, args);
        run.steps += 1;
        const item: ToolCallItem = {
          type: "tool",
          id: event.toolCallId,
          toolName: event.toolName,
          kind: info.kind,
          status: "running",
          title: info.title,
          startedAt: this.#now(),
          ...(info.target ? { target: info.target } : {}),
          ...(info.command ? { command: info.command } : {}),
        };
        run.items.set(event.toolCallId, item);
        run.activity = info.target ? `${info.title} · ${info.target}` : info.title;
        this.emitItem(runId, item);
        this.publish();
        break;
      }
      case "tool_execution_update": {
        const item = run.items.get(event.toolCallId);
        if (!item) return;
        const output = outputOfResult(event.partialResult);
        if (!output) return;
        const at = this.#now();
        const last = run.lastUpdateAt.get(event.toolCallId) ?? 0;
        if (at - last < TOOL_UPDATE_MIN_MS) return;
        run.lastUpdateAt.set(event.toolCallId, at);
        const next: ToolCallItem = { ...item, output: clipTrace(output) };
        run.items.set(event.toolCallId, next);
        this.emitItem(runId, next);
        break;
      }
      case "tool_execution_end": {
        const item = run.items.get(event.toolCallId);
        if (!item) return;
        const output = outputOfTool(
          event.toolName,
          run.toolArgs.get(event.toolCallId),
          event.result,
          event.isError,
        );
        const target = resolvedTargetOf(event.toolName, event.result, event.isError);
        const stop = event.isError ? this.#hooks.stopOf?.(event.toolCallId) : undefined;
        const next: ToolCallItem = {
          ...item,
          status: stop ?? (event.isError ? "error" : "done"),
          endedAt: this.#now(),
          ...(output ? { output: clipTrace(output) } : {}),
          ...(target ? { target } : {}),
        };
        run.items.delete(event.toolCallId);
        run.toolArgs.delete(event.toolCallId);
        run.lastUpdateAt.delete(event.toolCallId);
        this.emitItem(runId, next);
        break;
      }
      case "message_end": {
        if (event.message.role !== "assistant") return;
        const message = event.message as AssistantMessage;
        // Model bilgisi ilk mesajla kesinleşir; alt oturum ana oturumun modelini devralır.
        if (message.model) run.model = message.model;
        const usage = toUsage(message.usage);
        run.usage = addUsage(run.usage, usage);
        run.samples.push({ at: this.#now(), output: usage.output });
        this.#refreshRate(run);
        const text = textOf(message.content).trim();
        if (text) {
          this.emitItem(runId, {
            type: "assistant",
            id: `msg-${run.id}-${run.samples.length}`,
            text: clipTrace(text),
            streaming: false,
            at: this.#now(),
            ...(message.model ? { model: message.model } : {}),
            ...(message.provider ? { provider: message.provider } : {}),
          });
        }
        this.publish();
        break;
      }
      default:
        break;
    }
  }

  /** Kayan penceredeki çıktı token'ından saniyelik hızı hesaplar. */
  #refreshRate(run: InternalRun): void {
    const cutoff = this.#now() - RATE_WINDOW_MS;
    run.samples = run.samples.filter((s) => s.at >= cutoff);
    const first = run.samples[0];
    if (!first || run.samples.length < 2) {
      delete run.tokensPerSec;
      return;
    }
    const span = Math.max(1, this.#now() - first.at) / 1000;
    const output = run.samples.reduce((sum, s) => sum + s.output, 0);
    run.tokensPerSec = Math.round(output / span);
  }
}

/** Tek bir alt ajan koşusunun tutamacı: oturumu izler, aktivite yazar, kapatır. */
export class SubagentHandle {
  readonly id: string;
  readonly #tracker: SubagentTracker;
  readonly #unsubscribers: (() => void)[] = [];

  constructor(tracker: SubagentTracker, run: { id: string }) {
    this.#tracker = tracker;
    this.id = run.id;
  }

  /** Alt oturumu izlemeye bağlar; dönen fonksiyon aboneliği kaldırır. */
  watch(session: WatchableSession): () => void {
    const off = session.subscribe((event) => this.#tracker.handleEvent(this.id, event));
    this.#unsubscribers.push(off);
    return off;
  }

  /** Tek bir ham oturum olayını işler (abonelik dışarıda kurulduysa; motor tek aboneliği korur). */
  process(event: AgentSessionEvent): void {
    this.#tracker.handleEvent(this.id, event);
  }

  /** Araç akışı dışındaki ilerleme notu (ör. onarım turu başlıyor). */
  activity(text: string): void {
    this.#tracker.setActivity(this.id, text);
  }

  /** Koşuyu kapatır (done/error/stopped) ve son durumu yayınlar. */
  end(status: Exclude<SubagentRunStatus, "queued"> = "done"): void {
    for (const off of this.#unsubscribers) {
      try {
        off();
      } catch {
        // Abonelik kaldırma hatası koşu kapanışını engellemesin.
      }
    }
    this.#unsubscribers.length = 0;
    this.#tracker.end(this.id, status);
  }
}
