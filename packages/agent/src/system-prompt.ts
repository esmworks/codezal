import { execFileSync } from "node:child_process";
import { release } from "node:os";
import type { createI18n, Locale } from "@codezal/i18n";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type I18n = ReturnType<typeof createI18n>;

/** İsteme giren ortam bilgisi. Saat yok: her turda değişip istem önbelleğini bozmasın. */
export interface PromptEnvironment {
  now: Date;
  locale: Locale;
  platform: NodeJS.Platform;
  osRelease: string;
  shell: string;
  model?: { name: string; provider: string; id: string } | undefined;
  gitBranch?: string | undefined;
}

/** Yerel saate göre `YYYY-MM-DD`; `toISOString` UTC'ye çevirip gece yarısı bir gün kaydırır. */
export function localDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function osLabel(platform: NodeJS.Platform, osRelease: string): string {
  if (platform === "darwin") return `macOS (Darwin ${osRelease})`;
  if (platform === "win32") return `Windows ${osRelease}`;
  if (platform === "linux") return `Linux ${osRelease}`;
  return `${platform} ${osRelease}`;
}

/** Çalışma klasörünün git dalı; depo değilse, git yoksa ya da henüz commit yoksa `undefined`. */
export function gitBranch(cwd: string): string | undefined {
  try {
    const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
      windowsHide: true,
    }).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

export function environmentText(env: PromptEnvironment, i18n: I18n): string {
  const tag = env.locale === "tr" ? "tr-TR" : "en-US";
  const weekday = new Intl.DateTimeFormat(tag, { weekday: "long" }).format(env.now);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const lines: string[] = [
    i18n.t("prompt.envDate", { date: localDate(env.now), weekday, timeZone }),
    i18n.t("prompt.envOs", { os: osLabel(env.platform, env.osRelease) }),
    i18n.t("prompt.envShell", { shell: env.shell }),
  ];
  if (env.model) {
    lines.push(
      i18n.t("prompt.envModel", {
        name: env.model.name,
        model: `${env.model.provider}/${env.model.id}`,
      }),
    );
  }
  lines.push(
    env.gitBranch ? i18n.t("prompt.envGit", { branch: env.gitBranch }) : i18n.t("prompt.envNoGit"),
  );
  return lines.join("\n");
}

/** Pi'nin `<ad>\n…\n</ad>` sarmalıyla işlediği bölümün içi; yoksa `undefined`. */
export function sectionBody(rendered: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`).exec(rendered);
  return match?.[1];
}

/**
 * `codezal-prompt`: Pi'nin önsözü ("pi içindeki asistan") Codezal kimliğiyle değişir, Pi
 * dokümanları bölümü düşer, sona ortam bölümü (tarih, işletim sistemi, kabuk, model, git dalı) eklenir.
 *
 * Pi önsözü yalnız `customPrompt` ile değiştirir; o zaman araç ve kural bölümlerini de üretmez.
 * Bu ikisi Pi'nin kendi işlediği istemden alınıp adlı bölüm olarak geri konur: kural mantığı
 * (araç kılavuzları, tekrar ayıklama) Pi'de kalır, kopyalanmaz. Adlı bölümler istemin sonuna
 * eklenir; MCP ya da `tool_search` araç yüklediğinde değişen kısım istemin başı değil sonu olur
 * (önek önbelleği olan sağlayıcılarda işe yarar; tek parça önbelleklenen istemde fark etmez).
 *
 * İlk fabrika olarak kaydedilir: bir uzantı `systemPrompt` döndürürse istem o anki hâliyle
 * sabitlenir ve sonraki bölüm değişiklikleri o turda görünmez.
 */
export function promptExtension(deps: {
  identity: () => string;
  environment: (model: PromptEnvironment["model"]) => string;
}) {
  return (pi: ExtensionAPI) => {
    pi.on("before_agent_start", (event, ctx) => {
      const options = event.systemPromptOptions;
      // Başka bir kaynak (SYSTEM.md) önsözü zaten değiştirdiyse ona dokunulmaz.
      if (options.customPrompt === undefined) {
        const rendered = event.systemPrompt;
        const tools = sectionBody(rendered, "tools");
        const rules = sectionBody(rendered, "rules");
        options.customPrompt = deps.identity();
        if (tools) options.sections.tools = tools;
        if (rules) options.sections.rules = rules;
      }
      const model = ctx.model
        ? { name: ctx.model.name, provider: ctx.model.provider, id: ctx.model.id }
        : undefined;
      options.sections.environment = deps.environment(model);
      return undefined;
    });
  };
}

/** Motorun kullandığı ortam: işletim sistemi ve kabuk süreçten, git dalı her turda okunur. */
export function liveEnvironment(input: {
  cwd: string;
  locale: Locale;
  shell: string;
  model: PromptEnvironment["model"];
}): PromptEnvironment {
  return {
    now: new Date(),
    locale: input.locale,
    platform: process.platform,
    osRelease: release(),
    shell: input.shell,
    model: input.model,
    gitBranch: gitBranch(input.cwd),
  };
}
