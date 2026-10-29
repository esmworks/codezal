import { realpathSync, type Stats, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type {
  McpToolPolicy,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
} from "@codezal/contracts";
import { dict, type Locale } from "@codezal/i18n";
import { ADVISOR_TOOL } from "./advisor.js";
import { AGENT_RUN_TOOLS } from "./agents/run-tools.js";
import { AGENT_TOOL } from "./agents/tool.js";
import {
  AUDIT_HUNT_TOOL,
  AUDIT_RECORD_TOOL,
  AUDIT_REPORT_TOOL,
  AUDIT_START_TOOL,
  AUDIT_STATUS_TOOL,
  AUDIT_VERIFY_TOOL,
} from "./audit/tools.js";
import { BACKGROUND_TOOL, isVerificationCommand } from "./background.js";
import { editedFile, FILE_CREATE_TOOLS, FILE_EDIT_TOOLS } from "./create-tools.js";
import { TOOL_SEARCH_TOOL } from "./mcp.js";
import { PDF_EDIT_TOOL } from "./pdf-edit-tool.js";
import { PLAN_ENTER_TOOL, PLAN_EXIT_TOOL } from "./plan-tools.js";
import { QUESTION_TOOL } from "./question-tool.js";
import { expandReadPath } from "./read-path.js";
import { SCHEDULE_TOOL } from "./schedule-tool.js";
import { TASK_LIST_TOOL } from "./task-list.js";
import { describeTool, isDangerousCommand } from "./tool-info.js";

export type GateVerdict = "allow" | "block" | "ask";

// Adım listesi ve araç araması dosya sistemine dokunmaz; plan modunda da serbesttir.
// Web araçları ayrıdır (aşağıda `WEB_FETCH`, `WEB_SEARCH`): adrese ya da sorguya konan veri
// dışarı çıkabildiği için sorulan modlarda onaya düşer (yerel ağ adresleri `web_fetch` içinde
// ayrıca engellidir).
// Ajan devri (`agent`) de aynı sınıftadır: çağrının kendisi dosyaya dokunmaz, alt ajanın araç
// çağrıları kendi oturumunda aynı kapıdan geçip gerekirse kullanıcıya sorulur. Koşu yönetimi
// (`agent_list`/`agent_message`/`agent_stop`) yalnızca koşuyu okur ya da yönlendirir.
// Plan araçları modu değiştirir, dosyaya dokunmaz; `plan_exit` plan modunda çağrılabilmeli.
// Soru aracı yalnızca kullanıcıya sorar; plan yazmadan önce netleştirmek için Plan modunda da
// serbesttir (kullanıcıya soru sormak engellenirse model varsayımla plan yazar).
// Denetim araçları yalnızca uygulamaya ait run klasörüne yazar; hedef dosyaya dokunmaz, ağa
// çıkmaz, alt ajanları da salt-okunur çalışır. Bu yüzden okuma sınıfındadır ve plan modunda da
// serbesttir (denetim run'ı oturumu bilinçli olarak plan iznine çeker, K5).
const READ_ONLY = new Set([
  "read",
  "grep",
  "find",
  "ls",
  TASK_LIST_TOOL,
  TOOL_SEARCH_TOOL,
  AGENT_TOOL,
  ...AGENT_RUN_TOOLS,
  PLAN_ENTER_TOOL,
  PLAN_EXIT_TOOL,
  QUESTION_TOOL,
  AUDIT_START_TOOL,
  AUDIT_HUNT_TOOL,
  AUDIT_VERIFY_TOOL,
  AUDIT_RECORD_TOOL,
  AUDIT_STATUS_TOOL,
  AUDIT_REPORT_TOOL,
  // Danışman yalnız konuşmayı okuyup tavsiye döndürür; dosyaya ve ağa kendisi dokunmaz.
  ADVISOR_TOOL,
]);
const WEB_FETCH = "web_fetch";
const WEB_SEARCH = "web_search";
// PDF/Word/Excel üretimi ve belge düzenlemesi de dosya yazar; `write` ile aynı satırda değerlendirilir.
const MUTATING = new Set(["edit", "write", ...FILE_EDIT_TOOLS, ...FILE_CREATE_TOOLS]);
// Arka plan aracının `start` eylemi kabukta komut çalıştırır; diğer eylemleri okumadır (aşağıda).
const SHELL = new Set(["bash", "powershell", BACKGROUND_TOOL]);

/**
 * PRD §6 izin tablosu. `args` verilirse eylemine göre ayrışan araçlar da doğru sınıflanır:
 * `bash_background` yalnızca `start` ile komut çalıştırır, çıktı okuma ve listeleme serbesttir.
 */
export function evaluatePermission(
  mode: PermissionMode,
  toolName: string,
  args?: Record<string, unknown>,
): GateVerdict {
  if (toolName === BACKGROUND_TOOL && args && args.action !== "start") return "allow";
  // PDF form alanlarını listelemek okumadır: dosya yazmaz, plan modunda da çalışır.
  if (toolName === PDF_EDIT_TOOL && args?.action === "list_fields") return "allow";
  if (READ_ONLY.has(toolName)) return "allow";
  // Ajan okuduğu bir metnin yönlendirmesiyle dosya ya da anahtar içeriğini adrese ya da arama
  // sorgusuna koyup dışarı gönderebilir. Sor ve Plan modunda (araştırma planda da gerekir) sorulur:
  // `web_fetch` izni alan adına, `web_search` izni oturumdaki aramalara verilir. Düzenleme onaysız
  // ve Tam erişim modları zaten sormadan çalışır.
  if (toolName === WEB_FETCH || toolName === WEB_SEARCH)
    return mode === "ask" || mode === "plan" ? "ask" : "allow";
  if (MUTATING.has(toolName)) {
    if (mode === "ask") return "ask";
    if (mode === "plan") return "block";
    return "allow";
  }
  if (SHELL.has(toolName)) {
    if (mode === "full") return "allow";
    if (mode === "plan") return "block";
    return "ask";
  }
  // Bilinmeyen (özel) araçlar: plan modunda engellenir, aksi halde sorulur; tam erişimde serbest.
  if (mode === "full") return "allow";
  if (mode === "plan") return "block";
  return "ask";
}

/** `path` argümanı dosya yolu olan araçlar; hedef bunlarda Pi'nin çözdüğü gibi normalize edilir. */
const PATH_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "edit",
  "write",
  ...FILE_EDIT_TOOLS,
  ...FILE_CREATE_TOOLS,
]);
/** Kimlik dosyasının içeriğini okuyan ya da değiştiren araçlar (`find`/`ls` yalnız ad listeler). */
const CREDENTIAL_TOOLS = new Set(["read", "grep", "edit", "write"]);

/**
 * Aracın dokunacağı mutlak yol. Pi yolu `resolveToCwd` ile oturumun cwd'sine göre çözer (`@` öneki,
 * `~` genişletmesi, `..`); kapı ham metne bakarsa `<bellek>/../../../.zshrc` güvenilir kökün altında
 * görünüyordu. Üretim araçları (PDF, Word) göreli adı çıktı klasörüne yazar: göreli yolları burada
 * çözülmez.
 */
function resolveToolPath(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): string | undefined {
  if (!PATH_TOOLS.has(toolName)) return undefined;
  const raw = typeof args.path === "string" && args.path.length > 0 ? args.path : undefined;
  if (!raw) return toolName === "grep" ? resolve(cwd) : undefined;
  // Belge düzenlemesi `output` ile başka dosyaya yazabilir; kapı yazılan dosyaya bakar.
  if (FILE_EDIT_TOOLS.has(toolName)) return editedFile(toolName, args, cwd);
  if (FILE_CREATE_TOOLS.has(toolName)) {
    const stripped = raw.startsWith("@") ? raw.slice(1) : raw;
    if (!isAbsolute(stripped) && stripped !== "~" && !stripped.startsWith("~/")) return undefined;
  }
  return resolve(expandReadPath(raw, cwd));
}

/**
 * Sembolik bağları çözülmüş yol. Dosya henüz yoksa var olan en yakın üst klasör çözülür ve kalan
 * parçalar eklenir: güvenilir kökteki bir bağ (`<bellek>/x -> ~/.zshrc`) kökün dışına çıkamasın.
 */
function canonicalPath(path: string): string {
  const tail: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return tail.length > 0 ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      tail.push(basename(current));
      current = parent;
    }
  }
}

function statOf(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

interface Pending {
  request: PermissionRequest;
  resolve: (decision: PermissionDecision) => void;
}

let counter = 0;

/**
 * "Bu oturumda hep izin ver" kaydının anahtarı: araç + o an sorulan hedef. Kartta kullanıcıya
 * gösterilen şey hedeftir; yalnız araç adıyla kaydedilirse bir dosyaya verilen izin aynı araçla
 * yapılan **bütün** sonraki işlemleri (örn. `~/.zshrc` yazımı) sessizce geçirirdi.
 */
function allowKey(toolName: string, target: string | undefined): string {
  return `${toolName}\u0000${target ?? ""}`;
}

/** `web_fetch` adresinin alan adı (küçük harf, sondaki nokta atılmış); oturum izni buna verilir. */
function fetchHost(args: Record<string, unknown>): string | undefined {
  if (typeof args.url !== "string") return undefined;
  try {
    return new URL(args.url).hostname.toLowerCase().replace(/\.$/, "") || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Onay isteklerini bekletir ve cevaplar. Oturum başına "bu oturumda hep izin ver" listesi tutar.
 */
export class PermissionManager {
  readonly #pending = new Map<string, Pending>();
  readonly #sessionAllow = new Map<string, Set<string>>();
  /** Başında kimse olmayan oturumlar (zamanlanmış görev): soru yerine ret döner, tur asılı kalmaz. */
  readonly #unattended = new Set<string>();
  /** Web araçları önceden izinli oturumlar (görev kaydında "Web'e erişebilir"). */
  readonly #webAllowed = new Set<string>();
  readonly #onRequest: (request: PermissionRequest) => void;
  readonly #onResolved: (request: PermissionRequest) => void;
  /** Bu köklerin altına yazma/düzenleme sorulmadan geçer (ör. bellek klasörü). */
  readonly #trustedRoots: readonly string[];
  readonly #lang: Locale;
  /** Bağlayıcı aracının Ayarlar'daki izni (Servisler); diğer araçlar için `undefined`. */
  readonly #toolPolicy: (toolName: string) => McpToolPolicy | undefined;
  /**
   * Codezal'ın kimlik dosyaları (`keys.json`, `auth.json`, `mcp.json`). Modda ya da onayda
   * bakılmadan reddedilir: okuma araçları her modda serbest olduğu için model (ya da okuduğu bir
   * sayfanın yönlendirmesi) anahtarları sorusuz transkripte taşıyabiliyordu.
   */
  readonly #credentialFiles: readonly string[];

  constructor(
    onRequest: (request: PermissionRequest) => void,
    trustedRoots: readonly string[] = [],
    lang: Locale = "tr",
    toolPolicy: (toolName: string) => McpToolPolicy | undefined = () => undefined,
    onResolved: (request: PermissionRequest) => void = () => {},
    credentialFiles: readonly string[] = [],
  ) {
    this.#credentialFiles = credentialFiles;
    this.#onRequest = onRequest;
    this.#onResolved = onResolved;
    this.#trustedRoots = trustedRoots;
    this.#lang = lang;
    this.#toolPolicy = toolPolicy;
  }

  /**
   * Aracın çalışıp çalışmayacağına karar verir; gerekiyorsa kullanıcıya sorar. `cwd` göreli yolun
   * çözüleceği oturum klasörüdür (Pi'nin kendisi de aynı klasöre göre çözer).
   */
  async gate(
    sessionId: string,
    mode: PermissionMode,
    toolName: string,
    args: Record<string, unknown>,
    agent?: string,
    cwd: string = process.cwd(),
  ): Promise<{ allowed: boolean; reason?: string; planBlocked?: boolean }> {
    const d = dict(this.#lang);
    const info = describeTool(toolName, args, this.#lang);
    const resolved = resolveToolPath(toolName, args, cwd);
    const credential =
      resolved && CREDENTIAL_TOOLS.has(toolName)
        ? this.#touchesCredentials(toolName, resolved)
        : undefined;
    if (credential === "file") return { allowed: false, reason: d.permission.credentialFile };
    // Görev koşusu kendi tanımını ve başka görevleri değiştiremez (ZCode'un automation turn
    // denylist'i): okunan bir sayfadaki talimat Tam erişimde kalıcı, her gün koşan yeni bir görev
    // kurabiliyordu. Listeleme okumadır, açık kalır.
    if (toolName === SCHEDULE_TOOL && args.action !== "list" && this.#unattended.has(sessionId))
      return { allowed: false, reason: d.permission.scheduleInRun };
    // Kartta ve oturum izninde normalize yol kullanılır: kullanıcı `a/../../.zshrc` yerine gerçek
    // hedefi görür, `./a.ts` ile `a.ts` için verilen izin de aynı anahtara düşer.
    // `web_fetch`te hedef alan adıdır (izin ona verilir), kartta tam adres gösterilir. Sorgu her
    // seferinde farklıdır; `web_search` izni hedefsiz anahtarla oturumdaki bütün aramalara verilir,
    // kartta sorgu görünür.
    const host = toolName === WEB_FETCH ? fetchHost(args) : undefined;
    const search = toolName === WEB_SEARCH;
    const target = search
      ? undefined
      : (host ?? (resolved && info.target === args.path ? resolved : info.target));
    const command = host || search ? info.target : info.command;
    // Güvenilir kökler (bellek, plan dosyaları): moddan bağımsız serbest; plan modunda plan yazılır.
    if (MUTATING.has(toolName) && resolved && this.#underTrustedRoot(resolved))
      return { allowed: true };
    // Kapatılan bağlayıcı aracı ajandan çekilir; canlı oturumda kalmışsa burada durur.
    const policy = this.#toolPolicy(toolName);
    if (policy === "off") return { allowed: false, reason: d.permission.toolDisabled };
    // "Otomatik" yalnız soruyu kaldırır: plan modu yan etkiyi yasaklar, orada yine engellenir.
    const verdict =
      policy === "auto" && mode !== "plan" ? "allow" : evaluatePermission(mode, toolName, args);
    if (verdict === "block") {
      return {
        allowed: false,
        reason: d.permission.blockedInPlan,
        planBlocked: true,
      };
    }
    // Doğrulama komutları arka plana atılamaz: model ön planda `bash` ile koşar. Kural burada
    // uygulanır ki Sor modunda boşuna onay penceresi açılmasın; tool da aynı kuralı yedekler.
    // Plan engeli üstte kaldı: plan modunda doğru gerekçe "plan" olarak görünür.
    if (
      toolName === BACKGROUND_TOOL &&
      args.action === "start" &&
      typeof args.command === "string" &&
      isVerificationCommand(args.command)
    ) {
      return {
        allowed: false,
        reason: d.prompt.backgroundVerification.replace("{{command}}", args.command),
      };
    }
    // Yalnız kabuk komutu taşıyan kartlar taranır; `schedule_task` ayrıntısı istem metnidir.
    const shell = info.kind === "terminal" || info.kind === "delete";
    // Kimlik klasörünü kapsayan `grep` (ör. home proje olarak açıldı) reddedilmez ama her modda
    // sorulur: tamamen reddetmek o projede bütün aramaları bozardı, sessiz izin anahtarı sızdırırdı.
    const dangerous =
      (shell && info.command ? isDangerousCommand(info.command) : false) ||
      credential === "ancestor";
    if (verdict === "allow" && !dangerous) return { allowed: true };
    const allow = this.#sessionAllow.get(sessionId);
    if (allow?.has(allowKey(toolName, target)) && !dangerous) return { allowed: true };
    if ((host || search) && this.#webAllowed.has(sessionId)) return { allowed: true };
    if (this.#unattended.has(sessionId)) return { allowed: false, reason: d.permission.unattended };

    const requestId = `perm-${Date.now()}-${++counter}`;
    const request: PermissionRequest = {
      requestId,
      sessionId,
      toolName,
      kind: info.kind,
      dangerous,
      ...(target ? { target } : {}),
      ...(command ? { command } : {}),
      ...(agent ? { agent } : {}),
    };
    const decision = await new Promise<PermissionDecision>((resolve) => {
      this.#pending.set(requestId, { request, resolve });
      this.#onRequest(request);
    });
    this.#pending.delete(requestId);
    this.#onResolved(request);

    if (decision === "allow-session") {
      let set = this.#sessionAllow.get(sessionId);
      if (!set) {
        set = new Set();
        this.#sessionAllow.set(sessionId, set);
      }
      set.add(allowKey(toolName, target));
      return { allowed: true };
    }
    if (decision === "allow") return { allowed: true };
    return { allowed: false, reason: d.permission.userDenied };
  }

  #underTrustedRoot(target: string): boolean {
    const real = canonicalPath(target);
    return this.#trustedRoots.some((r) => isUnder(real, canonicalPath(r)));
  }

  /**
   * Hedef bir kimlik dosyası mı (ya da `grep` için onu içeren klasör mü)? Yol sembolik bağlar
   * çözülerek karşılaştırılır; sabit bağ ve büyük/küçük harf farkı (macOS) için dosya kimliğine
   * (aygıt + inode) de bakılır. Atomik yazımın geçici `.tmp` kopyası da aynı içeriği taşır.
   */
  #touchesCredentials(toolName: string, resolved: string): "file" | "ancestor" | undefined {
    if (this.#credentialFiles.length === 0) return undefined;
    const target = canonicalPath(resolved);
    const files = this.#credentialFiles.flatMap((f) => [f, `${f}.tmp`]);
    let ancestor = false;
    for (const file of files) {
      const real = canonicalPath(file);
      if (target === real) return "file";
      if (toolName === "grep" && isUnder(real, target)) ancestor = true;
    }
    if (ancestor) return "ancestor";
    const stat = statOf(target);
    if (!stat?.isFile()) return undefined;
    const linked = files.some((file) => {
      const other = statOf(file);
      return other !== undefined && other.ino === stat.ino && other.dev === stat.dev;
    });
    return linked ? "file" : undefined;
  }

  /** Başında kimse yok mu (zamanlanmış görev); plan onayı da bu durumda sorulmadan reddedilir. */
  isUnattended(sessionId: string): boolean {
    return this.#unattended.has(sessionId);
  }

  /** Oturumu gözetimsiz işaretler ya da işareti kaldırır. */
  setUnattended(sessionId: string, on: boolean): void {
    if (on) this.#unattended.add(sessionId);
    else this.#unattended.delete(sessionId);
  }

  /**
   * Oturumda `web_search`/`web_fetch` onayını önceden verir ya da geri alır. Zamanlanmış görev
   * "Web'e erişebilir" ile kaydedildiyse koşu boyunca açılır; Sor/Plan modunda da sorulmaz.
   */
  setWebAllowed(sessionId: string, on: boolean): void {
    if (on) this.#webAllowed.add(sessionId);
    else this.#webAllowed.delete(sessionId);
  }

  respond(requestId: string, decision: PermissionDecision): boolean {
    const p = this.#pending.get(requestId);
    if (!p) return false;
    p.resolve(decision);
    return true;
  }

  /** Oturum iptal edilince bekleyen tüm istekler reddedilir. */
  rejectAll(sessionId: string): void {
    for (const [id, p] of this.#pending) {
      if (p.request.sessionId === sessionId) {
        p.resolve("deny");
        this.#pending.delete(id);
      }
    }
  }

  pendingFor(sessionId: string): PermissionRequest[] {
    return [...this.#pending.values()]
      .filter((p) => p.request.sessionId === sessionId)
      .map((p) => p.request);
  }

  clearSession(sessionId: string): void {
    this.rejectAll(sessionId);
    this.#sessionAllow.delete(sessionId);
    this.#unattended.delete(sessionId);
    this.#webAllowed.delete(sessionId);
  }
}
