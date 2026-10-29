import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionMode, PermissionRequest } from "@codezal/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { evaluatePermission, PermissionManager } from "./permission.js";

describe("evaluatePermission (PRD §6 tablosu)", () => {
  const table: Array<[PermissionMode, string, string]> = [
    ["ask", "read", "allow"],
    ["ask", "edit", "ask"],
    ["ask", "bash", "ask"],
    ["auto-edit", "edit", "allow"],
    ["auto-edit", "bash", "ask"],
    ["plan", "read", "allow"],
    ["plan", "edit", "block"],
    ["plan", "bash", "block"],
    ["full", "edit", "allow"],
    ["full", "bash", "allow"],
    ["ask", "pdf_create", "ask"],
    ["auto-edit", "pdf_create", "allow"],
    ["plan", "pdf_create", "block"],
    ["ask", "docx_create", "ask"],
    ["auto-edit", "docx_create", "allow"],
    ["plan", "docx_create", "block"],
    ["ask", "docx_edit", "ask"],
    ["auto-edit", "docx_edit", "allow"],
    ["plan", "docx_edit", "block"],
    ["ask", "xlsx_create", "ask"],
    ["auto-edit", "xlsx_create", "allow"],
    ["plan", "xlsx_create", "block"],
    ["ask", "xlsx_edit", "ask"],
    ["auto-edit", "xlsx_edit", "allow"],
    ["plan", "xlsx_edit", "block"],
    ["plan", "plan_exit", "allow"],
    ["ask", "plan_enter", "allow"],
    ["ask", "tool_search", "allow"],
    ["plan", "tool_search", "allow"],
    // Web araçları adres ya da sorguyla veri dışarı taşıyabilir: Sor ve Plan modunda sorulur.
    ["ask", "web_search", "ask"],
    ["plan", "web_search", "ask"],
    ["auto-edit", "web_search", "allow"],
    ["full", "web_search", "allow"],
    ["ask", "web_fetch", "ask"],
    ["plan", "web_fetch", "ask"],
    ["auto-edit", "web_fetch", "allow"],
    ["full", "web_fetch", "allow"],
    ["ask", "agent_list", "allow"],
    ["plan", "agent_stop", "allow"],
    // Soru aracı yalnızca kullanıcıya sorar; Sor ve Plan modunda serbesttir (plan öncesi netleştirme).
    ["ask", "question", "allow"],
    ["plan", "question", "allow"],
    ["full", "question", "allow"],
    // Arka plan aracı: `start` kabuk sınıfı, diğer eylemleri okuma (aşağıdaki ayrı testte).
    ["ask", "bash_background", "ask"],
    ["full", "bash_background", "allow"],
    ["plan", "bash_background", "block"],
  ];
  for (const [mode, tool, expected] of table) {
    it(`${mode} + ${tool} → ${expected}`, () => {
      expect(evaluatePermission(mode, tool)).toBe(expected);
    });
  }
});

describe("bash_background eylem sınıfı", () => {
  it("start kabuk sınıfı, output ve list okuma sınıfı", () => {
    expect(evaluatePermission("ask", "bash_background", { action: "start" })).toBe("ask");
    expect(evaluatePermission("plan", "bash_background", { action: "start" })).toBe("block");
    expect(evaluatePermission("ask", "bash_background", { action: "output" })).toBe("allow");
    expect(evaluatePermission("plan", "bash_background", { action: "list" })).toBe("allow");
    expect(evaluatePermission("plan", "bash_background", { action: "stop" })).toBe("allow");
  });
});

describe("PermissionManager", () => {
  it("serbest araçlar sormadan geçer", async () => {
    const pm = new PermissionManager(() => {
      throw new Error("sorulmamalıydı");
    });
    await expect(pm.gate("s", "ask", "read", { path: "a.ts" })).resolves.toEqual({ allowed: true });
  });

  it("servis aracı izni: Kapalı engellenir, Otomatik sormaz (planda değil), Sor moda uyar", async () => {
    const policies: Record<string, "auto" | "ask" | "off"> = {
      mcp_notion_search: "auto",
      mcp_notion_delete: "off",
      mcp_notion_update: "ask",
    };
    let asks = 0;
    const pm = new PermissionManager(
      () => {
        asks++;
      },
      [],
      "tr",
      (name) => policies[name],
    );
    const off = await pm.gate("s", "full", "mcp_notion_delete", {});
    expect(off.allowed).toBe(false);
    expect(off.reason).toContain("kapatıldı");
    await expect(pm.gate("s", "ask", "mcp_notion_search", {})).resolves.toEqual({
      allowed: true,
    });
    // Plan modu yan etkiyi yasaklar: Otomatik araç da orada engelli kalır.
    expect((await pm.gate("s", "plan", "mcp_notion_search", {})).planBlocked).toBe(true);
    // Sor: Tam erişimde sormaz, Sor modunda onay ister.
    await expect(pm.gate("s", "full", "mcp_notion_update", {})).resolves.toEqual({
      allowed: true,
    });
    void pm.gate("s", "ask", "mcp_notion_update", {});
    expect(asks).toBe(1);
  });

  it("plan modunda edit engellenir", async () => {
    const pm = new PermissionManager(() => {});
    const r = await pm.gate("s", "plan", "edit", { path: "a.ts" });
    expect(r.allowed).toBe(false);
    expect(r.planBlocked).toBe(true);
  });

  it("doğrulama komutunu arka plana atmaz, onay sormaz", async () => {
    const pm = new PermissionManager(() => {
      throw new Error("sorulmamalıydı");
    });
    const r = await pm.gate("s", "ask", "bash_background", {
      action: "start",
      command: "pnpm check && pnpm test",
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("ön planda");
    // Plan modunda üstteki plan engeli kazanır: gerekçe "plan" olarak kalır.
    const planned = await pm.gate("s", "plan", "bash_background", {
      action: "start",
      command: "pnpm test",
    });
    expect(planned.planBlocked).toBe(true);
    // Bağımsız uzun iş serbest kalır: Sor modunda yine onay sorulur.
    let asked = false;
    const pm2 = new PermissionManager(() => {
      asked = true;
    });
    void pm2.gate("s", "ask", "bash_background", { action: "start", command: "pnpm dev" });
    expect(asked).toBe(true);
  });

  it("onay isteği yayınlanır ve cevapla çözülür", async () => {
    let requestId = "";
    const pm = new PermissionManager((req) => {
      requestId = req.requestId;
      expect(req.kind).toBe("terminal");
      expect(req.command).toBe("pnpm test");
    });
    const p = pm.gate("s", "ask", "bash", { command: "pnpm test" });
    expect(pm.pendingFor("s")).toHaveLength(1);
    pm.respond(requestId, "allow");
    await expect(p).resolves.toEqual({ allowed: true });
  });

  it("sonuçlanan istek yanıtta da iptalde de bildirilir", async () => {
    const asked: string[] = [];
    const resolved: string[] = [];
    const pm = new PermissionManager(
      (req) => asked.push(req.requestId),
      [],
      "tr",
      () => undefined,
      (req) => resolved.push(req.requestId),
    );
    const first = pm.gate("s", "ask", "bash", { command: "pnpm test" });
    const second = pm.gate("s", "ask", "bash", { command: "pnpm lint" });
    pm.respond(asked[0] ?? "", "allow");
    await first;
    expect(resolved).toEqual([asked[0]]);
    pm.rejectAll("s");
    await expect(second).resolves.toMatchObject({ allowed: false });
    expect(resolved).toEqual(asked);
  });

  it("bu oturumda hep izin ver aynı hedef için sonraki çağrıda sormaz", async () => {
    let requestId = "";
    let asks = 0;
    const pm = new PermissionManager((req) => {
      asks++;
      requestId = req.requestId;
    });
    const p = pm.gate("s", "ask", "edit", { path: "x" });
    pm.respond(requestId, "allow-session");
    await p;
    await pm.gate("s", "ask", "edit", { path: "x" });
    expect(asks).toBe(1);
  });

  /**
   * Regresyon: izin yalnızca araç adıyla kaydediliyordu. Kartta kullanıcıya gösterilen şey tek bir
   * hedeftir; araç geneline verilen izin aynı araçla yapılan bütün sonraki işlemleri (proje dışı
   * bir dosyaya yazım dahil) sessizce geçiriyordu.
   */
  it("bu oturumda hep izin ver başka hedefi kapsamaz", async () => {
    let requestId = "";
    let asks = 0;
    const pm = new PermissionManager((req) => {
      asks++;
      requestId = req.requestId;
    });
    const p = pm.gate("s", "ask", "write", { path: "proje/a.ts" });
    pm.respond(requestId, "allow-session");
    await p;

    const other = pm.gate("s", "ask", "write", { path: "~/.zshrc" });
    expect(asks).toBe(2);
    pm.respond(requestId, "deny");
    await expect(other).resolves.toMatchObject({ allowed: false });
  });

  it("web_fetch izni alan adına verilir; kartta tam adres görünür", async () => {
    const asked: PermissionRequest[] = [];
    const pm = new PermissionManager((req) => asked.push(req));
    const first = pm.gate("s", "plan", "web_fetch", { url: "https://Docs.Ornek.dev/a?q=1" });
    expect(asked[0]).toMatchObject({
      target: "docs.ornek.dev",
      command: "https://Docs.Ornek.dev/a?q=1",
    });
    pm.respond(asked[0]?.requestId ?? "", "allow-session");
    await expect(first).resolves.toMatchObject({ allowed: true });

    // Aynı alan adının başka sayfası sorulmaz; başka alan adı (alt alan dahil) yine sorulur.
    await expect(
      pm.gate("s", "ask", "web_fetch", { url: "https://docs.ornek.dev./b" }),
    ).resolves.toMatchObject({ allowed: true });
    const other = pm.gate("s", "ask", "web_fetch", { url: "https://kotu.ornek.dev/?veri=gizli" });
    expect(asked).toHaveLength(2);
    expect(asked[1]?.target).toBe("kotu.ornek.dev");
    pm.respond(asked[1]?.requestId ?? "", "deny");
    await expect(other).resolves.toMatchObject({ allowed: false });

    // Düzenleme onaysız modda sorulmaz.
    await expect(
      pm.gate("s", "auto-edit", "web_fetch", { url: "https://yeni.ornek.dev/" }),
    ).resolves.toMatchObject({ allowed: true });
    expect(asked).toHaveLength(2);
  });

  it("web_search kartta sorguyu gösterir; oturum izni sonraki aramaları kapsar", async () => {
    const asked: PermissionRequest[] = [];
    const pm = new PermissionManager((req) => asked.push(req));
    const first = pm.gate("s", "ask", "web_search", { query: "pi sdk sürüm notları" });
    expect(asked[0]?.command).toBe("pi sdk sürüm notları");
    expect(asked[0]?.target).toBeUndefined();
    pm.respond(asked[0]?.requestId ?? "", "allow-session");
    await expect(first).resolves.toMatchObject({ allowed: true });
    await expect(
      pm.gate("s", "plan", "web_search", { query: "başka bir sorgu" }),
    ).resolves.toMatchObject({ allowed: true });
    expect(asked).toHaveLength(1);

    // Tek seferlik izin sonrakini kapsamaz; başka oturum da yine sorulur.
    const other = pm.gate("t", "ask", "web_search", { query: "x" });
    pm.respond(asked[1]?.requestId ?? "", "allow");
    await other;
    const again = pm.gate("t", "ask", "web_search", { query: "y" });
    expect(asked).toHaveLength(3);
    pm.respond(asked[2]?.requestId ?? "", "deny");
    await expect(again).resolves.toMatchObject({ allowed: false });
  });

  it("görevin web izni gözetimsiz Sor/Plan koşusunda yalnız web araçlarını geçirir", async () => {
    const asked: PermissionRequest[] = [];
    const pm = new PermissionManager((req) => asked.push(req));
    pm.setUnattended("g", true);
    // İzin yokken web isteği sorulacak kimse olmadığı için reddedilir.
    await expect(pm.gate("g", "plan", "web_search", { query: "haberler" })).resolves.toMatchObject({
      allowed: false,
    });
    pm.setWebAllowed("g", true);
    await expect(pm.gate("g", "plan", "web_search", { query: "haberler" })).resolves.toMatchObject({
      allowed: true,
    });
    await expect(
      pm.gate("g", "ask", "web_fetch", { url: "https://haber.ornek/a" }),
    ).resolves.toMatchObject({ allowed: true });
    // Web izni başka aracı açmaz: Plan modunda yazma engelli, Sor modunda komut reddedilir.
    await expect(pm.gate("g", "plan", "write", { path: "a.txt" })).resolves.toMatchObject({
      allowed: false,
      planBlocked: true,
    });
    await expect(pm.gate("g", "ask", "bash", { command: "ls" })).resolves.toMatchObject({
      allowed: false,
    });
    // Geri alınınca yine reddedilir; oturum kapanınca da iz kalmaz.
    pm.setWebAllowed("g", false);
    await expect(pm.gate("g", "plan", "web_search", { query: "x" })).resolves.toMatchObject({
      allowed: false,
    });
    pm.setWebAllowed("g", true);
    pm.clearSession("g");
    pm.setUnattended("g", true);
    await expect(pm.gate("g", "plan", "web_search", { query: "x" })).resolves.toMatchObject({
      allowed: false,
    });
    expect(asked).toHaveLength(0);
  });

  it("görev koşusu schedule_task ile görev kuramaz, değiştiremez; listeleyebilir", async () => {
    const pm = new PermissionManager(() => undefined);
    pm.setUnattended("g", true);
    for (const action of ["create", "update", "delete"]) {
      await expect(
        pm.gate("g", "full", "schedule_task", { action, title: "x", prompt: "y" }),
      ).resolves.toMatchObject({ allowed: false });
    }
    await expect(pm.gate("g", "full", "schedule_task", { action: "list" })).resolves.toMatchObject({
      allowed: true,
    });
    // Başında kullanıcı olan oturumda Tam erişim sormadan kaydeder.
    await expect(
      pm.gate("s", "full", "schedule_task", { action: "create", title: "x", prompt: "y" }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it("tehlikeli komut tam erişimde bile sorar ve işaretlenir", async () => {
    let dangerous = false;
    let requestId = "";
    const pm = new PermissionManager((req) => {
      dangerous = req.dangerous;
      requestId = req.requestId;
    });
    const p = pm.gate("s", "full", "bash", { command: "rm -rf build" });
    pm.respond(requestId, "deny");
    const r = await p;
    expect(dangerous).toBe(true);
    expect(r.allowed).toBe(false);
  });

  it("gözetimsiz oturumda tehlikeli komut sorulmaz, reddedilir; işaret kalkınca yine sorar", async () => {
    let asks = 0;
    const pm = new PermissionManager(() => {
      asks++;
    });
    pm.setUnattended("s", true);
    const r = await pm.gate("s", "full", "bash", { command: "rm -rf build" });
    expect(r.allowed).toBe(false);
    expect(asks).toBe(0);
    // Tehlikeli olmayan komut tam erişimde gözetimsizken de serbest.
    expect((await pm.gate("s", "full", "bash", { command: "ls" })).allowed).toBe(true);
    pm.setUnattended("s", false);
    void pm.gate("s", "full", "bash", { command: "rm -rf build" });
    await Promise.resolve();
    expect(asks).toBe(1);
    pm.rejectAll("s");
  });

  it("bellekteki alt ajanın isteği ajan adını etiket olarak taşır", async () => {
    const seen: PermissionRequest[] = [];
    const pm = new PermissionManager((req) => {
      seen.push(req);
    });
    const p = pm.gate("s", "ask", "edit", { path: "kare.js" }, "general · kare.js düzelt");
    const q = pm.gate("s", "ask", "bash", { command: "ls" });
    for (const req of seen) pm.respond(req.requestId, "allow");
    await Promise.all([p, q]);
    expect(seen.map((req) => req.agent)).toEqual(["general · kare.js düzelt", undefined]);
  });

  it("abort bekleyenleri reddeder", async () => {
    const pm = new PermissionManager(() => {});
    const p = pm.gate("s", "ask", "bash", { command: "ls" });
    pm.rejectAll("s");
    await expect(p).resolves.toMatchObject({ allowed: false });
  });
});

describe("güvenilir kökler", () => {
  it("bellek klasörüne yazma sormadan geçer, başka yere yazma sorar", async () => {
    let asked = 0;
    const pm = new PermissionManager(() => {
      asked++;
    }, ["/tmp/codezal-memory"]);
    await expect(
      pm.gate("s", "ask", "write", { path: "/tmp/codezal-memory/genel/not.md", content: "x" }),
    ).resolves.toEqual({ allowed: true });
    expect(asked).toBe(0);
    const pending = pm.gate("s", "ask", "write", { path: "/tmp/baska/not.md", content: "x" });
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toBe(1);
    void pending;
  });
});

describe("plan modu ve güvenilir kökler", () => {
  it("plan modunda plan klasörüne write geçer, projeye write engellenir", async () => {
    const pm = new PermissionManager(() => {
      throw new Error("sorulmamalıydı");
    }, ["/tmp/codezal-plans"]);
    await expect(
      pm.gate("s", "plan", "write", { path: "/tmp/codezal-plans/proje/s.md", content: "# Plan" }),
    ).resolves.toEqual({ allowed: true });
    const r = await pm.gate("s", "plan", "write", { path: "/tmp/proje/a.ts", content: "x" });
    expect(r.allowed).toBe(false);
    // Kök adının uzantısı kök sayılmaz: /tmp/codezal-plans2 güvenilir değildir.
    const r2 = await pm.gate("s", "plan", "write", {
      path: "/tmp/codezal-plans2/x.md",
      content: "",
    });
    expect(r2.allowed).toBe(false);
  });
});

describe("güvenilir kök yol normalizasyonu", () => {
  const root = mkdtempSync(join(tmpdir(), "codezal-perm-"));
  const memory = join(root, "memory");
  mkdirSync(memory, { recursive: true });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const asking = () => {
    const seen: PermissionRequest[] = [];
    const pm = new PermissionManager(
      (req) => {
        seen.push(req);
      },
      [memory],
    );
    return { pm, seen };
  };

  /**
   * Regresyon: kök denetimi ham `args.path`'e `startsWith` uyguluyordu; Pi ise yolu sonradan
   * çözüyor. `<bellek>/../../../.zshrc` plan modunda bile sorulmadan yazılıyordu.
   */
  it("`..` ile kökten çıkan mutlak yol güvenilir sayılmaz", async () => {
    const { pm } = asking();
    const outside = `${memory}/../../../.zshrc`;
    const r = await pm.gate("s", "plan", "write", { path: outside, content: "x" });
    expect(r.allowed).toBe(false);
    expect(r.planBlocked).toBe(true);
    // Kök içinde kalan `..` yine güvenilir: normalize yol kökün altında.
    await expect(
      pm.gate("s", "plan", "write", { path: `${memory}/a/../not.md`, content: "x" }),
    ).resolves.toEqual({ allowed: true });
  });

  it("onay kartı ve oturum izni normalize yolu kullanır", async () => {
    const { pm, seen } = asking();
    const p = pm.gate(
      "s",
      "ask",
      "write",
      { path: `${memory}/../disari.md`, content: "x" },
      undefined,
      root,
    );
    await Promise.resolve();
    expect(seen[0]?.target).toBe(join(root, "disari.md"));
    pm.respond(seen[0]?.requestId ?? "", "allow-session");
    await p;
    // Aynı dosyanın göreli yazımı aynı izin anahtarına düşer; yeniden sorulmaz.
    await expect(
      pm.gate("s", "ask", "write", { path: "./disari.md", content: "y" }, undefined, root),
    ).resolves.toEqual({ allowed: true });
    expect(seen).toHaveLength(1);
  });

  it("göreli yol oturumun cwd'sine göre çözülür", async () => {
    const { pm } = asking();
    await expect(
      pm.gate("s", "plan", "write", { path: "genel/not.md", content: "x" }, undefined, memory),
    ).resolves.toEqual({ allowed: true });
    const r = await pm.gate(
      "s",
      "plan",
      "write",
      { path: "../not.md", content: "x" },
      undefined,
      memory,
    );
    expect(r.allowed).toBe(false);
  });

  it("kökteki sembolik bağ kökün dışına çıkamaz", async () => {
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(memory, "bag"));
    const { pm } = asking();
    const r = await pm.gate("s", "plan", "write", {
      path: join(memory, "bag", "x.md"),
      content: "",
    });
    expect(r.allowed).toBe(false);
  });
});

describe("kimlik dosyaları", () => {
  const root = mkdtempSync(join(tmpdir(), "codezal-cred-"));
  const agentDir = join(root, "pi");
  const project = join(root, "proje");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  const keys = join(agentDir, "keys.json");
  writeFileSync(keys, '{"anthropic":"sk-ant-gizli"}');
  writeFileSync(join(project, "a.ts"), "x");
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const manager = () =>
    new PermissionManager(
      () => {
        throw new Error("sorulmamalıydı");
      },
      [],
      "tr",
      () => undefined,
      () => {},
      ["keys.json", "auth.json", "mcp.json"].map((n) => join(agentDir, n)),
    );

  it("keys.json okuması her modda sorulmadan reddedilir", async () => {
    const pm = manager();
    for (const mode of ["ask", "plan", "full"] as const) {
      const r = await pm.gate("s", mode, "read", { path: keys });
      expect(r.allowed).toBe(false);
      expect(r.reason).toContain("kimlik");
    }
  });

  it("`..`, göreli yol, sembolik ve sabit bağ hilesi de reddedilir", async () => {
    const pm = manager();
    const via = [
      `${project}/../pi/keys.json`,
      "../pi/./auth.json",
      join(agentDir, "mcp.json"),
      join(agentDir, "keys.json.tmp"),
    ];
    for (const path of via) {
      const r = await pm.gate("s", "full", "read", { path }, undefined, project);
      expect(r.allowed, path).toBe(false);
    }
    symlinkSync(keys, join(project, "bag.json"));
    linkSync(keys, join(project, "sabit.json"));
    for (const path of ["bag.json", "sabit.json"]) {
      const r = await pm.gate("s", "full", "read", { path }, undefined, project);
      expect(r.allowed, path).toBe(false);
    }
    // Düzenleme ve yazma da kapalı: anahtar dosyası ezilmesin, içerik yoklanmasın.
    expect((await pm.gate("s", "full", "write", { path: keys, content: "{}" })).allowed).toBe(
      false,
    );
  });

  it("kimlik dosyasını kapsayan klasörde grep tam erişimde de sorulur, listeleme serbest kalır", async () => {
    const seen: PermissionRequest[] = [];
    const asker = new PermissionManager(
      (req) => {
        seen.push(req);
        asker.respond(req.requestId, "deny");
      },
      [],
      "tr",
      () => undefined,
      () => {},
      [keys],
    );
    expect((await asker.gate("s", "full", "grep", { pattern: "sk-", path: root })).allowed).toBe(
      false,
    );
    // Yol verilmeyen grep oturum klasöründe arar; o da kimlik klasörünü kapsıyorsa sorulur.
    const bare = await asker.gate("s", "full", "grep", { pattern: "sk-" }, undefined, root);
    expect(bare.allowed).toBe(false);
    expect(seen).toHaveLength(2);
    expect(seen.every((r) => r.dangerous)).toBe(true);
    const pm = manager();
    await expect(pm.gate("s", "ask", "ls", { path: agentDir })).resolves.toEqual({
      allowed: true,
    });
    await expect(pm.gate("s", "ask", "grep", { pattern: "x", path: project })).resolves.toEqual({
      allowed: true,
    });
    await expect(pm.gate("s", "ask", "read", { path: join(project, "a.ts") })).resolves.toEqual({
      allowed: true,
    });
  });
});
