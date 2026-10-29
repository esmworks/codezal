import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitStatus } from "@codezal/contracts";
import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWorktreeName,
  applyWorktree,
  badges,
  branches,
  cleanupWorktree,
  commit,
  createWorktree,
  heuristicMessage,
  isManagedWorktree,
  removeWorktree,
  rootCommit,
  status,
} from "./git";

const st = (files: GitStatus["files"]): GitStatus => ({
  isRepo: true,
  branch: "main",
  ahead: 0,
  behind: 0,
  hasRemote: false,
  files,
  additions: 0,
  deletions: 0,
});

describe("heuristicMessage", () => {
  it("boş listede boş döner", () => {
    expect(heuristicMessage(st([]), "conventional")).toBe("");
  });
  it("tek yeni dosya → feat ekle", () => {
    const m = heuristicMessage(
      st([
        {
          path: "src/a.ts",
          status: "A",
          renamedFrom: null,
          staged: false,
          additions: 3,
          deletions: 0,
        },
      ]),
      "conventional",
    );
    expect(m.startsWith("feat: a.ts ekle")).toBe(true);
    expect(m).toContain("- A src/a.ts");
  });
  it("kısa biçim tek satır", () => {
    const m = heuristicMessage(
      st([
        { path: "a", status: "M", renamedFrom: null, staged: false, additions: 1, deletions: 1 },
        { path: "b", status: "M", renamedFrom: null, staged: false, additions: 1, deletions: 1 },
      ]),
      "short",
    );
    expect(m).toBe("2 dosya güncelle");
  });
});

describe("git status (gerçek depo)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cz-git-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("git olmayan klasörde isRepo=false", async () => {
    expect((await status(dir)).isRepo).toBe(false);
    expect(await branches(dir)).toEqual([]);
  });

  it("değişen dosyaları rozetler ve commit atar", async () => {
    const git = simpleGit(dir);
    await git.init();
    await git.addConfig("user.email", "t@t");
    await git.addConfig("user.name", "t");
    writeFileSync(join(dir, "a.txt"), "1\n2\n");
    await git.add(["a.txt"]);
    await git.commit("ilk");
    writeFileSync(join(dir, "a.txt"), "1\n3\n4\n");
    writeFileSync(join(dir, "b.txt"), "yeni\n");
    const s = await status(dir);
    expect(s.isRepo).toBe(true);
    expect(s.files.map((f) => [f.path, f.status])).toEqual([
      ["a.txt", "M"],
      ["b.txt", "?"],
    ]);
    // İzlenmeyen dosyanın satır sayısı çalışma klasörüne göre sayılır (Windows'ta `--no-index`
    // çalışmazsa yedek yol da doğru sonucu vermeli).
    expect(s.files.find((f) => f.path === "b.txt")?.additions).toBe(1);
    expect(s.additions).toBeGreaterThan(0);
    const b = await badges(dir);
    expect(b.get("a.txt")).toBe("M");
    const r = await commit(dir, "test: iki dosya", true);
    expect(r.hash.length).toBeGreaterThan(6);
    expect((await status(dir)).files).toEqual([]);
  }, 20_000);

  it("rootCommit ilk commit'i döner; depo değilse ya da klasör yoksa yok", async () => {
    const git = simpleGit(dir);
    const first = (await git.raw(["rev-list", "--max-parents=0", "HEAD"])).trim();
    expect(first).toMatch(/^[0-9a-f]{40}$/);
    expect(await rootCommit(dir)).toBe(first);
    expect(await rootCommit(join(dir, "yok"))).toBeUndefined();
    expect(await rootCommit(tmpdir())).toBeUndefined();
  }, 20_000);
});

describe("worktree (gerçek depo)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cz-wt-"));
  const repo = join(dir, "repo");
  const git = simpleGit({ baseDir: dir });
  const branchNames = async () => (await simpleGit(repo).branchLocal()).all;
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  beforeAll(async () => {
    mkdirSync(repo);
    await git.cwd(repo);
    await git.raw(["init", "-q", "-b", "main"]);
    await git.addConfig("user.email", "t@t");
    await git.addConfig("user.name", "t");
    writeFileSync(join(repo, "a.txt"), "1\n");
    await git.add(["a.txt"]);
    await git.commit("ilk");
  });

  it("depo içindeki kök yerel dışlamaya bir kez yazılır, ana depo temiz kalır", async () => {
    const first = await createWorktree(repo, undefined);
    await createWorktree(repo, undefined);
    expect(first.path.startsWith(join(repo, ".worktrees"))).toBe(true);
    const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((line) => line === "/.worktrees/")).toHaveLength(1);
    // Kök izlenmeyen klasör olarak görünmez; "tümünü ekle" worktree'yi gömülü depo yapamaz.
    expect((await status(repo)).files).toEqual([]);
  }, 20_000);

  it("birleştirilmemiş dal kalır ve aynı ad yeniden istenince sayı eklenir", async () => {
    const wt = await createWorktree(repo, undefined, "dal");
    writeFileSync(join(wt.path, "yeni.txt"), "x\n");
    await simpleGit(wt.path).add(["yeni.txt"]).commit("dalda iş");
    await removeWorktree(repo, wt.path, { deleteBranch: true });
    expect(existsSync(wt.path)).toBe(false);
    expect(await branchNames()).toContain("dal");
    const again = await createWorktree(repo, undefined, "dal");
    expect(again.branch).toBe("dal-2");
  }, 20_000);

  it("birleştirilmiş dal worktree ile birlikte silinir", async () => {
    const wt = await createWorktree(repo, undefined, "temiz");
    await removeWorktree(repo, wt.path, { deleteBranch: true });
    expect(await branchNames()).not.toContain("temiz");
  }, 20_000);

  it("temizlik yalnız kaybolacak iş yoksa kaldırır", async () => {
    const empty = await createWorktree(repo, undefined, "bos");
    expect(isManagedWorktree(empty.path, undefined)).toBe(true);
    expect(await cleanupWorktree(empty.path, undefined)).toBe(true);
    expect(existsSync(empty.path)).toBe(false);
    expect(await branchNames()).not.toContain("bos");
    const dirty = await createWorktree(repo, undefined, "kirli");
    writeFileSync(join(dirty.path, "yarim.txt"), "x\n");
    expect(await cleanupWorktree(dirty.path, undefined)).toBe(false);
    expect(existsSync(dirty.path)).toBe(true);
    // Ana depo Codezal worktree'si değildir; temizlik ona hiç dokunmaz.
    expect(await cleanupWorktree(repo, undefined)).toBe(false);
  }, 20_000);

  it("uygulama değişikliği ana dala birleştirir", async () => {
    const wt = await createWorktree(repo, undefined, "uygula");
    writeFileSync(join(wt.path, "b.txt"), "b\n");
    await applyWorktree(repo, wt.path);
    expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("b\n");
  }, 20_000);

  it("çakışmada birleştirme geri alınır, ana depo yarıda kalmaz", async () => {
    const wt = await createWorktree(repo, undefined, "catisma");
    writeFileSync(join(repo, "a.txt"), "ana\n");
    await simpleGit(repo).add(["a.txt"]).commit("ana değişiklik");
    writeFileSync(join(wt.path, "a.txt"), "worker\n");
    await expect(applyWorktree(repo, wt.path)).rejects.toThrow();
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("ana\n");
    // Worker'ın işi kendi dalında commit'li durur; kullanıcı elle birleştirebilir.
    expect(existsSync(wt.path)).toBe(true);
  }, 20_000);
});

describe("agentWorktreeName", () => {
  it("Türkçe başlığı ASCII dal adına çevirir, kimlik kuyruğunu ekler", () => {
    expect(agentWorktreeName("bol.js hatasını düzelt", "run-mfx1-cyr91")).toBe(
      "ajan-bol-js-hatasini-duzelt-cyr91",
    );
    expect(agentWorktreeName("Çağrı şöyle ÖĞÜŞ", "run-a-2")).toBe("ajan-cagri-soyle-ogus-runa2");
  });

  it("başlık boşalırsa yalnız önek ve kuyruk kalır", () => {
    expect(agentWorktreeName("!!! ???", "run-x-7")).toBe("ajan-runx7");
    expect(agentWorktreeName("日本語", "run-x-7")).toMatch(/^ajan-runx7$/);
  });
});
