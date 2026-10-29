import type { BackgroundJob, SubagentKind, SubagentRun, ToolCallItem } from "@codezal/contracts";

export interface AgentJobRow {
  id: string;
  /** Tür: alt ajan türleri ya da arka plan komutu. Satır etiketi buradan çevrilir. */
  kind: SubagentKind | "background";
  label: string;
  status: "queued" | "running" | "done" | "error" | "stopped";
  /** Başlama anı; kuyruktaki alt ajanda henüz yoktur. */
  startedAt?: number;
  endedAt?: number;
  code?: number;
  /** Süren koşunun son etkinliği (araç ya da adım adı). */
  activity?: string;
  /** Alt adım sayısı. */
  steps?: number;
  /** Modelin verdiği görev metni; satır ipucunda görünür. */
  task?: string;
  model?: string;
  thinkingLevel?: string;
  /** Çıktı token'ı ve son penceredeki hızı (tok/s). */
  tokens?: number;
  tokensPerSec?: number;
  cost?: number;
  /** Ayrık ajan koşusu kullanıcıdan onay bekliyor; satırda ayrıca gösterilir. */
  waiting?: boolean;
  /** Worktree koşusu bitti, değişikliği kullanıcının kararını bekliyor ("bitti" değil). */
  reviewing?: boolean;
  /**
   * Seçim kimliği: bellekteki alt ajanda koşu kimliği (canlı iz bu anahtarla bulunur), ayrık
   * koşuda koşunun kendi oturum kimliği (transkript oradan okunur).
   */
  traceId: string;
  /** Canlı izin kaynağı: bellekteki alt ajan, ayrık koşu oturumu ya da arka plan komutu. */
  source: "agent" | "worker" | "background";
  /** Ayrık koşunun kimliği (`agentRuns:*` kanalları); yalnız `worker` kaynağında dolu. */
  runId?: string;
  /**
   * Kapanmış satırın ömrü dolunca listeden düşebilirliği (varsayılan `true`). Kullanıcı kararı
   * bekleyen satır `false` kalır: onu gösteren başka bir yüzey yok, düşerse iş görünmez olur.
   */
  droppable?: boolean;
}

/** Biten satırın listede kaldığı süre: kullanıcı sonucu bir an görsün, sonra kutu toplanır. */
export const DONE_LINGER_MS = 15_000;

/**
 * Ayrık ajan koşusu (arka plan / worktree) satırı için gereken alanlar. Koşu deposunun satır
 * tipiyle yapısal olarak uyumludur; burada bağımsız tanımlanır ki satır üretimi arayüz deposuna
 * bağlanmasın.
 */
export interface WorkerJobInput {
  id: string;
  title: string;
  status: "starting" | "working" | "waiting" | "review" | "done" | "failed" | "cancelled";
  /** Ajan adı: satır etiketi (bellekteki alt ajan satırı gibi); koşu adı görev satırıdır. */
  agent?: string | undefined;
  task?: string | undefined;
  model?: string | undefined;
  thinking?: string | undefined;
  /** Kendi worktree'sinde çalışıyor mu; satır ikonu buna göre dala ayrılır. */
  isolated?: boolean | undefined;
  activity?: string | undefined;
  stepsDone?: number | undefined;
  startedAt?: number | undefined;
  endedAt?: number | undefined;
  /** Koşunun kendi oturum kimliği; panelde canlı transkripti buradan okunur. */
  sessionId?: string | null | undefined;
  usage?: { cost: number; output?: number } | undefined;
}

/** Koşu durumu satır durumuna indirgenir; `waiting` süren bir koşudur, ayrı bayrakla işaretlenir. */
function workerRow(worker: WorkerJobInput): AgentJobRow {
  const status: AgentJobRow["status"] =
    worker.status === "starting"
      ? "queued"
      : worker.status === "working" || worker.status === "waiting"
        ? "running"
        : worker.status === "review" || worker.status === "done"
          ? "done"
          : worker.status === "failed"
            ? "error"
            : "stopped";
  return {
    id: worker.id,
    kind: worker.isolated ? "worker" : "agent",
    // Bellekteki alt ajan satırıyla aynı biçim: etiket ajan adı, görev satırı koşu adı. Ham görev
    // istemi (yol, talimat) satıra ve başlığa taşınınca okunmaz bir paragraf oluyordu.
    label: worker.agent || worker.title,
    status,
    source: "worker",
    traceId: worker.sessionId ?? worker.id,
    runId: worker.id,
    task: worker.title,
    ...(worker.model ? { model: worker.model } : {}),
    ...(worker.thinking ? { thinkingLevel: worker.thinking } : {}),
    ...(worker.usage?.output ? { tokens: worker.usage.output } : {}),
    ...(worker.usage?.cost ? { cost: worker.usage.cost } : {}),
    ...(worker.startedAt === undefined ? {} : { startedAt: worker.startedAt }),
    ...(worker.endedAt === undefined ? {} : { endedAt: worker.endedAt }),
    ...(worker.activity ? { activity: worker.activity } : {}),
    ...(worker.stepsDone === undefined ? {} : { steps: worker.stepsDone }),
    ...(worker.status === "waiting" ? { waiting: true } : {}),
    // `review` bitmiş sayılmaz: koşu bitti ama birleştirme kararı kullanıcıda, satır kalmalı.
    ...(worker.status === "review" ? { droppable: false, reviewing: true } : {}),
  };
}

/** `sessionJobs` seçenekleri: zaman bilmeyen çağıran tüm satırları görür (süzme yapılmaz). */
export interface SessionJobsOptions {
  /** Şu anki zaman (ms); verilirse biten satırların ömrü ölçülür. */
  now?: number;
  /** Biten satırın listede kalma süresi (ms); varsayılan `DONE_LINGER_MS`. */
  doneLingerMs?: number;
}

/**
 * Bitmiş satırın ömrü doldu mu. Süre son görülen zaman üzerinden ölçülür; iki damga da yoksa
 * satır hemen düşer: ömrü ölçülemeyen bitmiş satır listede sonsuza kadar kalamaz.
 */
function expired(row: AgentJobRow, now: number, lingerMs: number): boolean {
  if (row.status === "running" || row.status === "queued") return false;
  if (row.droppable === false) return false;
  const at = row.endedAt ?? row.startedAt;
  return at === undefined || now - at >= lingerMs;
}

/**
 * Satırları sıraya dizer ve ömrü dolan bitmiş satırları düşürür: sürenler üstte başlama sırasıyla,
 * kuyruktakiler altında, bitenler en yeni biten önce. Ajan ve arka plan kartları aynı kuralı
 * paylaşsın diye tek yerde durur.
 */
function orderRows(rows: AgentJobRow[], opts: SessionJobsOptions): AgentJobRow[] {
  const running = rows
    .filter((r) => r.status === "running")
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  const queued = rows.filter((r) => r.status === "queued");
  const done = rows
    .filter((r) => r.status !== "running" && r.status !== "queued")
    .sort((a, b) => (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0));
  const ordered = [...running, ...queued, ...done];
  const { now } = opts;
  if (now === undefined) return ordered;
  const lingerMs = opts.doneLingerMs ?? DONE_LINGER_MS;
  return ordered.filter((r) => !expired(r, now, lingerMs));
}

/**
 * Dar alanda (Ajanlar kutusu) gösterilen kısa başlık: görev metninin başındaki yol gürültüsünü
 * atar ve ilk satırı kelime sınırında kısaltır. Tam görev metni satır ipucunda ve Ajanlar
 * panelinde durur; kutuda yalnız ayırt edici kısa parça kalır.
 */
export function compactLabel(label: string, max = 36, lang: "tr" | "en" = "tr"): string {
  const flat = label.replace(/`/g, "").replace(/\s+/g, " ").trim();
  // "Codezal deposunda (/Users/…/Codezal) …" gibi açılışlar ayırt edici bilgi taşımaz.
  const noise = flat.match(/^[^():]{0,40}\([^()]*(?:\/|\\)[^()]*\)\s*/);
  const stripped = noise ? flat.slice(noise[0].length).trim() : "";
  const text = stripped || flat;
  const head = text.split(" ")[0] ?? "";
  // Baştan kesilen cümle büyük harfle başlasın; kalan yol ile başlıyorsa dokunma.
  const titled =
    stripped && !head.includes("/") && !head.includes("\\")
      ? // Büyütme arayüz diline göre: sabit `"tr"` ile İngilizce arayüzde "insert rows" →
        // "İnsert rows" oluyordu (Türkçe büyütmede `i → İ`).
        `${text.charAt(0).toLocaleUpperCase(lang)}${text.slice(1)}`
      : text;
  if (titled.length <= max) return titled;
  const cut = titled.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return `${(at > 10 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

/**
 * Alt ajan koşusunu satıra çevirir. Tüm yerli alt ajanlar (keşif, denetim, inceleme) artık
 * `subagents` snapshot'ıyla gelir; transcript'teki araç kartı ayrıca satır üretmez, yoksa aynı
 * iş iki kez görünürdü.
 */
function runRow(run: SubagentRun): AgentJobRow {
  return {
    id: run.id,
    kind: run.kind,
    label: run.label,
    status: run.status,
    source: "agent",
    traceId: run.id,
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
    ...(run.activity ? { activity: run.activity } : {}),
    ...(run.steps === undefined ? {} : { steps: run.steps }),
    ...(run.task ? { task: run.task } : {}),
    ...(run.model ? { model: run.model } : {}),
    ...(run.thinkingLevel ? { thinkingLevel: run.thinkingLevel } : {}),
    ...(run.tokens === undefined ? {} : { tokens: run.tokens }),
    ...(run.tokensPerSec === undefined ? {} : { tokensPerSec: run.tokensPerSec }),
    ...(run.usage?.cost ? { cost: run.usage.cost } : {}),
  };
}

/**
 * Ajanlar kartının ve panelinin satırları: bellekteki alt ajanlar `subagents` snapshot'ından,
 * ayrık koşular (arka plan / worktree) koşu deposundan beslenir. Arka plan komutları ayrı kartta
 * (`backgroundJobs`) listelenir.
 */
export function sessionJobs(
  subagents: SubagentRun[] = [],
  workers: WorkerJobInput[] = [],
  opts: SessionJobsOptions = {},
): AgentJobRow[] {
  return orderRows([...subagents.map(runRow), ...workers.map(workerRow)], opts);
}

/** Komutun tek satırlık hâli: satır sonları ve art arda boşluklar tek boşluğa iner. */
export function commandLine(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

/**
 * Arka plan (bash_background) kartının satırları. Ajan değillerdir: uzun süren bir sunucu da
 * olabilirler, bu yüzden ayrı kartta listelenir ve "çalışıyor" sayacına ajanlar karışmaz.
 */
export function backgroundJobs(
  backgrounds: BackgroundJob[],
  opts: SessionJobsOptions = {},
): AgentJobRow[] {
  const rows: AgentJobRow[] = backgrounds.map((b) => ({
    id: b.id,
    kind: "background",
    // Başlık modelin kısa açıklamasıdır (Claude'daki gibi); açıklamasız komutta komutun ilk
    // satırı. Tam komut `task`ta durur: ipucu ve ayrıntı balonu onu gösterir.
    label: b.description || commandLine(b.command),
    task: b.command,
    status: b.status === "exited" ? "done" : b.status,
    startedAt: b.startedAt,
    source: "background",
    traceId: b.id,
    ...(b.endedAt !== undefined ? { endedAt: b.endedAt } : {}),
    ...(b.code !== undefined ? { code: b.code } : {}),
  }));
  return orderRows(rows, opts);
}

/**
 * Araç çağrısı bir arka plan komutu başlattı mı: `bash_background start` ya da ön plan penceresini
 * (90 sn) aşıp arka plana alınan `bash`. İkincisi yalnız çıktısındaki bildirimden tanınır; bildirim
 * iki dilde de `bash_background output bg-N` ile biter.
 */
export function isBackgroundLaunch(item: ToolCallItem): boolean {
  if (item.toolName === "bash_background") return item.kind === "terminal";
  return item.toolName === "bash" && /bash_background output bg-\d+/.test(item.output ?? "");
}
