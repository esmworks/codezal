import { readFileSync } from "node:fs";
import {
  AppMode,
  GoalState,
  MarkerKind,
  PermissionMode,
  ThinkingLevel,
  WorkerInfo,
} from "@codezal/contracts";
import { z } from "zod";
import { writeFileAtomic } from "./fsx.js";

const Goal = GoalState.extend({
  /** Oluşturma zamanı; GoalState'te taşınmaz, meta.json'da kalır. */
  createdAt: z.number(),
});

/**
 * Oturumda yerel komutların bıraktığı işaret (sohbetteki ayraç satırı). Pi'nin oturum dosyası bu
 * komutları görmediği için (modele hiç gitmezler) işaret burada saklanır; oturum yeniden açılınca
 * transkripte zaman sırasına karıştırılır.
 */
const Mark = z.object({
  id: z.string(),
  kind: MarkerKind,
  from: z.string().optional(),
  to: z.string().optional(),
  outcome: z.enum(["done", "noop", "failed"]).optional(),
  at: z.number(),
});
export type SessionMark = z.infer<typeof Mark>;

/**
 * Oturum başına saklanan işaret sayısı. Sınırsız büyüme `meta.json`'ı şişirir ve oturum açılışını
 * yavaşlatır; eski işaretler düşer (sohbet kaydının kendisi Pi dosyasında zaten duruyor).
 */
export const MAX_SESSION_MARKS = 200;

const Meta = z.object({
  /**
   * `catch`: kaldırılan modu (eski `design`) taşıyan kayıt **bütün meta dosyasını** düşürmesin;
   * tanınmayan değer kodlama'ya kırpılır, eski oturum listelenmez (aşağıdaki göç arşive alır).
   */
  mode: AppMode.catch("kodlama").default("kodlama"),
  permission: PermissionMode.default("ask"),
  /**
   * Oturumun düşünme seviyesi. Pi bunu oturum dosyasında tutmaz (`SessionManager.open`
   * `thinkingLevel` döndürmez), bu yüzden yeniden açılışta seviye buradan verilir.
   */
  thinking: ThinkingLevel.optional(),
  pinned: z.boolean().default(false),
  archived: z.boolean().default(false),
  projectId: z.string().nullable().default(null),
  goal: Goal.optional(),
  /**
   * Yerel komut işaretleri (eskiden yeniye); açılışta transkripte karıştırılır.
   * `catch([])`: tanımadığımız bir işaret türü (yeni sürümün yazdığı kayıt) ya da bozuk satır
   * yüzünden **bütün meta dosyası** düşmesin — aksi hâlde mod/izin/seviye/hedef de kaybolurdu.
   */
  marks: z.array(Mark).catch([]).default([]),
  /** Oturum bir güvenlik denetimi run'ına bağlıysa yalnızca kimliği; run durumu audits/ altındadır. */
  audit: z.object({ runId: z.string().min(1) }).optional(),
  /** Oturum bir ajan koşusunun oturumuysa onu başlatan ana oturum; kenar çubuğu bunları gizler. */
  parentSessionId: z.string().nullable().catch(null).default(null),
  /** Yan sohbetse açıldığı ana oturum; kenar çubuğu gizler, açılışta artakalanlar silinir. */
  sideOf: z.string().nullable().catch(null).default(null),
  /**
   * Bu oturumun başlattığı ayrık ajan koşuları (arka plan / worktree). `catch([])`: şeması eski
   * bir kayıt bütün meta dosyasını düşürmesin; en kötü koşu geçmişi kaybolur.
   */
  agentRuns: z.array(WorkerInfo).catch([]).default([]),
});
export type SessionMeta = z.infer<typeof Meta>;

const File = z.object({ sessions: z.record(z.string(), Meta).default({}) });

/** Modülü kaldırılan modlar: kayıtları kodlama'ya çevrilip arşive alınır (sohbet dosyası silinmez). */
const REMOVED_MODES = new Set(["design"]);

/** Pi'nin JSONL dosyasında olmayan oturum bilgileri: mod, izin modu, düşünme seviyesi, sabitleme. */
export class SessionMetaStore {
  readonly #path: string;
  #data: Record<string, SessionMeta> = {};

  constructor(path: string) {
    this.#path = path;
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(path, "utf8"));
      this.#data = File.parse(json).sessions;
    } catch {
      // Bozuk ya da okunamayan kayıt: boş başla. Göç yazımı aşağıda, bu blok **dışında** yapılır;
      // aksi halde diske yazma hatası veriyi sıfırlayıp dosyayı da silerdi.
      this.#data = {};
      return;
    }
    try {
      if (this.#archiveRemovedModes(json)) this.#flush();
    } catch {
      // Okuma başarılı: göç yazımı başarısız olsa da bellekteki kayıtlar korunur.
    }
  }

  get(id: string): SessionMeta {
    return this.#data[id] ?? Meta.parse({});
  }

  set(id: string, patch: Partial<SessionMeta>): SessionMeta {
    const next = { ...this.get(id), ...patch };
    this.#data[id] = next;
    this.#flush();
    return next;
  }

  /**
   * Yerel komut işaretini ekler. Sıra korunur (eskiden yeniye) ve liste baştan kırpılır: kırpma
   * sınırı aşan işaretler en eski olanlardır, yeni işaret her zaman görünür kalır.
   */
  mark(id: string, mark: SessionMark): SessionMeta {
    const marks = [...this.get(id).marks, mark];
    return this.set(id, {
      marks: marks.length > MAX_SESSION_MARKS ? marks.slice(-MAX_SESSION_MARKS) : marks,
    });
  }

  /** Koşu kaydı olan ana oturumlar; açılışta `AgentRunManager` bununla dolar. */
  agentRuns(): Map<string, WorkerInfo[]> {
    const out = new Map<string, WorkerInfo[]>();
    for (const [id, meta] of Object.entries(this.#data)) {
      if (meta.agentRuns.length > 0) out.set(id, meta.agentRuns);
    }
    return out;
  }

  /** Koşu kaydını yazar; kaydı olmayan oturuma boş liste yazmak meta satırı açmaz. */
  setAgentRuns(id: string, runs: WorkerInfo[]): void {
    if (runs.length === 0 && !this.#data[id]) return;
    this.set(id, { agentRuns: runs });
  }

  all(): Record<string, SessionMeta> {
    return this.#data;
  }

  /**
   * Kaldırılan modu (eski design) taşıyan kayıtları bir kez göç ettirir: mod kodlama'ya kırpılır ve
   * oturum arşive alınır, yani kenar çubuğunda ve aramada görünmez (Ayarlar → Arşiv'de durur).
   * Ham JSON'a bakılır çünkü `Meta` tanınmayan modu kodlama'ya indirir ve iz kaybolur.
   */
  #archiveRemovedModes(json: unknown): boolean {
    const raw = (json as { sessions?: Record<string, { mode?: unknown }> } | null)?.sessions;
    if (!raw || typeof raw !== "object") return false;
    let changed = false;
    for (const [id, entry] of Object.entries(raw)) {
      if (!entry || typeof entry !== "object") continue;
      if (!REMOVED_MODES.has(String(entry.mode))) continue;
      const meta = this.#data[id];
      if (!meta) continue;
      this.#data[id] = { ...meta, mode: "kodlama", archived: true };
      changed = true;
    }
    return changed;
  }

  delete(id: string): void {
    delete this.#data[id];
    this.#flush();
  }

  #flush(): void {
    // Atomik yazım: yarım kalmış meta.json açılışta okunamayınca bütün oturumların modu, izni ve
    // işaretleri kayboluyordu.
    writeFileAtomic(this.#path, JSON.stringify({ sessions: this.#data }, null, 2));
  }
}
