import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Modül yalnız simge, dosya yöneticisi ve CLI açma için dışarıya dokunur; gerisi saf karardır.
const mocks = vi.hoisted(() => ({
  getFileIcon: vi.fn(async () => ({
    isEmpty: () => false,
    toDataURL: () => "data:image/png;base64,AA",
  })),
  openPath: vi.fn(async () => ""),
  execFile: vi.fn(
    (
      _file: string,
      _args: string[],
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => callback(null, "", ""),
  ),
  // Ayrık başlatma: sahte çocuk hemen "spawn" olayını verir.
  spawn: vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => {};
    queueMicrotask(() => child.emit("spawn"));
    return child;
  }),
}));

vi.mock("electron", () => ({
  app: { getFileIcon: mocks.getFileIcon },
  shell: { openPath: mocks.openPath },
}));
vi.mock("node:child_process", () => ({ execFile: mocks.execFile, spawn: mocks.spawn }));
vi.mock("./log.js", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { FILE_MANAGER_ID, expandArgs, listOpenWithApps, openWith, pngFromIcns } = await import(
  "./open-with.js"
);

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codezal-open-with-"));
  mocks.getFileIcon.mockReset();
  mocks.getFileIcon.mockResolvedValue({
    isEmpty: () => false,
    toDataURL: () => "data:image/png;base64,AA",
  });
  mocks.openPath.mockClear();
  mocks.execFile.mockClear();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("listOpenWithApps", () => {
  it("dosya yöneticisini ilk sıraya koyar ve kimlikleri tekrarlamaz", async () => {
    const apps = await listOpenWithApps();
    expect(apps[0]?.id).toBe(FILE_MANAGER_ID);
    expect(apps[0]?.kind).toBe("finder");
    const ids = apps.map((app) => app.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Kurulu olsun olmasın her satır ad taşır: menü etiketsiz öğe çizmez.
    expect(apps.every((app) => app.name.length > 0)).toBe(true);
  });

  it("simge okunamasa da satırlar düşmez, kimlikler değişmez", async () => {
    // Simge önbelleği modül düzeyinde; iki ölçüm taze modülle yapılır.
    vi.resetModules();
    const withIcons = await import("./open-with.js");
    const expected = (await withIcons.listOpenWithApps()).map((app) => app.id);

    vi.resetModules();
    // Hem icns hem `getFileIcon` yolu başarısız: menü yine aynı satırları taşır, simge null kalır.
    mocks.getFileIcon.mockRejectedValue(new Error("simge yok"));
    const withoutIcons = await import("./open-with.js");
    const apps = await withoutIcons.listOpenWithApps();

    expect(apps.map((app) => app.id)).toEqual(expected);
    expect(apps.every((app) => app.name.length > 0)).toBe(true);
  });
});

describe("pngFromIcns", () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([1, 2, 3]),
  ]);

  function icns(elements: Array<[string, Buffer]>): Buffer {
    const body = Buffer.concat(
      elements.map(([type, payload]) => {
        const head = Buffer.alloc(8);
        head.write(type, 0, "ascii");
        head.writeUInt32BE(payload.length + 8, 4);
        return Buffer.concat([head, payload]);
      }),
    );
    const header = Buffer.alloc(8);
    header.write("icns", 0, "ascii");
    header.writeUInt32BE(body.length + 8, 4);
    return Buffer.concat([header, body]);
  }

  it("tercih sırasına göre PNG öğesini seçer (ic11 > ic07)", () => {
    const bigger = Buffer.concat([png, Buffer.from([9])]);
    const data = icns([
      ["ic07", png],
      ["ic11", bigger],
    ]);
    expect(pngFromIcns(data)).toEqual(bigger);
  });

  it("PNG kodlu olmayan öğeyi atlar", () => {
    expect(pngFromIcns(icns([["ic04", Buffer.from([1, 2, 3, 4])]]))).toBeUndefined();
  });

  it("bozuk ya da kesik dosyada okuma taşmaz", () => {
    expect(pngFromIcns(Buffer.alloc(4))).toBeUndefined();
    expect(pngFromIcns(Buffer.from("RIFFxxxxxxxx"))).toBeUndefined();
    // Öğe uzunluğu dosyayı aşıyor: döngü kırılır, dışarı taşınmaz.
    const truncated = icns([["ic11", png]]).subarray(0, 12);
    expect(pngFromIcns(truncated)).toBeUndefined();
  });
});

describe("openWith", () => {
  it("dosya yöneticisinde klasörü açar", async () => {
    await openWith(FILE_MANAGER_ID, root);
    if (process.platform === "darwin" || process.platform === "win32") {
      expect(mocks.openPath).toHaveBeenCalledWith(root);
    } else {
      expect(mocks.execFile).toHaveBeenCalled();
    }
  });

  it("bilinmeyen uygulama kimliğini reddeder", async () => {
    await expect(openWith("boyle-bir-uygulama-yok", root)).rejects.toThrow(/bilinmeyen uygulama/);
  });

  it("klasör olmayan yolu ve olmayan yolu reddeder", async () => {
    const file = join(root, "a.txt");
    writeFileSync(file, "x");
    await expect(openWith(FILE_MANAGER_ID, file)).rejects.toThrow(/klasör bulunamadı/);
    await expect(openWith(FILE_MANAGER_ID, join(root, "yok"))).rejects.toThrow(/klasör bulunamadı/);
  });

  it("yolu uygulamadan önce doğrular", async () => {
    await expect(openWith("vscode", join(root, "yok"))).rejects.toThrow(/klasör bulunamadı/);
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
});

describe("expandArgs", () => {
  it("{cwd} yer tutucusunu değiştirir, boşluklu yolu tek argümanda korur", () => {
    expect(expandArgs(undefined, "/tmp/a b")).toEqual(["/tmp/a b"]);
    expect(expandArgs(["-d", "{cwd}"], "/tmp/a b")).toEqual(["-d", "/tmp/a b"]);
    expect(expandArgs(["--working-directory={cwd}"], "/tmp/x")).toEqual([
      "--working-directory=/tmp/x",
    ]);
  });

  it("yoldaki `$` dizilerini değiştirme kalıbı saymaz", () => {
    expect(expandArgs(["--directory={cwd}"], "/tmp/a$&b$'c")).toEqual(["--directory=/tmp/a$&b$'c"]);
  });
});
