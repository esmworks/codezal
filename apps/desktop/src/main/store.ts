import { copyFileSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { writeFileAtomic } from "@codezal/agent";
import { z } from "zod";
import { log } from "./log.js";

type Loaded<T> =
  /** Dosya yok: ilk açılış. */
  | { kind: "missing" }
  /** Dosya var ama okunamadı (izin, kilit): içeriği bilinmez, dokunulmaz. */
  | { kind: "ioError" }
  /** Dosya okundu ama JSON değil. */
  | { kind: "notJson" }
  | { kind: "json"; raw: unknown }
  | { kind: "ok"; value: T };

/** Şemanın kabuğu (varsayılan, isteğe bağlı vb.) soyulur; altta dizi varsa onu verir. */
function arrayElementOf(schema: z.ZodType): z.ZodType | undefined {
  let cur: z.ZodType = schema;
  for (let i = 0; i < 8; i++) {
    if (cur instanceof z.ZodArray) return cur.element as z.ZodType;
    if (cur instanceof z.ZodDefault || cur instanceof z.ZodOptional || cur instanceof z.ZodNullable)
      cur = cur.unwrap() as z.ZodType;
    else return undefined;
  }
  return undefined;
}

/**
 * Alan bazında kurtarma: şema bir `z.object` ise geçerli üst düzey alanlar korunur, geçersizler
 * atılıp varsayılana bırakılır; dizi alanında yalnız geçersiz öğeler düşer (tek bozuk görev bütün
 * görev listesini silmesin). Şema nesne değilse ya da kurtarılan değer yine geçmiyorsa undefined.
 */
export function salvage<S extends z.ZodType<Record<string, unknown>>>(
  schema: S,
  raw: unknown,
): z.output<S> | undefined {
  if (!(schema instanceof z.ZodObject)) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const shape = schema.shape as Record<string, z.ZodType>;
  const fixed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    const field = shape[key];
    // Şemada olmayan alan olduğu gibi bırakılır; ne yapılacağına (atma/koruma) şema karar verir.
    if (!field) {
      fixed[key] = value;
      continue;
    }
    if (field.safeParse(value).success) {
      fixed[key] = value;
      continue;
    }
    const element = Array.isArray(value) ? arrayElementOf(field) : undefined;
    if (element && Array.isArray(value)) {
      const kept = value.filter((item) => element.safeParse(item).success);
      if (field.safeParse(kept).success) fixed[key] = kept;
    }
    // Aksi hâlde alan yazılmaz; şemanın varsayılanı devreye girer.
  }
  const result = schema.safeParse(fixed);
  return result.success ? (result.data as z.output<S>) : undefined;
}

/** `ayar.json` → `ayar.corrupt-<zaman>.json`; aynı milisaniyede çakışmasın diye zaman damgalı. */
export function corruptBackupPath(path: string, now = Date.now()): string {
  const ext = extname(path);
  const name = basename(path, ext);
  return join(dirname(path), `${name}.corrupt-${now}${ext || ".json"}`);
}

/** Şemalı JSON dosyası: okuma hatasında varsayılan, her yazımda tam dosya. */
export class JsonStore<S extends z.ZodType<Record<string, unknown>>> {
  readonly #path: string;
  readonly #schema: S;
  #value: z.output<S>;

  /** Dosya yoktu ya da okunamadı: ilk açılış kararları (ör. dil algılama) bu işarete bakar. */
  readonly created: boolean;

  constructor(path: string, schema: S) {
    this.#path = path;
    this.#schema = schema;
    const loaded = this.#load();
    let parsed: z.output<S> | undefined;
    let backedUp = false;
    if (loaded.kind === "ok") parsed = loaded.value;
    else if (loaded.kind === "json" || loaded.kind === "notJson") {
      // Dosya okundu ama kullanılamıyor: ilk `set` onu ezmeden önce yedeklenir. Önceden tek
      // geçersiz alan (ör. elle düzenleme ya da yeni sürümün yazdığı bir değer) bütün dosyayı
      // sessizce varsayılana döndürüyor ve ilk yazım kullanıcının ayarlarını/görevlerini siliyordu.
      backedUp = this.#backup();
      if (loaded.kind === "json") parsed = salvage(schema, loaded.raw);
    }
    this.created = parsed === undefined;
    this.#value = parsed ?? schema.parse({});
    // Yedek alındıysa kurtarılan değer hemen yazılır: aksi hâlde hiç `set` görmeyen bir dosya her
    // açılışta yeniden geçersiz okunup yeni bir yedek bırakırdı. Yedek alınamadıysa asıl dosya tek
    // kopyadır, üstüne yazılmaz.
    if (backedUp) {
      try {
        this.set(this.#value);
      } catch (error) {
        log.warn("store", `kurtarılan değer yazılamadı: ${this.#path} (${String(error)})`);
      }
    }
  }

  #load(): Loaded<z.output<S>> {
    let text: string;
    try {
      text = readFileSync(this.#path, "utf8");
    } catch (error) {
      const code = (error as { code?: unknown } | undefined)?.code;
      return code === "ENOENT" ? { kind: "missing" } : { kind: "ioError" };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { kind: "notJson" };
    }
    const result = this.#schema.safeParse(raw);
    return result.success ? { kind: "ok", value: result.data } : { kind: "json", raw };
  }

  #backup(): boolean {
    const target = corruptBackupPath(this.#path);
    try {
      copyFileSync(this.#path, target);
      log.warn("store", `geçersiz dosya yedeklendi: ${this.#path} → ${target}`);
      return true;
    } catch (error) {
      log.warn("store", `geçersiz dosya yedeklenemedi: ${this.#path} (${String(error)})`);
      return false;
    }
  }

  get(): z.output<S> {
    return this.#value;
  }

  set(next: z.output<S>): z.output<S> {
    this.#value = this.#schema.parse(next);
    // Atomik yazım: yarı yazılmış JSON okunmasın (Windows'ta kilit hataları da yinelenir).
    // Klasörü `writeFileAtomic` kendisi açar.
    writeFileAtomic(this.#path, JSON.stringify(this.#value, null, 2));
    return this.#value;
  }

  update(patch: Record<string, unknown>): z.output<S> {
    const merged: Record<string, unknown> = { ...this.#value };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) merged[k] = v;
    return this.set(merged as z.output<S>);
  }
}
