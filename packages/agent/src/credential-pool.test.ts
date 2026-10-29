import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearConfigValueCache } from "./config-value.js";
import { CredentialPool } from "./credential-pool.js";

let root: string;
let clock = 1_000_000;
const now = () => clock;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codezal-pool-"));
  clock = 1_000_000;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  clearConfigValueCache();
});

const key = (k: string): Credential => ({ type: "api_key", key: k });

async function poolWith(...keys: string[]): Promise<CredentialPool> {
  const pool = new CredentialPool(join(root, "keys.json"), undefined, now);
  for (const k of keys) await pool.modify("p", async () => key(k));
  return pool;
}

async function activeKey(pool: CredentialPool): Promise<string | undefined> {
  const c = await pool.read("p");
  return c?.type === "api_key" ? c.key : undefined;
}

describe("CredentialPool", () => {
  it("modify ekler, aynı anahtarı çoğaltmaz, ilk yuva aktiftir", async () => {
    const pool = await poolWith("aaaa1111", "bbbb2222", "aaaa1111");
    expect(pool.slotCount("p")).toBe(2);
    expect(await activeKey(pool)).toBe("aaaa1111");
    expect(await pool.list()).toEqual([{ providerId: "p", type: "api_key" }]);
  });

  it("etiket ve son 4 hane dışında gizli değer sızdırmaz", async () => {
    const pool = await poolWith("");
    pool.add("p", "İş");
    await pool.modify("p", async () => key("sk-secret-7f2a"));
    const snap = pool.snapshot("p");
    expect(snap.map((s) => s.hint)).toEqual(["", "7f2a"]);
    expect(snap[1]?.label).toBe("İş");
    expect(JSON.stringify(snap)).not.toContain("secret");
  });

  it("markLimited aktif yuvayı soğutur ve sıradakine geçer; süre bitince geri döner", async () => {
    const pool = await poolWith("aaaa1111", "bbbb2222");
    const r = pool.markLimited("p", 5_000);
    expect(r?.from.hint).toBe("1111");
    expect(r?.to?.hint).toBe("2222");
    expect(await activeKey(pool)).toBe("bbbb2222");
    expect(pool.snapshot("p")[0]?.cooldownUntil).toBe(1_005_000);
    clock += 6_000;
    expect(await activeKey(pool)).toBe("aaaa1111");
    expect(pool.snapshot("p")[0]?.cooldownUntil).toBeNull();
  });

  it("hepsi doluysa en erken açılacak yuva denenir ve to null olur", async () => {
    const pool = await poolWith("aaaa1111", "bbbb2222");
    pool.markLimited("p", 10_000);
    clock += 6_000;
    const r = pool.markLimited("p", 10_000);
    expect(r?.to).toBeNull();
    expect(await activeKey(pool)).toBe("aaaa1111");
  });

  it("rotasyondan hemen sonraki ikinci hata yeni yuvayı soğutmaz", async () => {
    const pool = await poolWith("aaaa1111", "bbbb2222");
    pool.markLimited("p", 10_000);
    expect(pool.markLimited("p", 10_000)).toBeUndefined();
    expect(await activeKey(pool)).toBe("bbbb2222");
  });

  it("markHealthy sunulan yuvanın soğumasını siler", async () => {
    const pool = await poolWith("aaaa1111", "bbbb2222");
    pool.markLimited("p", 10_000);
    pool.markLimited("p", 10_000);
    clock += 6_000;
    pool.markLimited("p", 10_000);
    await pool.read("p");
    pool.markHealthy("p");
    expect(pool.snapshot("p").some((s) => s.cooldownUntil === null)).toBe(true);
  });

  it("activate başa alır; remove aktif silinince sıradakini aktif yapar; delete hepsini siler", async () => {
    const pool = await poolWith("aaaa1111", "bbbb2222", "cccc3333");
    const [a, b] = pool.snapshot("p");
    if (!a || !b) throw new Error("yuva yok");
    pool.activate("p", b.id);
    expect(await activeKey(pool)).toBe("bbbb2222");
    expect(pool.remove("p", b.id)).toEqual({ remaining: 2 });
    expect(await activeKey(pool)).toBe("aaaa1111");
    await pool.delete("p");
    expect(pool.slotCount("p")).toBe(0);
    expect(await pool.read("p")).toBeUndefined();
  });

  it("oauth kimliğini yerinde yeniler, undefined dönünce değiştirmez", async () => {
    const pool = new CredentialPool(join(root, "keys.json"), undefined, now);
    const oauth: Credential = { type: "oauth", refresh: "r1", access: "a1", expires: 1 };
    await pool.modify("p", async () => oauth);
    const same = await pool.modify("p", async () => undefined);
    expect(same).toEqual(oauth);
    await pool.modify("p", async (cur) =>
      cur?.type === "oauth" ? { ...cur, access: "a2" } : undefined,
    );
    expect(pool.slotCount("p")).toBe(1);
    expect(await pool.read("p")).toMatchObject({ access: "a2" });
  });

  it("soğuma dosyada kalır, dosya 0600 yazılır", async () => {
    const pool = await poolWith("aaaa1111", "bbbb2222");
    pool.markLimited("p", 60_000);
    const again = new CredentialPool(join(root, "keys.json"), undefined, now);
    expect(await activeKey(again)).toBe("bbbb2222");
    if (process.platform !== "win32")
      expect(statSync(join(root, "keys.json")).mode & 0o777).toBe(0o600);
  });

  it("dosya elle düzenlenince yeniden okur ve üzerine yazmaz", async () => {
    const path = join(root, "keys.json");
    const pool = await poolWith("aaaa1111");
    // Kullanıcı Ayarlar'dan keys.json'u açıp elle ikinci anahtarı ekliyor.
    const file = JSON.parse(readFileSync(path, "utf8")) as {
      version: 1;
      providers: Record<string, { slots: unknown[] }>;
    };
    file.providers.p?.slots.push({
      id: "manual",
      label: "Elle",
      credential: key("dddd4444"),
      addedAt: 1,
    });
    // mtime damgası değişsin (aynı milisaniyede yazmayı önler).
    clock += 1;
    writeFileSync(path, JSON.stringify(file));
    expect(pool.slotCount("p")).toBe(2);
    expect(pool.snapshot("p").map((k) => k.hint)).toEqual(["1111", "4444"]);

    // Sonraki yazma elle eklenen anahtarı silmemeli.
    pool.markLimited("p", 5_000);
    expect(await activeKey(pool)).toBe("dddd4444");
    const written = JSON.parse(readFileSync(path, "utf8")) as {
      providers: Record<string, { slots: { id: string }[] }>;
    };
    expect(written.providers.p?.slots.map((x) => x.id)).toContain("manual");
  });

  it("auth.json'dan bir kez geçirir", async () => {
    const auth = join(root, "auth.json");
    writeFileSync(auth, JSON.stringify({ p: key("zzzz9999"), q: key("yyyy8888") }));
    const pool = new CredentialPool(join(root, "keys.json"), auth, now);
    expect(await activeKey(pool)).toBe("zzzz9999");
    expect(pool.slotCount("q")).toBe(1);
    expect(existsSync(join(root, "keys.json"))).toBe(true);
    expect(JSON.parse(readFileSync(auth, "utf8"))).toHaveProperty("p");
    // keys.json varken auth.json bir daha okunmaz
    writeFileSync(auth, JSON.stringify({ r: key("xxxx7777") }));
    expect(new CredentialPool(join(root, "keys.json"), auth, now).slotCount("r")).toBe(0);
  });
});

describe("CredentialPool — referanslı kimlikler", () => {
  const ref = (value: string, env?: Record<string, string>): Credential =>
    env ? { type: "api_key", key: value, env } : { type: "api_key", key: value };

  async function poolWithCredential(credential: Credential): Promise<CredentialPool> {
    const pool = new CredentialPool(join(root, "keys.json"), undefined, now);
    await pool.modify("p", async () => credential);
    return pool;
  }

  it("env referansını read'de çözer; hint boş, kind/reference dolu", async () => {
    const pool = await poolWithCredential(
      ref("$CODEZAL_POOL_KEY", { CODEZAL_POOL_KEY: "çözülen-değer" }),
    );
    expect(await activeKey(pool)).toBe("çözülen-değer");
    const slot = pool.snapshot("p")[0];
    expect(slot?.kind).toBe("env");
    expect(slot?.hint).toBe("");
    expect(slot?.reference).toBe("$CODEZAL_POOL_KEY");
    expect(slot?.envMissing).toBeUndefined();
  });

  it("çok parçalı şablonu çözer", async () => {
    const pool = await poolWithCredential(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: şablon sentaksı kasıtlı olarak test ediliyor
      ref("Bearer ${CODEZAL_POOL_TOKEN}", { CODEZAL_POOL_TOKEN: "abc" }),
    );
    expect(await activeKey(pool)).toBe("Bearer abc");
  });

  it("komut referansını read'de çözer", async () => {
    const pool = await poolWithCredential(ref("!echo codezal-keychain"));
    expect(await activeKey(pool)).toBe("codezal-keychain");
    const slot = pool.snapshot("p")[0];
    expect(slot?.kind).toBe("command");
    expect(slot?.reference).toBe("!echo codezal-keychain");
    expect(slot?.hint).toBe("");
  });

  it("çözülemeyen referansta read undefined döner ve envMissing görünür", async () => {
    const pool = await poolWithCredential(ref("$CODEZAL_POOL_YOK_BOYLE"));
    expect(await pool.read("p")).toBeUndefined();
    expect(pool.snapshot("p")[0]?.envMissing).toBe(true);
  });

  it("düz anahtar etkilenmez", async () => {
    const pool = await poolWithCredential(ref("sk-duz-1234"));
    expect(pool.snapshot("p")[0]?.kind).toBe("key");
    expect(pool.snapshot("p")[0]?.hint).toBe("1234");
    expect(pool.snapshot("p")[0]?.reference).toBeUndefined();
    expect(await activeKey(pool)).toBe("sk-duz-1234");
  });

  it("$ içeren literal referans sayılmaz", async () => {
    const literal = await poolWithCredential(ref("fiyat-100$-son"));
    expect(literal.snapshot("p")[0]?.kind).toBe("key");
    expect(await activeKey(literal)).toBe("fiyat-100$-son");
  });

  it("rotasyonda referanslı yuvanın hint'i boş kalır", async () => {
    const pool = new CredentialPool(join(root, "keys.json"), undefined, now);
    await pool.modify("p", async () => ref("$CODEZAL_POOL_KEY", { CODEZAL_POOL_KEY: "x" }));
    await pool.modify("p", async () => ref("yedek-anahtar-9999"));
    const r = pool.markLimited("p", 5_000);
    expect(r?.from.hint).toBe("");
    expect(r?.to?.hint).toBe("9999");
  });
});

describe("CredentialPool — auth.json aynası", () => {
  const authPath = () => join(root, "auth.json");
  const readAuth = () => JSON.parse(readFileSync(authPath(), "utf8")) as Record<string, Credential>;

  it("ekleme aktif anahtarı auth.json'a aynalar; dosya 0600", async () => {
    const pool = new CredentialPool(join(root, "keys.json"), authPath(), now);
    await pool.modify("p", async () => key("sk-ayna-1111"));
    expect(readAuth()).toEqual({ p: key("sk-ayna-1111") });
    if (process.platform !== "win32") expect(statSync(authPath()).mode & 0o777).toBe(0o600);
  });

  it("rotasyon aynayı yeni aktif anahtarla günceller", async () => {
    const pool = new CredentialPool(join(root, "keys.json"), authPath(), now);
    await pool.modify("p", async () => key("aaaa1111"));
    await pool.modify("p", async () => key("bbbb2222"));
    pool.markLimited("p", 5_000);
    expect(readAuth()).toEqual({ p: key("bbbb2222") });
  });

  it("silme aynadan da düşürür; boş havuz aynayı temizler", async () => {
    const pool = new CredentialPool(join(root, "keys.json"), authPath(), now);
    await pool.modify("p", async () => key("aaaa1111"));
    await pool.delete("p");
    expect(readAuth()).toEqual({});
  });

  it("referanslı yuva ham hâliyle aynalanır (çözüm okuma anında)", async () => {
    const pool = new CredentialPool(join(root, "keys.json"), authPath(), now);
    await pool.modify("p", async () => ({ type: "api_key", key: "$AYNA_POOL_KEY" }));
    expect(readAuth()).toEqual({ p: { type: "api_key", key: "$AYNA_POOL_KEY" } });
  });

  it("boş havuzda açılış auth dosyasını oluşturmaz", () => {
    new CredentialPool(join(root, "keys.json"), authPath(), now);
    expect(existsSync(authPath())).toBe(false);
  });

  it("auth.json'dan göç eden havuz aynayı aynı içerikle tazeler", () => {
    writeFileSync(authPath(), JSON.stringify({ q: key("yyyy8888") }));
    const pool = new CredentialPool(join(root, "keys.json"), authPath(), now);
    expect(pool.slotCount("q")).toBe(1);
    expect(readAuth()).toEqual({ q: key("yyyy8888") });
  });

  it("bozuk keys.json'u yedekleyip auth.json'dan kurtarır", async () => {
    const keys = join(root, "keys.json");
    writeFileSync(keys, "{ bozuk");
    writeFileSync(authPath(), JSON.stringify({ p: key("zzzz9999") }));
    const pool = new CredentialPool(keys, authPath(), now);
    expect(await activeKey(pool)).toBe("zzzz9999");
    expect(readdirSync(root).some((f) => f.startsWith("keys.json.corrupt-"))).toBe(true);
  });
});
