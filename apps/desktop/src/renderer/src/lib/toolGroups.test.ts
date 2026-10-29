import type { AssistantItem, ToolCallItem } from "@codezal/contracts";
import { describe, expect, it } from "vitest";
import {
  collapseRetries,
  countParts,
  displayCommand,
  firstErrorDetail,
  liveStep,
  planRun,
  summarizeTools,
} from "./toolGroups";

function tool(p: Partial<ToolCallItem> & { id: string }): ToolCallItem {
  return {
    type: "tool",
    toolName: "write",
    kind: "create",
    status: "done",
    title: "Oluşturuldu",
    target: "/m/MEMORY.md",
    startedAt: 1,
    ...p,
  };
}

describe("firstErrorDetail", () => {
  it("ilk hatalı aracın adı, hedefi ve çıktının ilk satırını verir", () => {
    const ok = tool({ id: "a" });
    const bad = tool({
      id: "b",
      toolName: "bash",
      kind: "terminal",
      title: "Terminal",
      status: "error",
      command: "cd /p && python3 cizim.py",
      output: "\nTraceback (most recent call last):\nModuleNotFoundError: No module named 'ezdxf'",
    });
    expect(firstErrorDetail(collapseRetries([ok, bad]), "/p")).toBe(
      "Terminal python3 cizim.py: Traceback (most recent call last):",
    );
    expect(firstErrorDetail(collapseRetries([ok]), "/p")).toBeUndefined();
  });

  it("hook'un reddettiği komutta başlık 'çalışmadı' etiketine döner", () => {
    const denied = tool({
      id: "d",
      toolName: "bash",
      kind: "terminal",
      title: "Çalıştırıldı",
      status: "denied",
      command: "rm -rf build",
      output: "hook: yasak komut",
    });
    expect(firstErrorDetail(collapseRetries([denied]), "/p", "Çalıştırılmadı")).toBe(
      "Çalıştırılmadı rm -rf build: hook: yasak komut",
    );
  });

  it("çıktısız hatada yalnızca araç ve dosya adı kalır, uzun metin kırpılır", () => {
    const bad = tool({ id: "b", status: "error", target: "/p/uzun/yol/rapor.md", output: "" });
    expect(firstErrorDetail(collapseRetries([bad]), "/p")).toBe("Oluşturuldu rapor.md");
    const long = tool({ id: "c", status: "error", output: "x".repeat(200) });
    expect(firstErrorDetail(collapseRetries([long]), "/p")?.length).toBeLessThan(130);
  });
});

describe("collapseRetries", () => {
  it("başarısız denemeyi aynı hedefe yapılan sonraki çağrıyla birleştirir", () => {
    const a = tool({ id: "a", status: "error" });
    const b = tool({ id: "b" });
    const c = tool({ id: "c", target: "/m/other.md" });
    expect(collapseRetries([a, b, c])).toEqual([
      { item: b, attempts: [a], anchorId: "a" },
      { item: c, attempts: [], anchorId: "c" },
    ]);
  });

  it("başarılı çağrıyı ve farklı hedefi birleştirmez", () => {
    const a = tool({ id: "a" });
    const b = tool({ id: "b" });
    const c = tool({ id: "c", status: "error", target: "/x" });
    const d = tool({ id: "d", target: "/y" });
    expect(collapseRetries([a, b, c, d]).map((e) => e.attempts.length)).toEqual([0, 0, 0, 0]);
  });
});

const labels = {
  error: (n: number) => `${n} hata`,
  blocked: (n: number) => `${n} engellendi`,
  denied: (n: number) => `${n} reddedildi`,
};

describe("summarizeTools", () => {
  it("başlık başına sayar, hataları ayrı ekler", () => {
    const entries = collapseRetries([
      tool({ id: "1", kind: "read", title: "Okundu" }),
      tool({ id: "2", kind: "read", title: "Okundu", target: "/b" }),
      tool({ id: "3" }),
      tool({ id: "4", status: "error", target: "/z" }),
    ]);
    expect(summarizeTools(entries, labels)).toBe("2 okundu · 1 oluşturuldu · 1 hata");
  });

  it("plan modunun engellediği ve hook'un reddettiği çağrı başlığıyla sayılmaz", () => {
    const entries = collapseRetries([
      tool({ id: "1", kind: "read", title: "Okundu" }),
      tool({ id: "2", kind: "terminal", title: "Çalıştırıldı", status: "blocked", target: "/a" }),
      tool({ id: "3", kind: "terminal", title: "Çalıştırıldı", status: "denied", target: "/b" }),
    ]);
    expect(summarizeTools(entries, labels)).toBe("1 okundu · 1 engellendi · 1 reddedildi");
  });
});

describe("displayCommand", () => {
  it("cd <cwd> && önekini düşürür, kalan cwd yollarını ./ yapar", () => {
    const cwd = "/Users/e/Documents/Coils Studio";
    expect(displayCommand(`cd "${cwd}" && ls -la`, cwd)).toBe("ls -la");
    expect(displayCommand(`cd ${cwd} && cat ${cwd}/package.json`, cwd)).toBe("cat ./package.json");
    expect(displayCommand("git status", cwd)).toBe("git status");
    expect(displayCommand("cd /x && ls", "")).toBe("cd /x && ls");
  });

  it("cd önekini satır sonu ve ; ayracıyla da düşürür, başka dizine cd'ye dokunmaz", () => {
    const cwd = "/Users/e/Codezal";
    expect(displayCommand(`cd ${cwd}\necho a\nls`, cwd)).toBe("echo a\nls");
    expect(displayCommand(`cd ${cwd}; ls`, cwd)).toBe("ls");
    expect(displayCommand(`cd ${cwd}/apps && ls`, cwd)).toBe("cd ./apps && ls");
  });
});

describe("planRun", () => {
  const read = (id: string, p: Partial<ToolCallItem> = {}) =>
    tool({ id, kind: "read", title: "Okundu", target: `/p/${id}.ts`, ...p });
  const search = (id: string, p: Partial<ToolCallItem> = {}) =>
    tool({ id, kind: "search", title: "Arandı", target: id, ...p });
  const cmd = (id: string, p: Partial<ToolCallItem> = {}) =>
    tool({ id, kind: "terminal", title: "Çalıştırıldı", command: `echo ${id}`, ...p });
  const thought = (id: string): AssistantItem => ({
    type: "assistant",
    id,
    text: "",
    thinking: "hmm",
    streaming: false,
    at: 1,
  });

  it("iki ve üstü ardışık keşif çağrısını tek gruba katlar, tek kartı bırakır", () => {
    const steps = planRun([read("a"), read("b"), read("c"), cmd("w"), read("d"), read("e")]);
    expect(steps.map((s) => s.type)).toEqual(["group", "tool", "group"]);
    const first = steps[0];
    expect(first?.type === "group" ? first.entries.map((e) => e.item.id) : []).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("okuma ve arama aynı grupta toplanır (ZCode'un keşif grubu gibi)", () => {
    const steps = planRun([read("a"), search("b"), read("c")]);
    expect(steps.map((s) => (s.type === "group" ? `group:${s.entries.length}` : s.type))).toEqual([
      "group:3",
    ]);
  });

  it("düzenleme ve oluşturma gruplanmaz: her değişiklik kendi satırında okunur", () => {
    const steps = planRun([
      tool({ id: "e1", kind: "edit", title: "Düzenlendi", target: "/m/a.ts" }),
      tool({ id: "e2", kind: "edit", title: "Düzenlendi", target: "/m/b.ts" }),
      tool({ id: "e3", kind: "create", title: "Oluşturuldu", target: "/m/c.ts" }),
    ]);
    expect(steps.map((s) => s.type)).toEqual(["tool", "tool", "tool"]);
  });

  it("düşünme, hata ve denemeli kart grubu böler", () => {
    const steps = planRun([
      read("a"),
      read("b"),
      thought("t"),
      read("c"),
      read("d"),
      read("e", { status: "error" }),
      read("f"),
    ]);
    expect(steps.map((s) => (s.type === "group" ? `group:${s.entries.length}` : s.type))).toEqual([
      "group:2",
      "assistant",
      "group:2",
      "tool",
      "tool",
    ]);
  });

  it("başarılı terminal komutlarını katlar, hatalı komut kendi satırında kalır", () => {
    const steps = planRun([cmd("a"), cmd("b"), cmd("c"), cmd("d", { status: "error" })]);
    expect(steps.map((s) => (s.type === "group" ? `group:${s.entries.length}` : s.type))).toEqual([
      "group:3",
      "tool",
    ]);
  });

  it("süren turda satırlar tek tek doğar; yalnız aynı ailenin ardışıkları katlanır", () => {
    // ZCode süren turda diziyi açık tutar: ilk keşif çağrısı kendi satırında görünür, ikincisi
    // gelince satır gruba döner. Terminal komutu ve düzenleme kendi satırında kalır.
    const steps = planRun(
      [
        read("a"),
        thought("t"),
        read("b"),
        read("c"),
        cmd("d", { status: "running" }),
        tool({ id: "e", kind: "edit", title: "Düzenlendi", target: "/m/a.ts" }),
      ],
      { live: true },
    );
    expect(steps.map((s) => (s.type === "group" ? `group:${s.entries.length}` : s.type))).toEqual([
      "tool",
      "assistant",
      "group:2",
      "tool",
      "tool",
    ]);
    // Süren terminal çağrısı grubun içinde kalır (bitmiş gibi ayrı satıra düşmez).
    const lastGroup = planRun([cmd("x"), cmd("y", { status: "running" })], { live: true })[0];
    expect(lastGroup?.type === "group" ? lastGroup.entries.length : 0).toBe(2);
    // Süren kart `live` değilken gruba girmez.
    expect(planRun([read("a"), read("b", { status: "running" })])).toMatchObject([
      { type: "tool" },
      { type: "tool" },
    ]);
  });

  it("tekrar denemede yutulan kartı atlar, denemeli kartı gruba almaz", () => {
    const steps = planRun([
      read("a"),
      read("b"),
      read("c", { status: "error", target: "/p/x.ts" }),
      read("d", { target: "/p/x.ts" }),
    ]);
    expect(steps.map((s) => s.type)).toEqual(["group", "tool"]);
    const last = steps[1];
    expect(last?.type === "tool" ? last.entry.attempts.length : -1).toBe(1);
  });
});

describe("countParts", () => {
  it("bitenleri tür başlığına göre sayar; süreni saymaz, hatayı ayrı verir", () => {
    const entries = collapseRetries([
      tool({ id: "1", kind: "read", title: "Okundu" }),
      tool({ id: "2", kind: "read", title: "Okundu", target: "/b", status: "running" }),
      tool({ id: "3", kind: "edit", title: "Düzenlendi" }),
      tool({ id: "4", status: "error", target: "/z" }),
    ]);
    expect(countParts(entries)).toEqual({
      parts: [
        { label: "Okundu", count: 1 },
        { label: "Düzenlendi", count: 1 },
      ],
      errors: 1,
      blocked: 0,
      denied: 0,
    });
  });
});

describe("liveStep", () => {
  it("süren çağrı varsa onu, yoksa son çağrıyı verir", () => {
    expect(
      liveStep(collapseRetries([tool({ id: "a" }), tool({ id: "b", target: "/b" })]))?.item.id,
    ).toBe("b");
    const running = collapseRetries([
      tool({ id: "a" }),
      tool({ id: "b", status: "running" }),
      tool({ id: "c", target: "/c" }),
    ]);
    expect(liveStep(running)?.item.id).toBe("b");
  });
});
