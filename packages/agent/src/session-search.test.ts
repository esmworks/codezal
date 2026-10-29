import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldQuery } from "@codezal/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  indexSessionFile,
  indexSessionLines,
  SessionSearchIndex,
  searchMessages,
} from "./session-search.js";

/** Pi'nin `appendMessage` sırasıyla bir mesaj kaydı (`type`, `id`, `parentId`, `timestamp`). */
function message(
  id: string,
  parentId: string | null,
  role: string,
  content: unknown,
  timestamp: number,
): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: new Date(timestamp).toISOString(),
    message: { role, content, timestamp },
  });
}

const header = JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/tmp" });
const model = JSON.stringify({
  type: "model_change",
  id: "m0",
  parentId: null,
  timestamp: "2026-01-01T00:00:00.000Z",
  provider: "p",
  modelId: "x",
});

function sample(): string[] {
  return [
    header,
    model,
    message("u1", "m0", "user", "İstanbul toplantısını planla", 1000),
    message(
      "a1",
      "u1",
      "assistant",
      [
        { type: "thinking", thinking: "gizli düşünce istanbul" },
        { type: "text", text: "Toplantı için " },
        { type: "text", text: "bir taslak hazırladım." },
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "istanbul.md" } },
      ],
      2000,
    ),
    // Araç çıktısı aranmaz: içinde sorgu geçse bile isabet sayılmaz.
    message("t1", "a1", "toolResult", [{ type: "text", text: "istanbul araç çıktısı" }], 2100),
    message("u2", "t1", "user", [{ type: "text", text: "Ankara da eklensin" }], 3000),
    message("a2", "u2", "assistant", [{ type: "text", text: "Ankara eklendi." }], 4000),
  ];
}

describe("indexSessionLines", () => {
  it("yalnız kullanıcı ve asistan metnini sırayla dizinler", () => {
    const messages = indexSessionLines(sample());
    expect(messages.map((m) => [m.role, m.ordinal, m.at, m.text])).toEqual([
      ["user", 1, 1000, "İstanbul toplantısını planla"],
      ["assistant", 2, 2000, "Toplantı için bir taslak hazırladım."],
      ["user", 3, 3000, "Ankara da eklensin"],
      ["assistant", 4, 4000, "Ankara eklendi."],
    ]);
  });

  it("geri sarılan daldaki mesajları dışarıda bırakır (yaprak son kayıttır)", () => {
    const lines = [
      ...sample(),
      // u2'den önceye geri sarıldı: yeni dal t1'in çocuğu, eski u2/a2 terk edildi.
      message("u3", "t1", "user", "İzmir olsun", 5000),
      message("a3", "u3", "assistant", "İzmir tamam.", 6000),
    ];
    const texts = indexSessionLines(lines).map((m) => m.text);
    expect(texts).toContain("İzmir olsun");
    expect(texts).not.toContain("Ankara da eklensin");
  });

  it("gönderim bloklarını balondaki gibi çözer (komut etiketi, okuma listesi)", () => {
    const sent =
      '<codezal-command name="plan">uzun talimat metni</codezal-command> giriş ekranı\n\n<codezal-files>\n@a.ts\n</codezal-files>';
    const [m] = indexSessionLines([header, message("u1", null, "user", sent, 1)]);
    expect(m?.text).toBe("/plan giriş ekranı");
  });

  it("bozuk satırı ve tanımadığı kayıt türünü atlar, sıkıştırma kaydını yol sayar", () => {
    const lines = [
      header,
      "{bozuk json",
      message("u1", null, "user", "önce", 1),
      JSON.stringify({
        type: "compaction",
        id: "c1",
        parentId: "u1",
        timestamp: "2026-01-01T00:00:00.000Z",
        summary: "özet",
        firstKeptEntryId: "u1",
        tokensBefore: 10,
      }),
      message("u2", "c1", "user", "sonra", 2),
    ];
    expect(indexSessionLines(lines).map((m) => m.text)).toEqual(["önce", "sonra"]);
  });

  it("anahtar sırası farklı kayıtta JSON yedeğine düşer", () => {
    const odd = JSON.stringify({
      id: "u1",
      type: "message",
      parentId: null,
      message: { role: "user", content: "ters sıra", timestamp: 7 },
    });
    expect(indexSessionLines([odd]).map((m) => [m.text, m.at])).toEqual([["ters sıra", 7]]);
  });
});

describe("searchMessages", () => {
  const messages = indexSessionLines(sample());

  it("Türkçe aksan ve büyük harften bağımsız bulur, ilk mesajı ve sayıyı döner", () => {
    const hit = searchMessages(messages, foldQuery("ISTANBUL"));
    expect(hit).toMatchObject({ role: "user", at: 1000, ordinal: 1, count: 1 });
    expect(hit?.snippet.slice(hit.matchStart, hit.matchEnd)).toBe("İstanbul");
  });

  it("düşünme ve araç çıktısındaki geçişleri saymaz", () => {
    // "istanbul" asistanın düşüncesinde ve araç çıktısında da geçiyor; yalnız kullanıcı metni sayılır.
    expect(searchMessages(messages, foldQuery("istanbul"))?.count).toBe(1);
  });

  it("birden çok mesajda geçen sorguyu sayar", () => {
    const hit = searchMessages(messages, foldQuery("ankara"));
    expect(hit).toMatchObject({ role: "user", ordinal: 3, count: 2 });
  });

  it("eşleşme yoksa ya da sorgu boşsa null döner", () => {
    expect(searchMessages(messages, foldQuery("bursa"))).toBeNull();
    expect(searchMessages(messages, "")).toBeNull();
  });
});

describe("SessionSearchIndex", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("dosyayı akışla okur; dosya değişince dizini yeniler", async () => {
    dir = mkdtempSync(join(tmpdir(), "cz-search-"));
    const path = join(dir, "s.jsonl");
    // Dev araç çıktısı satırı: ayrıştırılmadan geçilmeli, sonuç değişmemeli.
    const blob = message(
      "t9",
      "a2",
      "toolResult",
      [{ type: "text", text: "x".repeat(200_000) }],
      9,
    );
    writeFileSync(path, `${[...sample(), blob].join("\n")}\n`);
    expect((await indexSessionFile(path)).length).toBe(4);

    const index = new SessionSearchIndex();
    expect(await index.search(path, foldQuery("izmir"))).toBeNull();
    appendFileSync(path, `${message("u5", "t9", "user", "İzmir de olsun", 10)}\n`);
    expect(await index.search(path, foldQuery("izmir"))).toMatchObject({ ordinal: 5 });
  });

  it("olmayan dosyada boş döner", async () => {
    const index = new SessionSearchIndex();
    expect(await index.messages("/yok/boyle/bir/dosya.jsonl")).toEqual([]);
  });

  it("sınır aşılınca en eski dosyanın dizinini bırakır", async () => {
    dir = mkdtempSync(join(tmpdir(), "cz-search-"));
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    writeFileSync(a, `${sample().join("\n")}\n`);
    writeFileSync(b, `${sample().join("\n")}\n`);
    const index = new SessionSearchIndex(100);
    const first = await index.messages(a);
    await index.messages(b);
    // `a` düştü: yeniden okununca yeni bir dizi döner (önbellekten aynı nesne gelmez).
    expect(await index.messages(a)).not.toBe(first);
  });
});
