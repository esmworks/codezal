import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { linkedWorktree, ProjectStore } from "./projects";

const dir = mkdtempSync(join(tmpdir(), "cz-projects-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("ProjectStore", () => {
  it("touch güven kararını ve parmak izini korur, setTrusted yalnızca kayıtlı projede işler", () => {
    const store = new ProjectStore(dir);
    const a = join(dir, "a");
    mkdirSync(a);
    expect(store.setTrusted(a, true)).toBeUndefined();
    store.touch(a, "abc");
    expect(store.setTrusted(a, true)?.trusted).toBe(true);
    const again = store.touch(a);
    expect(again).toMatchObject({ trusted: true, fingerprint: "abc", name: "a" });
    expect(store.isTrusted(a)).toBe(true);
    // Projenin altındaki klasör (worktree) de güvenilir; ad uzantısı değil.
    expect(store.isTrusted(join(a, ".worktrees", "dal"))).toBe(true);
    expect(store.isTrusted(`${a}2`)).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "projects.json"), "utf8")).recent[0].trusted).toBe(
      true,
    );
  });

  it("taşınan projeyi parmak iziyle bulur ve kaydı yeni yola geçirir", () => {
    const store = new ProjectStore(dir);
    const old = join(dir, "eski");
    const neu = join(dir, "yeni");
    mkdirSync(old);
    store.touch(old, "fp1");
    store.setTrusted(old, true);
    rmSync(old, { recursive: true });
    mkdirSync(neu);
    // Yolu var olan kayıt "taşınmış" sayılmaz; kaybolan ve parmak izi eşleşen bulunur.
    expect(store.findMoved("fp1", neu)?.path).toBe(old);
    expect(store.findMoved("fp2", neu)).toBeUndefined();
    store.relocate(old, neu);
    expect(store.get(old)).toBeUndefined();
    expect(store.get(neu)).toMatchObject({ trusted: true, fingerprint: "fp1", name: "yeni" });
    expect(store.recent().map((p) => p.path)).toContain(neu);
  });

  it("touch kayıtlı projenin sırasını korur, yeniyi başa ekler", () => {
    const d = join(dir, "sira");
    mkdirSync(d, { recursive: true });
    const store = new ProjectStore(d);
    const [a, b, c] = [join(d, "a"), join(d, "b"), join(d, "c")];
    for (const p of [a, b, c]) mkdirSync(p);
    store.touch(a);
    store.touch(b);
    store.touch(c);
    expect(store.recent().map((p) => p.name)).toEqual(["c", "b", "a"]);
    // Kayıtlı projeyi yeniden açmak sırasını değiştirmez.
    store.touch(a);
    expect(store.recent().map((p) => p.name)).toEqual(["c", "b", "a"]);
  });

  it("proje dışındaki köke açılan worktree güveni ana depodan alır", () => {
    const d = join(dir, "wt-guven");
    mkdirSync(d, { recursive: true });
    const store = new ProjectStore(d);
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
    const [a, b] = [join(d, "a"), join(d, "b")];
    for (const p of [a, b]) {
      mkdirSync(p);
      git(p, "init", "-q", "-b", "main");
      git(p, "commit", "-q", "--allow-empty", "-m", "ilk");
    }
    store.touch(a);
    store.touch(b);
    store.setTrusted(a, true);
    const [wa, wb] = [join(d, "kok", "wa"), join(d, "kok", "wb")];
    git(a, "worktree", "add", "-q", "-b", "wa", wa);
    git(b, "worktree", "add", "-q", "-b", "wb", wb);
    expect(linkedWorktree(join(wa, "alt"))?.worktree).toBe(wa);
    expect(linkedWorktree(a)).toBeUndefined();
    expect(store.isTrusted(wa)).toBe(true);
    // Güvenilmeyen projenin worktree'si güvenilir sayılmaz.
    expect(store.isTrusted(wb)).toBe(false);
  });

  it("reorder manuel sırayı yazar, listede olmayanları sonda tutar", () => {
    const d = join(dir, "reorder");
    mkdirSync(d, { recursive: true });
    const store = new ProjectStore(d);
    const [a, b, c, gizli] = [join(d, "a"), join(d, "b"), join(d, "c"), join(d, "gizli")];
    for (const p of [a, b, c, gizli]) mkdirSync(p);
    for (const p of [a, b, c, gizli]) store.touch(p);
    // Görünen üç klasörün sırası değişir; gizli kaydın göreli yeri korunur.
    expect(store.reorder([c, a, b]).map((p) => p.name)).toEqual(["c", "a", "b", "gizli"]);
    // Sıra kalıcı: yeni bir okuma aynı listeyi verir.
    expect(new ProjectStore(d).recent().map((p) => p.name)).toEqual(["c", "a", "b", "gizli"]);
  });
});
