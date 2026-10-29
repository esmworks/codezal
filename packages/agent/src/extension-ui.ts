import type { ExtensionUiRequest, ExtensionUiValue } from "@codezal/contracts";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/** Pi `ExtensionUIDialogOptions` ile yapısal uyumlu: iptal sinyali ve zaman aşımı. */
export interface ExtensionDialogOptions {
  signal?: AbortSignal;
  timeout?: number;
}

export interface ExtensionUiBridgeOptions {
  /** `confirm`/`select`/`input` isteği kullanıcıya gösterilsin (kart). */
  onRequest: (request: ExtensionUiRequest) => void;
  /** `notify` bildirimi gösterilsin (toast). */
  onNotify: (message: string, level: "info" | "warning" | "error") => void;
  /** Desteklenmeyen TUI çağrısı; metot başına bir kez yayınlanır. */
  onUnsupported?: (method: string) => void;
  /**
   * Widget metin satırları (`ctx.ui.setWidget`). İçerik `undefined` ise widget temizlendi.
   * Bileşen fabrikası gelirse taşınmaz: TUI bileşeni masaüstünde çizilemez.
   */
  onWidget?: (key: string, lines: string[] | undefined) => void;
  /** Bekleyen istekler iptal edildi (tur iptali, oturum kapanışı); kartlar kalkar. */
  onCancelled?: (requestIds: string[]) => void;
}

interface Pending {
  request: ExtensionUiRequest;
  resolve: (value: ExtensionUiValue) => void;
  cleanup?: () => void;
}

let seq = 0;

/**
 * Eklenti `ctx.ui` köprüsü. `confirm`/`select`/`input` kartla sorulur, cevap `respond` ile
 * çözülür; `notify` toast'a düşer. Aynı anda tek kart gösterilir, sıradakiler bekler (Pi
 * TUI'nin modal sırası gibi). Widget metin satırları `onWidget` ile ana sürece geçer; öteki
 * TUI'ye özel kancalar (footer, başlık, tema, özel bileşen) desteklenmez: uygulama çöker değil,
 * çağrı no-op olur ve bir kez bildirilir. `onTerminalInput` sessizce yutulur (bkz. gerekçe).
 */
export class ExtensionUiBridge {
  readonly #sessionId: string;
  readonly #options: ExtensionUiBridgeOptions;
  readonly #pending = new Map<string, Pending>();
  readonly #queue: string[] = [];
  readonly #warned = new Set<string>();
  #active: string | null = null;

  constructor(sessionId: string, options: ExtensionUiBridgeOptions) {
    this.#sessionId = sessionId;
    this.#options = options;
  }

  /** Pi'ye `bindExtensions` ile verilecek yüzey. */
  create(): ExtensionUIContext {
    const context: ExtensionUIContext = {
      select: (title, options, opts) =>
        this.#select(title, options, opts as ExtensionDialogOptions | undefined),
      confirm: (title, message, opts) =>
        this.#confirm(title, message, opts as ExtensionDialogOptions | undefined),
      input: (title, placeholder, opts) =>
        this.#input(title, placeholder, opts as ExtensionDialogOptions | undefined),
      notify: (message, type) => this.#options.onNotify(message, type ?? "info"),
      // Masaüstünde ham terminal girişi yok (Pi'de de "interactive mode only"): eklentiler bu
      // kancayı `typeof` kontrolüyle çağırıyor. Çağrı sessizce yutulur — kullanıcının yapacağı bir
      // şey olmadığı için bildirim yalnızca kırmızı gürültü üretiyordu (Pi'nin rpc modu da no-op).
      onTerminalInput: () => () => {},
      setStatus: () => this.#unsupported("setStatus"),
      setWorkingMessage: () => this.#unsupported("setWorkingMessage"),
      setWorkingVisible: () => this.#unsupported("setWorkingVisible"),
      setWorkingIndicator: () => this.#unsupported("setWorkingIndicator"),
      setHiddenThinkingLabel: () => this.#unsupported("setHiddenThinkingLabel"),
      /*
       * Pi iki overload veriyor: metin satırları ve TUI bileşen fabrikası. rpc modunda yalnız
       * ilki gelir; satırlar `onWidget` ile ana sürece taşınır (engine bunu desteklenmiyor diye
       * bildirir). Fabrika çizilemediği için eski "desteklenmiyor" davranışı korunur.
       */
      setWidget: ((key: string, content: unknown) => {
        if (content === undefined) {
          this.#options.onWidget?.(key, undefined);
          return;
        }
        if (Array.isArray(content)) {
          const lines = content.filter((line): line is string => typeof line === "string");
          // Boş dizi de temizleme sayılır: masaüstünde çizilecek satır kalmadı.
          this.#options.onWidget?.(key, lines.length > 0 ? lines : undefined);
          return;
        }
        this.#unsupported("setWidget");
      }) as ExtensionUIContext["setWidget"],
      setFooter: () => this.#unsupported("setFooter"),
      setHeader: () => this.#unsupported("setHeader"),
      setTitle: () => this.#unsupported("setTitle"),
      custom: async () => {
        this.#unsupported("custom");
        return undefined as never;
      },
      pasteToEditor: () => this.#unsupported("pasteToEditor"),
      setEditorText: () => this.#unsupported("setEditorText"),
      getEditorText: () => {
        this.#unsupported("getEditorText");
        return "";
      },
      editor: async () => {
        this.#unsupported("editor");
        return undefined;
      },
      addAutocompleteProvider: () => this.#unsupported("addAutocompleteProvider"),
      setEditorComponent: () => this.#unsupported("setEditorComponent"),
      getEditorComponent: () => undefined,
      // Tema aşağıda non-enumerable getter olarak tanımlanır: Pi, bu yüzeyi `{...ui}` ile
      // kopyalıyor (dist/core/extensions/runner.js, `wrapUIPromptContext`) ve spread getter'ları
      // değerlendirdiği için enumerable bir getter her oturum açılışında yanlış "desteklenmeyen
      // çağrı" bildirimi üretirdi.
      theme: undefined as never,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({
        success: false,
        error: "Tema değişimi masaüstü arayüzünde desteklenmiyor",
      }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => this.#unsupported("setToolsExpanded"),
    };
    Object.defineProperty(context, "theme", {
      configurable: true,
      enumerable: false,
      get: () => {
        this.#unsupported("theme");
        return undefined as never;
      },
    });
    return context;
  }

  /** Bekleyen isteği çözer; istek artık kuyrukta değilse false. */
  respond(requestId: string, value: ExtensionUiValue): boolean {
    const pending = this.#pending.get(requestId);
    if (!pending) return false;
    this.#pending.delete(requestId);
    pending.cleanup?.();
    const index = this.#queue.indexOf(requestId);
    if (index >= 0) this.#queue.splice(index, 1);
    if (this.#active === requestId) {
      this.#active = null;
      this.#pump();
    }
    pending.resolve(value);
    return true;
  }

  /** Oturum durunca/kapanınca bekleyenleri çözer: eklenti sonsuza beklemez. */
  cancelAll(): void {
    const ids: string[] = [];
    for (const [id, pending] of [...this.#pending]) {
      pending.cleanup?.();
      pending.resolve(pending.request.kind === "confirm" ? false : null);
      this.#pending.delete(id);
      ids.push(id);
    }
    this.#queue.length = 0;
    this.#active = null;
    if (ids.length > 0) this.#options.onCancelled?.(ids);
  }

  async #select(
    title: string,
    options: string[],
    opts?: ExtensionDialogOptions,
  ): Promise<string | undefined> {
    const value = await this.#ask(
      "select",
      { title, message: null, options, placeholder: null },
      opts,
    );
    return typeof value === "string" ? value : undefined;
  }

  async #confirm(title: string, message: string, opts?: ExtensionDialogOptions): Promise<boolean> {
    const value = await this.#ask(
      "confirm",
      { title, message, options: null, placeholder: null },
      opts,
    );
    return value === true;
  }

  async #input(
    title: string,
    placeholder?: string,
    opts?: ExtensionDialogOptions,
  ): Promise<string | undefined> {
    const value = await this.#ask(
      "input",
      { title, message: null, options: null, placeholder: placeholder ?? null },
      opts,
    );
    return typeof value === "string" ? value : undefined;
  }

  #ask(
    kind: ExtensionUiRequest["kind"],
    fields: Pick<ExtensionUiRequest, "title" | "message" | "options" | "placeholder">,
    opts?: ExtensionDialogOptions,
  ): Promise<ExtensionUiValue> {
    const requestId = `extui-${Date.now()}-${++seq}`;
    const request: ExtensionUiRequest = { requestId, sessionId: this.#sessionId, kind, ...fields };
    return new Promise<ExtensionUiValue>((resolve) => {
      const pending: Pending = { request, resolve };
      if (opts?.timeout !== undefined) {
        const timer = setTimeout(() => this.respond(requestId, null), opts.timeout);
        pending.cleanup = () => clearTimeout(timer);
      }
      const signal = opts?.signal;
      // Sinyal istek kurulmadan önce iptal edilmişse "abort" olayı bir daha ateşlenmez:
      // kart hiç gösterilmez, eklenti de asılı kalmaz.
      if (signal?.aborted) {
        pending.cleanup?.();
        resolve(null);
        return;
      }
      if (signal) {
        const onAbort = () => this.respond(requestId, null);
        signal.addEventListener("abort", onAbort, { once: true });
        const previous = pending.cleanup;
        pending.cleanup = () => {
          previous?.();
          signal.removeEventListener("abort", onAbort);
        };
      }
      this.#pending.set(requestId, pending);
      this.#queue.push(requestId);
      this.#pump();
    });
  }

  #pump(): void {
    if (this.#active !== null) return;
    const next = this.#queue.shift();
    if (next === undefined) return;
    this.#active = next;
    const pending = this.#pending.get(next);
    if (pending) this.#options.onRequest(pending.request);
  }

  #unsupported(method: string): void {
    if (this.#warned.has(method)) return;
    this.#warned.add(method);
    this.#options.onUnsupported?.(method);
  }
}
