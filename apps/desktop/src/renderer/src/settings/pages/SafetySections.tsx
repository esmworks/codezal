import type { ResolvedHook } from "@codezal/contracts";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../../api";
import { useCurrentProject } from "../../stores/projects";
import { ButtonRow, Row, Section, ToggleRow } from "../rows";

import type { Patch, S } from "./common";

/** Seatbelt yalnız macOS'ta var; diğer platformlarda anahtar kapalı ve açıklaması bunu söyler. */
const isMac = navigator.userAgent.includes("Mac");

export function SandboxSection({ s, patch }: { s: S; patch: Patch }) {
  const { t } = useTranslation();
  return (
    <Section title={t("settings.safety.title")}>
      <ToggleRow
        first
        label={t("settings.safety.sandboxLabel")}
        desc={isMac ? t("settings.safety.sandboxDesc") : t("settings.safety.sandboxMacOnly")}
        on={isMac && s.bashSandbox}
        onChange={(v) => patch({ bashSandbox: v })}
        {...(isMac ? {} : { disabled: true })}
      />
    </Section>
  );
}

/** Boş ve `*` eşleştirici tüm araçlar demektir (motordaki `hookMatches` ile aynı kural). */
function matcherLabel(matcher: string): string | undefined {
  const m = matcher.trim();
  return m === "" || m === "*" ? undefined : m;
}

/**
 * Etkin hook'ların salt okunur listesi. Düzenleme dosyada yapılır ("Aç"); pencere odağa dönünce
 * liste yeniden okunur ki düzenleyiciden gelen değişiklik görünsün.
 */
export function HooksSection() {
  const { t } = useTranslation();
  const current = useCurrentProject();
  const cwd = current?.path;
  const [hooks, setHooks] = useState<ResolvedHook[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      void invoke("hooks:list", cwd ? { cwd } : {}).then((list) => {
        if (alive) setHooks(list);
      });
    load();
    window.addEventListener("focus", load);
    return () => {
      alive = false;
      window.removeEventListener("focus", load);
    };
  }, [cwd]);
  /** Kaynak dosya kısaltması: proje dosyası proje adıyla, genel dosya "hooks.json (genel)". */
  const sourceLabel = (source: string) => {
    if (current && source.startsWith(current.path)) {
      return `${current.name}${source.slice(current.path.length)}`;
    }
    return t("settings.hooks.globalSource");
  };
  return (
    <Section title={t("settings.hooks.title")}>
      <ButtonRow
        first
        label={t("settings.hooks.fileLabel")}
        desc={t("settings.hooks.fileDesc")}
        value={t("common.open")}
        onClick={() => void invoke("settings:openFile", { which: "hooks" })}
      />
      {hooks.length === 0 ? (
        <Row label={t("settings.hooks.emptyLabel")} desc={t("settings.hooks.emptyDesc")} />
      ) : (
        hooks.map((hook, index) => (
          <Row
            // Aynı dosyada aynı komut iki kez yazılabilir; sıra anahtarı ayırır.
            key={`${hook.source}:${hook.event}:${index}`}
            label={`${hook.event} · ${matcherLabel(hook.matcher) ?? t("settings.hooks.allTools")}`}
            desc={`${hook.command} — ${sourceLabel(hook.source)}`}
          />
        ))
      )}
    </Section>
  );
}
