import { createI18n } from "@codezal/i18n";
import { describe, expect, it } from "vitest";
import {
  allowedArgs,
  commandName,
  commandSuggestions,
  modelArg,
  parseSlashCommand,
  permissionArg,
  runOnPick,
  SLASH_COMMANDS,
  thinkingArg,
  usageLine,
  usageOf,
} from "./slashCommands";

const tr = createI18n("tr");
const en = createI18n("en");

/** Katalogdan komut: eksikse test hemen patlar, sessizce `undefined` ile devam etmez. */
function cmd(key: string) {
  const command = parseSlashCommand(key)?.command;
  if (!command) throw new Error(`katalogda yok: ${key}`);
  return command;
}

/** Panel satırlarının yazımları (`/help`). */
function values(t: typeof tr.t, mode: string, hasSession: boolean): string[] {
  return commandSuggestions(t, mode, hasSession).map((s) => s.value);
}

describe("parseSlashCommand", () => {
  it("kanonik adı, TR ve EN yazımını aynı komuta çözer", () => {
    expect(parseSlashCommand("/help")?.command.name).toBe("help");
    expect(parseSlashCommand("/yardım")?.command.name).toBe("help");
    expect(parseSlashCommand("/YARDIM")?.command.name).toBe("help");
    expect(parseSlashCommand("/effort")?.command.name).toBe("effort");
    expect(parseSlashCommand("/düşünme")?.command.name).toBe("effort");
    // Arayüz dili değişse de öteki dilin yazımı çalışır (alışkanlık bozulmasın).
    expect(en.t("commands.name.help")).toBe("help");
  });

  it("komut adını ve argümanı ayırır, argümanı kırpar", () => {
    const parsed = parseSlashCommand("/model  acme/opus  ");
    expect(parsed?.command.name).toBe("model");
    expect(parsed?.args).toBe("acme/opus");
    expect(parseSlashCommand("/compact")?.args).toBe("");
  });

  it("yalnız tamamı komut olan metni çözer", () => {
    expect(parseSlashCommand("şu /plan dosyasını oku")).toBeNull();
    expect(parseSlashCommand("/bilinmeyen")).toBeNull();
    // Pi'nin kendi komutları (`/skill:ad`) bize ait değil: metin olduğu gibi modele gider.
    expect(parseSlashCommand("/skill:ad")).toBeNull();
  });

  it("Türkçe takma adlar çözülür ama kanonik ada iner", () => {
    expect(parseSlashCommand("/mod plan")?.command.name).toBe("mode");
    expect(parseSlashCommand("/sor neden?")?.command.name).toBe("ask");
    expect(parseSlashCommand("/denetim")?.command.name).toBe("audit");
    expect(parseSlashCommand("/görüşme")?.command.name).toBe("interview");
    expect(parseSlashCommand("model")).toBeNull();
  });
});

describe("panel satırı davranışı", () => {
  it("argümansız çağrısı iş yapan komutlar seçimde çalışır, ötekiler taslakta kalır", () => {
    expect(runOnPick(cmd("/compact"))).toBe(true);
    expect(runOnPick(cmd("/mcp"))).toBe(true);
    // Argümansız çağrıları da bir şey yapar: `/model` seçiciyi, `/yardım` ekranı açar.
    expect(runOnPick(cmd("/model"))).toBe(true);
    expect(runOnPick(cmd("/mod"))).toBe(true);
    expect(runOnPick(cmd("/yardım"))).toBe(true);
    // Hedef metin ister: taslakta kalır ki kullanıcı yazsın.
    expect(runOnPick(cmd("/goal"))).toBe(false);
    // Kısayollar da taslakta kalır (metin talimata genişler).
    expect(runOnPick(cmd("/plan"))).toBe(false);
  });

  it("kod odaklı komutlar yalnız kodlama modunda listelenir", () => {
    const asistan = values(tr.t, "asistan", true);
    expect(asistan).not.toContain("/debug");
    expect(asistan).not.toContain("/audit");
    const kodlama = values(tr.t, "kodlama", true);
    expect(kodlama).toContain("/debug");
    expect(kodlama).toContain("/audit");
  });

  it("oturum isteyen komutlar giriş ekranında listelenmez", () => {
    const home = values(tr.t, "kodlama", false);
    expect(home).not.toContain("/compact");
    expect(home).not.toContain("/goal");
    expect(home).not.toContain("/new");
    expect(home).toContain("/help");
  });

  it("satırda her dilde kanonik ad, açıklama arayüz dilinde; takma adlar aramada", () => {
    expect(values(tr.t, "kodlama", true)).toContain("/help");
    expect(values(en.t, "kodlama", true)).toContain("/help");
    const help = commandSuggestions(tr.t, "kodlama", true).find((s) => s.value === "/help");
    expect(help?.label).toBe("/help");
    expect(help?.description).toBe(tr.t("commands.helpDesc"));
    expect(help?.keywords).toContain("yardım");
    expect(help?.runOnPick).toBe(true);
  });
});

describe("kullanım satırı", () => {
  it("kanonik adı ve dile göre argüman ipucunu yazar", () => {
    const help = cmd("/yardım");
    expect(usageOf(help, tr.t)).toBe("/help [komut]");
    expect(usageOf(help, en.t)).toBe("/help [command]");
  });

  it("argüman alan komutlarda geçerli değerleri ekler", () => {
    const mode = cmd("/mod");
    expect(commandName(mode)).toBe("mode");
    expect(allowedArgs(mode)).toEqual(["ask", "auto-edit", "plan", "full"]);
    expect(usageLine(mode, tr.t)).toContain("ask | auto-edit | plan | full");
  });
});

describe("argüman çözümü", () => {
  it("izin modunu kimlik, ZCode adı ve görünen adla çözer", () => {
    expect(permissionArg("plan")).toBe("plan");
    expect(permissionArg("build")).toBe("ask");
    expect(permissionArg("yolo")).toBe("full");
    // Çipte okunan ad da geçerli: kullanıcı gördüğü metni yazar.
    expect(permissionArg(tr.t("permissionMode.full"))).toBe("full");
    expect(permissionArg("xyz")).toBeNull();
  });

  it("düşünme seviyesini kimlik ve görünen adla çözer", () => {
    expect(thinkingArg("max")).toBe("max");
    expect(thinkingArg("Yüksek")).toBe("high");
    expect(thinkingArg("xx")).toBeNull();
  });

  it("model argümanı sağlayıcı/kimlik ister", () => {
    expect(modelArg("acme/opus-4")).toEqual({ provider: "acme", id: "opus-4" });
    expect(modelArg("opus")).toBeNull();
    expect(modelArg("/opus")).toBeNull();
  });
});

describe("katalog", () => {
  it("adlar ve takma adlar tekildir", () => {
    const seen = new Set<string>();
    for (const command of SLASH_COMMANDS) {
      for (const name of [command.name, ...command.aliases]) {
        expect(seen.has(name), `${name} iki kez tanımlı`).toBe(false);
        seen.add(name);
      }
    }
  });

  it("her komutun kullanım satırı dolu ve iki dilde yazılır", () => {
    for (const command of SLASH_COMMANDS) {
      // Kullanım satırı t() üzerinden kurulur: eksik anahtar sessizce anahtarı yazardı.
      expect(usageOf(command, tr.t)).toMatch(/^\/[^\s]+/);
      expect(usageOf(command, en.t)).toMatch(/^\/[^\s]+/);
      expect(usageOf(command, en.t)).not.toContain("commands.");
    }
  });
});
