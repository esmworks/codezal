import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import type { ApiKeySlot } from "@codezal/contracts";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { z } from "zod";
import {
  getConfigValueEnvVarNames,
  getMissingConfigValueEnvVarNames,
  isCommandConfigValue,
  resolveConfigValue,
} from "./config-value.js";
import { writeFileAtomic } from "./fsx.js";

/**
 * Sağlayıcı başına birden fazla kimlik tutan Pi `CredentialStore` uygulaması (`keys.json`).
 * Pi her istekte `read()` çağırdığı için limiti dolan yuvayı soğumaya almak rotasyon için yeterlidir.
 * Yuva sırası önceliktir; soğuması geçmiş ilk yuva aktiftir.
 */

function isCredential(value: unknown): value is Credential {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === "api_key" || type === "oauth";
}

const SlotSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  credential: z.custom<Credential>(isCredential),
  addedAt: z.number(),
  cooldownUntil: z.number().optional(),
});
type Slot = z.infer<typeof SlotSchema>;

const PoolFile = z.object({
  version: z.literal(1),
  providers: z.record(z.string(), z.object({ slots: z.array(SlotSchema) })),
});
type PoolFile = z.infer<typeof PoolFile>;

/** Pi'nin auth.json biçimi: sağlayıcı → tek kimlik. */
const LegacyAuthFile = z.record(z.string(), z.custom<Credential>(isCredential));

export interface SlotRef {
  id: string;
  label?: string;
  hint: string;
}

export interface RotationResult {
  from: SlotRef;
  /** Yeni aktif yuva; tüm yuvalar soğumadaysa null. */
  to: SlotRef | null;
  cooldownUntil: number;
}

/**
 * Aynı sağlayıcıda aynı anda gelen hatalar (eşzamanlı oturumlar) yeni aktif yuvayı hemen soğutmasın.
 * Pi'nin yeniden denemesi en erken 1 sn sonra geldiği için bu pencere ondan kısa tutulur.
 */
const ROTATION_DEBOUNCE_MS = 750;

/**
 * Değer referans mı, düz anahtar mı. Pi sentaksı: `!komut` komut, `$VAR`/`${VAR}` şablon,
 * aksi hâlde literal. Şablonda env adı yoksa (`a$` gibi) değer literal sayılır.
 */
function kindOf(credential: Credential): "key" | "env" | "command" {
  if (credential.type !== "api_key" || !credential.key) return "key";
  if (isCommandConfigValue(credential.key)) return "command";
  return getConfigValueEnvVarNames(credential.key).length > 0 ? "env" : "key";
}

function hintOf(credential: Credential): string {
  // Referanslı değerde son 4 hane anlamsız: `····ault` gibi gösterim yanıltıcı olur.
  if (kindOf(credential) !== "key" || credential.type !== "api_key" || !credential.key) return "";
  return credential.key.length > 4 ? credential.key.slice(-4) : "";
}

function refOf(slot: Slot): SlotRef {
  const ref: SlotRef = { id: slot.id, hint: hintOf(slot.credential) };
  if (slot.label) ref.label = slot.label;
  return ref;
}

export class CredentialPool implements CredentialStore {
  readonly #path: string;
  /** Pi'nin `auth.json` yolu: göç kaynağı ve havuzun aynalandığı hedef. */
  readonly #authPath: string | undefined;
  readonly #now: () => number;
  #file: PoolFile;
  /** Son okunan/yazılan dosya damgası (mtime:boyut); dışarıdan düzenlenirse yeniden okunur. */
  #stamp: string | undefined;
  /** Sağlayıcı başına yazma zinciri: `modify`/`delete` serileşir. */
  readonly #chains = new Map<string, Promise<unknown>>();
  /** `read()` ile son sunulan yuva; başarılı yanıtta soğuması temizlenir. */
  readonly #lastServed = new Map<string, string>();
  /** `add()` bıraktığı etiket; Pi `login` → `modify` ile eklenen yuvaya uygulanır. */
  readonly #pendingLabel = new Map<string, string>();
  readonly #rotatedAt = new Map<string, number>();
  /** Son yüklemede `keys.json` okunamadı ya da şemaya uymadı; kurtarma akışı için işaretlenir. */
  #corrupt = false;

  constructor(path: string, legacyAuthPath?: string, now: () => number = () => Date.now()) {
    this.#path = path;
    this.#authPath = legacyAuthPath;
    this.#now = now;
    this.#file = this.#load();
    this.#stamp = this.#stampOf();
    // Bozuk dosya silinmeden `.corrupt-*` yedeğine alınır; kullanıcı inceleyebilsin.
    if (this.#corrupt) this.#backupCorrupt();
    // Anahtar dosyası yoksa ya da bozuksa auth.json bir kurtarma kaynağıdır.
    const auth = legacyAuthPath;
    if (
      auth !== undefined &&
      existsSync(auth) &&
      Object.keys(this.#file.providers).length === 0 &&
      (!existsSync(path) || this.#corrupt)
    ) {
      this.#migrate(auth);
    }
    // Havuz geçerli biçimde doluysa Pi'nin göreceği auth.json senkronlanır; geçerli boş havuz da
    // auth'u temizler (kullanıcı tüm anahtarları kaldırmış olabilir). Bozuk havuz dokunmaz.
    this.#syncAuth(existsSync(path) && !this.#corrupt);
  }

  // ---------- CredentialStore ----------

  async read(providerId: string): Promise<Credential | undefined> {
    const slot = this.#active(providerId);
    if (!slot) return undefined;
    this.#lastServed.set(providerId, slot.id);
    const credential = slot.credential;
    if (kindOf(credential) === "key") return credential;
    if (credential.type !== "api_key" || !credential.key) return credential;
    // Pi özel store'dan gelen değere çözümleme uygulamaz (kendi AuthStorage'ının işi); bu yüzden
    // referansı burada çözeriz. Çözülemeyen referans Pi'nin key'siz credential davranışıyla aynı
    // sonuca çıkar: "bağlı değil".
    const resolved = resolveConfigValue(credential.key, credential.env);
    if (resolved === undefined) return undefined;
    return { ...credential, key: resolved };
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const out: CredentialInfo[] = [];
    for (const providerId of Object.keys(this.#state().providers)) {
      const slot = this.#active(providerId);
      if (slot) out.push({ providerId, type: slot.credential.type });
    }
    return out;
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.#serialize(providerId, async () => {
      const current = this.#active(providerId);
      const next = await fn(current?.credential);
      const label = this.#pendingLabel.get(providerId);
      this.#pendingLabel.delete(providerId);
      if (!next) return current?.credential;
      const slots = this.#slots(providerId);
      const target =
        next.type === "api_key"
          ? slots.find((s) => s.credential.type === "api_key" && s.credential.key === next.key)
          : current && current.credential.type === "oauth"
            ? current
            : slots.find((s) => s.credential.type === "oauth");
      if (target) {
        target.credential = next;
        if (label) target.label = label;
      } else {
        this.#push(providerId, { id: randomUUID(), label, credential: next, addedAt: this.#now() });
      }
      this.#save();
      return next;
    });
  }

  delete(providerId: string): Promise<void> {
    return this.#serialize(providerId, async () => {
      delete this.#state().providers[providerId];
      this.#lastServed.delete(providerId);
      this.#save();
    });
  }

  // ---------- havuz yönetimi ----------

  /** Etiketi bekletir; asıl ekleme Pi `login` → `modify` üzerinden gelir. */
  add(providerId: string, label?: string): void {
    const trimmed = label?.trim();
    if (trimmed) this.#pendingLabel.set(providerId, trimmed);
    else this.#pendingLabel.delete(providerId);
  }

  remove(providerId: string, slotId: string): { remaining: number } {
    const file = this.#state();
    const slots = this.#slots(providerId).filter((s) => s.id !== slotId);
    if (slots.length === 0) delete file.providers[providerId];
    else file.providers[providerId] = { slots };
    if (this.#lastServed.get(providerId) === slotId) this.#lastServed.delete(providerId);
    this.#save();
    return { remaining: slots.length };
  }

  /** Yuvayı başa alır ve soğumasını siler. */
  activate(providerId: string, slotId: string): void {
    const slots = this.#slots(providerId);
    const index = slots.findIndex((s) => s.id === slotId);
    if (index < 0) return;
    const [slot] = slots.splice(index, 1);
    if (!slot) return;
    slot.cooldownUntil = undefined;
    slots.unshift(slot);
    this.#save();
  }

  /**
   * Aktif yuvayı soğumaya alır. Az önce rotasyon olduysa (eşzamanlı oturumların aynı hatayı
   * bildirmesi) yeni aktif yuvayı korumak için hiçbir şey yapmaz.
   */
  markLimited(providerId: string, cooldownMs: number): RotationResult | undefined {
    const now = this.#now();
    const rotatedAt = this.#rotatedAt.get(providerId);
    if (rotatedAt !== undefined && now - rotatedAt < ROTATION_DEBOUNCE_MS) return undefined;
    const from = this.#active(providerId);
    if (!from) return undefined;
    const cooldownUntil = Math.max(from.cooldownUntil ?? 0, now + cooldownMs);
    from.cooldownUntil = cooldownUntil;
    const to = this.#slots(providerId).some((s) => !this.#cooling(s, now))
      ? this.#active(providerId)
      : undefined;
    if (to && to.id !== from.id) this.#rotatedAt.set(providerId, now);
    this.#save();
    return { from: refOf(from), to: to ? refOf(to) : null, cooldownUntil };
  }

  /** Son sunulan yuva çalıştı: soğumasını temizle. */
  markHealthy(providerId: string): void {
    const id = this.#lastServed.get(providerId);
    const slot = this.#slots(providerId).find((s) => s.id === id);
    if (!slot || slot.cooldownUntil === undefined) return;
    slot.cooldownUntil = undefined;
    this.#save();
  }

  /** Arayüz görünümü; gizli değer içermez (referansta kullanıcının kendi yazdığı metin görünür). */
  snapshot(providerId: string): ApiKeySlot[] {
    const now = this.#now();
    const active = this.#active(providerId);
    return this.#slots(providerId).map((s) => {
      const kind = kindOf(s.credential);
      const rawKey = s.credential.type === "api_key" ? s.credential.key : undefined;
      const reference = kind === "key" ? undefined : rawKey;
      // Komut çalıştırmadan yalnız `process.env` üzerinden ölçülür; ucuz ve yan etkisiz.
      const envMissing =
        kind === "env" && rawKey
          ? getMissingConfigValueEnvVarNames(
              rawKey,
              s.credential.type === "api_key" ? s.credential.env : undefined,
            ).length > 0
          : undefined;
      return {
        id: s.id,
        label: s.label,
        hint: hintOf(s.credential),
        kind,
        ...(reference ? { reference } : {}),
        ...(envMissing ? { envMissing: true } : {}),
        type: s.credential.type,
        active: s.id === active?.id,
        cooldownUntil:
          this.#cooling(s, now) && s.cooldownUntil !== undefined ? s.cooldownUntil : null,
        addedAt: s.addedAt,
      };
    });
  }

  slotCount(providerId: string): number {
    return this.#slots(providerId).length;
  }

  maxSlotCount(): number {
    let max = 0;
    for (const p of Object.values(this.#state().providers)) max = Math.max(max, p.slots.length);
    return max;
  }

  // ---------- iç ----------

  #slots(providerId: string): Slot[] {
    return this.#state().providers[providerId]?.slots ?? [];
  }

  #push(providerId: string, slot: Slot): void {
    const file = this.#state();
    const entry = file.providers[providerId];
    if (entry) entry.slots.push(slot);
    else file.providers[providerId] = { slots: [slot] };
  }

  /**
   * Bellekteki havuzu döndürür; dosya dışarıdan (kullanıcı elle düzenleyince) değiştiyse önce
   * yeniden okur. Aksi hâlde ilk açılışta okunan içerik elle yapılan değişikliğin üzerine yazardı.
   */
  #state(): PoolFile {
    const stamp = this.#stampOf();
    if (stamp !== this.#stamp) {
      this.#file = this.#load();
      this.#stamp = stamp;
    }
    return this.#file;
  }

  #stampOf(): string | undefined {
    try {
      const s = statSync(this.#path);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return undefined;
    }
  }

  #cooling(slot: Slot, now: number): boolean {
    return slot.cooldownUntil !== undefined && slot.cooldownUntil > now;
  }

  /** Soğumasız ilk yuva; hepsi soğumadaysa en erken açılacak olan. */
  #active(providerId: string): Slot | undefined {
    const slots = this.#slots(providerId);
    if (slots.length === 0) return undefined;
    const now = this.#now();
    const ready = slots.find((s) => !this.#cooling(s, now));
    if (ready) return ready;
    return slots.reduce((best, s) =>
      (s.cooldownUntil ?? 0) < (best.cooldownUntil ?? 0) ? s : best,
    );
  }

  #serialize<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#chains.get(providerId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    this.#chains.set(providerId, run);
    return run;
  }

  #load(): PoolFile {
    this.#corrupt = false;
    if (!existsSync(this.#path)) return { version: 1, providers: {} };
    try {
      const parsed = PoolFile.safeParse(JSON.parse(readFileSync(this.#path, "utf8")));
      if (parsed.success) return parsed.data;
    } catch {
      // Aşağıda bozuk sayılır; kurtarma constructor'da denenir.
    }
    this.#corrupt = true;
    return { version: 1, providers: {} };
  }

  /** Bozuk anahtar dosyasını silmeden `.corrupt-<zaman>` yedeğine alır (en iyi çaba). */
  #backupCorrupt(): void {
    try {
      copyFileSync(this.#path, `${this.#path}.corrupt-${Date.now()}`);
    } catch {
      // Yedek alınamazsa kurtarma akışı yine devam eder.
    }
  }

  #migrate(legacyAuthPath: string): void {
    try {
      const parsed = LegacyAuthFile.safeParse(JSON.parse(readFileSync(legacyAuthPath, "utf8")));
      if (!parsed.success) return;
      const now = this.#now();
      for (const [providerId, credential] of Object.entries(parsed.data)) {
        this.#state().providers[providerId] = {
          slots: [{ id: randomUUID(), credential, addedAt: now }],
        };
      }
      this.#save();
    } catch {
      // Eski dosya okunamıyorsa boş havuzla devam edilir; kullanıcı anahtarı yeniden girer.
    }
  }

  #save(): void {
    // Atomik yazım: çökme ya da kilit hâlinde anahtar dosyası yarım kalmaz (Windows EBUSY dahil).
    writeFileAtomic(this.#path, `${JSON.stringify(this.#file, null, 2)}\n`, { mode: 0o600 });
    // Geçici dosya 0600 doğduğu için burada yalnız eski dosyaların izni düzeltilir.
    chmodSync(this.#path, 0o600);
    // Kendi yazdığımız içeriği "dışarıdan değişmiş" saymamak için damgayı tazeleriz.
    this.#stamp = this.#stampOf();
    // Pi eklentilerinin child süreçleri anahtarı auth.json'dan okur (PI_CODING_AGENT_DIR);
    // her yazımda ayna tazelenir, böylece rotasyonda child da yeni aktif anahtarı görür.
    this.#syncAuth(true);
  }

  /**
   * Havuzun Pi görünümünü `auth.json`'a yazar: sağlayıcı başına aktif yuva. Havuz birincil kalır
   * (çoklu anahtar, rotasyon, soğuma); dosya yalnız köprüdür. `force` yazma yollarında true'dur ve
   * geçerli boş havuz auth'u temizler; bozuk havuz dokunmaz. `$VAR`/`!komut` referansları ham
   * yazılır: Pi bu sentaksı auth.json'da kendisi çözer (providers.md → Key Resolution).
   */
  #syncAuth(force: boolean): void {
    const path = this.#authPath;
    if (!path) return;
    const providers = this.#file.providers;
    if (!force && Object.keys(providers).length === 0) return;
    const out: Record<string, Credential> = {};
    for (const providerId of Object.keys(providers)) {
      const slot = this.#active(providerId);
      if (slot) out[providerId] = slot.credential;
    }
    try {
      writeFileAtomic(path, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
      chmodSync(path, 0o600);
    } catch {
      // Ayna ikincildir: yazılamazsa anahtar işlemi başarısız sayılmaz; sonraki yazımda yeniden
      // denenir. (İzin değişimi desteklenmeyen dosya sistemlerinde de 0600 en iyi çabadır.)
    }
  }
}
