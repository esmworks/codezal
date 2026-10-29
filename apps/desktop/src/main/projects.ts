import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { writeFileAtomic } from "@codezal/agent";
import { ProjectRef } from "@codezal/contracts";
import { z } from "zod";

const File = z.object({ recent: z.array(ProjectRef).default([]) });

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Bağlı worktree'nin kökü ve ana deposu. Worktree kökündeki `.git` bir dosyadır
 * (`gitdir: <ortak>/worktrees/<ad>`), ortak klasör `commondir` kaydından bulunur. Eşzamanlıdır:
 * güven kararı oturum açılırken beklemeden verilir. Worktree değilse (alt modül, sıradan depo,
 * okunamayan kayıt) undefined.
 */
export function linkedWorktree(cwd: string): { worktree: string; main: string } | undefined {
  let dir = resolve(cwd);
  for (;;) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      try {
        if (!statSync(dotGit).isFile()) return undefined;
        const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
        if (!gitdir) return undefined;
        const own = resolve(dir, gitdir);
        const common = resolve(own, readFileSync(join(own, "commondir"), "utf8").trim());
        return basename(common) === ".git" ? { worktree: dir, main: dirname(common) } : undefined;
      } catch {
        return undefined;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Son kullanılan projeler (projects.json). Kayıt yolu silinmiş projeleri de tutar: parmak izi
 * (git kök commit'i) eşleşen yeni bir klasör açılınca oturum ve bellek oraya taşınır.
 */
export class ProjectStore {
  readonly #path: string;
  #recent: ProjectRef[] = [];

  constructor(userData: string) {
    this.#path = join(userData, "projects.json");
    try {
      this.#recent = File.parse(JSON.parse(readFileSync(this.#path, "utf8"))).recent;
    } catch {
      this.#recent = [];
    }
  }

  recent(): ProjectRef[] {
    return this.#recent.filter((p) => existsSync(p.path));
  }

  /** Kayıt (yolu silinmiş olsa da). */
  get(path: string): ProjectRef | undefined {
    return this.#recent.find((p) => p.path === path);
  }

  /** Klasörü listeden çıkarır; disk ve oturum dosyalarına dokunmaz. */
  forget(path: string): void {
    this.#recent = this.#recent.filter((p) => p.path !== path);
    this.#save();
  }

  /** Güven kararı ve parmak izi korunur (parmak izi verilirse güncellenir). */
  touch(path: string, fingerprint?: string): ProjectRef {
    const prev = this.get(path);
    const ref: ProjectRef = {
      ...prev,
      path,
      name: basename(path),
      isGit: existsSync(join(path, ".git")),
      lastOpenedAt: Date.now(),
      ...(fingerprint ? { fingerprint } : {}),
    };
    // Sıra artık kullanıcının: kayıtlı proje yerinde kalır, yalnız yeni proje başa eklenir.
    this.#recent = prev
      ? this.#recent.map((p) => (p.path === path ? ref : p))
      : [ref, ...this.#recent].slice(0, 20);
    this.#save();
    return ref;
  }

  /**
   * Manuel sıra: bilinen yollar verilen sıraya göre dizilir, listede geçmeyenler (gizli/görünmeyen
   * klasörler) orijinal göreli konumunda kalır. Yeni sıralı listeyi döner.
   */
  reorder(paths: string[]): ProjectRef[] {
    const rank = new Map(paths.map((p, i) => [p, i]));
    this.#recent = [...this.#recent].sort(
      (a, b) => (rank.get(a.path) ?? paths.length) - (rank.get(b.path) ?? paths.length),
    );
    this.#save();
    return this.recent();
  }

  /** Güven kararı; yalnızca kayıtlı projede işlenir. */
  setTrusted(path: string, trusted: boolean): ProjectRef | undefined {
    const prev = this.get(path);
    if (!prev) return undefined;
    const ref = { ...prev, trusted };
    this.#recent = this.#recent.map((p) => (p.path === path ? ref : p));
    this.#save();
    return ref;
  }

  /**
   * Açıkça güvenilen proje ya da onun altındaki bir klasör (ör. `.worktrees/<dal>`). Proje dışındaki
   * bir köke açılan worktree güveni ana depodaki karşılığından alır.
   */
  isTrusted(cwd: string): boolean {
    if (this.#trustedPath(cwd, (path) => path)) return true;
    const link = linkedWorktree(cwd);
    if (!link) return false;
    // Git ana depo yolunu çözülmüş hâliyle yazar (macOS'ta `/private/tmp`); proje yolu da çözülür.
    return this.#trustedPath(join(link.main, relative(link.worktree, cwd)), realPath);
  }

  #trustedPath(cwd: string, norm: (path: string) => string): boolean {
    return this.#recent.some((p) => {
      if (p.trusted !== true) return false;
      const root = norm(p.path);
      return cwd === root || cwd.startsWith(root + sep);
    });
  }

  /** Yolu artık var olmayan, parmak izi eşleşen kayıt: klasör taşınmış ya da yeniden adlanmış. */
  findMoved(fingerprint: string, exceptPath: string): ProjectRef | undefined {
    return this.#recent.find(
      (p) => p.fingerprint === fingerprint && p.path !== exceptPath && !existsSync(p.path),
    );
  }

  /** Taşınan projenin kaydını yeni yola geçirir (güven ve parmak izi korunur). */
  relocate(from: string, to: string): void {
    const prev = this.get(from);
    if (!prev) return;
    this.#recent = this.#recent
      .filter((p) => p.path !== to)
      .map((p) => (p.path === from ? { ...p, path: to, name: basename(to) } : p));
    this.#save();
  }

  #save(): void {
    // Atomik: yazım yarıda kesilirse (çökme, disk dolu) güven kararları ve son projeler listesi
    // yarım JSON yüzünden tümden kaybolmasın.
    writeFileAtomic(this.#path, JSON.stringify({ recent: this.#recent }, null, 2));
  }
}
