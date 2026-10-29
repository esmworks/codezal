import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";
import {
  beginTurnSnapshot,
  forgetTurnSnapshot,
  rewindTurnSnapshots,
  sealTurnSnapshot,
  undoTurn,
} from "./turn-backup";

let dir: string;

async function repo(): Promise<string> {
  dir = mkdtempSync(join(tmpdir(), "cz-turn-"));
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig("user.email", "test@example.com");
  await git.addConfig("user.name", "Test");
  writeFileSync(join(dir, "a.txt"), "bir\n");
  await git.add("a.txt");
  await git.commit("ilk");
  return dir;
}

/** Bir turu baştan sona koşturur: kaydı açar, gövdeyi çalıştırır, kaydı mühürler. */
async function turn(
  sessionId: string,
  cwd: string,
  ordinal: number,
  body: () => void | Promise<void>,
): Promise<void> {
  await beginTurnSnapshot(sessionId, cwd);
  await body();
  await sealTurnSnapshot(sessionId, cwd, ordinal);
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("tur kaydı (turn-backup)", () => {
  it("turda değişeni geri alır, turda oluşanı siler, tur öncesini korur", async () => {
    const cwd = await repo();
    // Tur öncesi: izlenmeyen dosya ve kullanıcının kendi değişikliği korunmalı.
    writeFileSync(join(cwd, "onceki.txt"), "önce\n");
    writeFileSync(join(cwd, "a.txt"), "kullanıcı değişikliği\n");
    await turn("s1", cwd, 1, async () => {
      // Tur içinde: a.txt değişti, iki yeni dosya oluştu (biri staged).
      writeFileSync(join(cwd, "a.txt"), "tur değişikliği\n");
      writeFileSync(join(cwd, "yeni.txt"), "yeni\n");
      writeFileSync(join(cwd, "staged.txt"), "staged\n");
      await simpleGit(cwd).add("staged.txt");
    });

    const result = await undoTurn("s1", cwd, 1);
    expect(result.restored).toContain("a.txt");
    expect(result.removed.sort()).toEqual(["staged.txt", "yeni.txt"]);
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("kullanıcı değişikliği\n");
    expect(existsSync(join(cwd, "yeni.txt"))).toBe(false);
    expect(existsSync(join(cwd, "staged.txt"))).toBe(false);
    expect(readFileSync(join(cwd, "onceki.txt"), "utf8")).toBe("önce\n");
    // Index'te de iz kalmamalı.
    const status = await simpleGit(cwd).raw(["status", "--porcelain"]);
    expect(status).not.toContain("staged.txt");
  });

  it("tur öncesi temiz ağaçta HEAD'e döner", async () => {
    const cwd = await repo();
    await turn("s2", cwd, 1, () => {
      writeFileSync(join(cwd, "a.txt"), "değişti\n");
    });
    const result = await undoTurn("s2", cwd, 1);
    expect(result.restored).toContain("a.txt");
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("bir\n");
  });

  it("kayıt yoksa boş döner (dosya yedeklerine düşülür)", async () => {
    const cwd = await repo();
    expect(await undoTurn("yok", cwd, 1)).toEqual({ restored: [], removed: [], outside: [] });
  });

  it("turda silinen dosyayı geri getirir", async () => {
    const cwd = await repo();
    await turn("s4", cwd, 1, () => {
      rmSync(join(cwd, "a.txt"));
    });
    const result = await undoTurn("s4", cwd, 1);
    expect(result.restored).toContain("a.txt");
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("bir\n");
  });

  it("git deposu olmayan klasörde kayıt tutmaz", async () => {
    dir = mkdtempSync(join(tmpdir(), "cz-turn-nogit-"));
    await turn("s3", dir, 1, () => undefined);
    expect(await undoTurn("s3", dir, 1)).toEqual({ restored: [], removed: [], outside: [] });
  });

  /**
   * Regresyon: kayıt eskiden oturum başına tekti ve her turda üzerine yazılıyordu. Eski bir turu
   * geri almak **son** turun kaydını kullanıyor, yani son turun çalışmasını siliyor ve istenen
   * turun değişikliğini yerinde bırakıyordu — tam ters sonuç.
   */
  it("eski turu geri alırken sonraki turun çalışmasına dokunmaz", async () => {
    const cwd = await repo();
    await turn("s5", cwd, 1, () => {
      writeFileSync(join(cwd, "a.txt"), "tur1\n");
      writeFileSync(join(cwd, "tur1.txt"), "tur1\n");
    });
    await turn("s5", cwd, 2, () => {
      writeFileSync(join(cwd, "b.txt"), "tur2\n");
    });

    const result = await undoTurn("s5", cwd, 1);

    // Tur 1 geri alındı: değişikliği ve oluşturduğu dosya gitti.
    expect(result.restored).toContain("a.txt");
    expect(result.removed).toContain("tur1.txt");
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("bir\n");
    expect(existsSync(join(cwd, "tur1.txt"))).toBe(false);
    // Tur 2 duruyor: onun dosyası silinmedi.
    expect(readFileSync(join(cwd, "b.txt"), "utf8")).toBe("tur2\n");
    expect(result.removed).not.toContain("b.txt");
  });

  it("son turu geri alırken önceki turun çalışmasını korur", async () => {
    const cwd = await repo();
    await turn("s6", cwd, 1, () => {
      writeFileSync(join(cwd, "a.txt"), "tur1\n");
    });
    await turn("s6", cwd, 2, () => {
      writeFileSync(join(cwd, "b.txt"), "tur2\n");
    });

    const result = await undoTurn("s6", cwd, 2);

    expect(result.removed).toContain("b.txt");
    expect(existsSync(join(cwd, "b.txt"))).toBe(false);
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("tur1\n");
  });

  /**
   * Tur sırasında teslim edilen yönlendirmeler kullanıcı sayısını birden fazla artırır; kayıt
   * aralığı kapsadığı için aradaki sıralar da aynı tura çözülür.
   */
  it("tur içi yönlendirmenin sırası da aynı tura çözülür", async () => {
    const cwd = await repo();
    await turn("s7", cwd, 3, () => {
      writeFileSync(join(cwd, "a.txt"), "tur1\n");
    });

    expect((await undoTurn("s7", cwd, 2)).restored).toContain("a.txt");
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("bir\n");
  });

  it("mühürlenmemiş kayıt geri almada kullanılmaz", async () => {
    const cwd = await repo();
    await beginTurnSnapshot("s8", cwd);
    writeFileSync(join(cwd, "a.txt"), "yarım tur\n");
    expect(await undoTurn("s8", cwd, 1)).toEqual({ restored: [], removed: [], outside: [] });
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("yarım tur\n");
  });

  /**
   * Regresyon: geri sarma dalı keser ama kayıtlar kalırsa `sealed` eski değerde kalır ve yeni
   * turun kapsamı boş çıkar; "Geri al" atılmış eski turun kaydına düşerdi.
   */
  it("geri sarma sonrası yeni turun kaydı doğru aralığa düşer", async () => {
    const cwd = await repo();
    await turn("s10", cwd, 1, () => {
      writeFileSync(join(cwd, "a.txt"), "tur1\n");
    });
    await turn("s10", cwd, 2, () => {
      writeFileSync(join(cwd, "b.txt"), "tur2\n");
    });

    // Kullanıcı 2. kullanıcı mesajının öncesine geri sarar: 2. tur artık yok.
    rewindTurnSnapshots("s10", 2);
    // Yeni 2. tur (geri sarma sonrası) yalnız c.txt'yi değiştirir.
    await turn("s10", cwd, 2, () => {
      writeFileSync(join(cwd, "c.txt"), "yeni\n");
    });

    const result = await undoTurn("s10", cwd, 2);

    // Yeni turun dosyası gider; atılmış eski turun b.txt'si geri gelmez/geri alınmaz.
    expect(result.removed).toContain("c.txt");
    expect(result.removed).not.toContain("b.txt");
    expect(existsSync(join(cwd, "c.txt"))).toBe(false);
    expect(readFileSync(join(cwd, "b.txt"), "utf8")).toBe("tur2\n");
  });

  /**
   * Regresyon: `run_start`/`run_end` dinleyicileri iki adımı beklemeden başlatır. `begin` git
   * komutlarını bitirmeden tur biterse `seal` boş dönüyor, geç açılan kayıt sonraki turun mührünü
   * alıp iki turu tek kayıtta topluyordu: 1. turu geri almak 2. turun dosyasını silerdi.
   */
  it("begin bitmeden tur biterse seal onu bekler; kayıt sonraki tura karışmaz", async () => {
    const cwd = await repo();
    const begun = beginTurnSnapshot("yaris", cwd); // beklenmez
    await sealTurnSnapshot("yaris", cwd, 1);
    await begun;
    await turn("yaris", cwd, 2, () => {
      writeFileSync(join(cwd, "iki.txt"), "2\n");
    });
    expect(await undoTurn("yaris", cwd, 1)).toEqual({ restored: [], removed: [], outside: [] });
    expect(existsSync(join(cwd, "iki.txt"))).toBe(true);
    expect((await undoTurn("yaris", cwd, 2)).removed).toEqual(["iki.txt"]);
  });

  it("önceki tur mühürlenirken başlayan tur kendi kaydını açar", async () => {
    const cwd = await repo();
    await beginTurnSnapshot("ust", cwd);
    writeFileSync(join(cwd, "a.txt"), "birinci tur\n");
    // `run_end` ardından hemen `run_start`: ikisi de beklenmeden başlar.
    const sealed = sealTurnSnapshot("ust", cwd, 1);
    const begun = beginTurnSnapshot("ust", cwd);
    await Promise.all([sealed, begun]);
    writeFileSync(join(cwd, "iki.txt"), "2\n");
    await sealTurnSnapshot("ust", cwd, 2);

    const second = await undoTurn("ust", cwd, 2);
    expect(second.removed).toEqual(["iki.txt"]);
    expect(second.restored).toEqual([]);
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("birinci tur\n");
    expect((await undoTurn("ust", cwd, 1)).restored).toEqual(["a.txt"]);
  });

  it("oturum kaydı bırakılınca geri alma boş döner", async () => {
    const cwd = await repo();
    await turn("s9", cwd, 1, () => {
      writeFileSync(join(cwd, "a.txt"), "tur1\n");
    });
    forgetTurnSnapshot("s9");
    expect(await undoTurn("s9", cwd, 1)).toEqual({ restored: [], removed: [], outside: [] });
  });

  it("oturum deponun alt klasöründeyse yollar o klasöre göre çözülür", async () => {
    const root = await repo();
    const sub = join(root, "alt");
    mkdirSync(sub);
    writeFileSync(join(sub, "b.txt"), "bir\n");
    const git = simpleGit(root);
    await git.add("alt/b.txt");
    await git.commit("alt");
    await turn("alt", sub, 1, async () => {
      writeFileSync(join(sub, "b.txt"), "tur\n");
      // Turda oluşan izlenen dosya (index'e alınmış) ve izlenmeyen dosya.
      writeFileSync(join(sub, "yeni.txt"), "yeni\n");
      await git.add("alt/yeni.txt");
      writeFileSync(join(sub, "izsiz.txt"), "izsiz\n");
      // Oturum klasörü dışındaki değişiklikler geri alınmaz, yalnız bildirilir.
      writeFileSync(join(root, "a.txt"), "dışarıda\n");
      writeFileSync(join(root, "kök-yeni.txt"), "kök\n");
    });
    const result = await undoTurn("alt", sub, 1);
    expect(result.restored).toEqual(["b.txt"]);
    expect(result.removed.sort()).toEqual(["izsiz.txt", "yeni.txt"]);
    expect(readFileSync(join(sub, "b.txt"), "utf8")).toBe("bir\n");
    expect(existsSync(join(sub, "yeni.txt"))).toBe(false);
    expect(existsSync(join(sub, "izsiz.txt"))).toBe(false);
    expect(existsSync(join(sub, "alt"))).toBe(false);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("dışarıda\n");
    expect(result.outside.sort()).toEqual(["a.txt", "kök-yeni.txt"]);
    expect((await git.status()).staged).toEqual([]);
  });

  it("alt klasörde tur öncesi kirli ağaçta kayda göre geri alır, kullanıcı değişikliğini korur", async () => {
    const root = await repo();
    const sub = join(root, "alt");
    mkdirSync(sub);
    writeFileSync(join(sub, "b.txt"), "bir\n");
    writeFileSync(join(sub, "c.txt"), "bir\n");
    const git = simpleGit(root);
    await git.add(["alt/b.txt", "alt/c.txt"]);
    await git.commit("alt");
    // Kirli ağaç: `git stash create` kayıt üretir, fark `changedSince` ile ölçülür.
    writeFileSync(join(sub, "c.txt"), "kullanıcı\n");
    await turn("kirli", sub, 1, () => {
      writeFileSync(join(sub, "b.txt"), "tur\n");
    });
    const result = await undoTurn("kirli", sub, 1);
    expect(result.restored).toEqual(["b.txt"]);
    expect(result.outside).toEqual([]);
    expect(readFileSync(join(sub, "b.txt"), "utf8")).toBe("bir\n");
    expect(readFileSync(join(sub, "c.txt"), "utf8")).toBe("kullanıcı\n");
  });

  it("turda yeniden adlandırılan dosyanın eski adı geri gelir", async () => {
    const cwd = await repo();
    const git = simpleGit(cwd);
    await turn("ad", cwd, 1, async () => {
      await git.mv("a.txt", "b.txt");
    });
    const result = await undoTurn("ad", cwd, 1);
    expect(result.restored).toEqual(["a.txt"]);
    expect(result.removed).toEqual(["b.txt"]);
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("bir\n");
    expect(existsSync(join(cwd, "b.txt"))).toBe(false);
  });

  it("Türkçe ve başı boşluklu dosya adları doğru dosyayı hedefler", async () => {
    const cwd = await repo();
    const git = simpleGit(cwd);
    writeFileSync(join(cwd, "çıktı.txt"), "bir\n");
    await git.add("çıktı.txt");
    await git.commit("türkçe");
    // Kullanıcının dosyası; turdaki başı boşluklu ad kırpılınca bu silinirdi.
    writeFileSync(join(cwd, "notlar.txt"), "kullanıcı\n");
    await turn("tr", cwd, 1, () => {
      writeFileSync(join(cwd, "çıktı.txt"), "tur\n");
      writeFileSync(join(cwd, "ölçüm.csv"), "x\n");
      writeFileSync(join(cwd, " notlar.txt"), "tur\n");
    });
    const result = await undoTurn("tr", cwd, 1);
    expect(result.restored).toEqual(["çıktı.txt"]);
    expect(result.removed.sort()).toEqual([" notlar.txt", "ölçüm.csv"]);
    expect(readFileSync(join(cwd, "çıktı.txt"), "utf8")).toBe("bir\n");
    expect(existsSync(join(cwd, "ölçüm.csv"))).toBe(false);
    expect(existsSync(join(cwd, " notlar.txt"))).toBe(false);
    expect(readFileSync(join(cwd, "notlar.txt"), "utf8")).toBe("kullanıcı\n");
  });

  it("dosya adındaki desen karakterleri başka dosyayı eşlemez", async () => {
    const cwd = await repo();
    const git = simpleGit(cwd);
    writeFileSync(join(cwd, "a[1].txt"), "bir\n");
    writeFileSync(join(cwd, "a1.txt"), "bir\n");
    await git.add(["a[1].txt", "a1.txt"]);
    await git.commit("desen");
    writeFileSync(join(cwd, "a1.txt"), "kullanıcı\n");
    await turn("desen", cwd, 1, () => {
      writeFileSync(join(cwd, "a[1].txt"), "tur\n");
    });
    const result = await undoTurn("desen", cwd, 1);
    expect(result.restored).toEqual(["a[1].txt"]);
    expect(readFileSync(join(cwd, "a[1].txt"), "utf8")).toBe("bir\n");
    expect(readFileSync(join(cwd, "a1.txt"), "utf8")).toBe("kullanıcı\n");
  });
});
