import { TEST_IDS, testId } from "@codezal/contracts";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { matchesFold } from "../lib/searchText";
import { commandName, SLASH_COMMANDS, type SlashCommand, usageLine } from "../lib/slashCommands";
import { useApp } from "../stores/app";
import { toast } from "../stores/toast";
import { homeCommandPorts, sessionCommandPorts } from "./commandPorts";
import { runSlashCommand } from "./commands";

/**
 * Komut ekranı (`/yardım`): katalogdaki komutlar, kullanımları ve açıklamaları tek listede.
 * ZCode'un `/help` çıktısının masaüstü karşılığıdır. Satır çalıştırılabilirse (yerel eylem,
 * argüman istemeyen) tıklanınca çalışır ve ekran kapanır; argüman isteyen komutlar yalnız
 * kullanımlarını gösterir — ekran onları yazacak yeri (composer) bilmez.
 */
export function CommandsScreen() {
  const { t } = useTranslation();
  const mode = useApp((s) => s.mode);
  const activeSessionId = useApp((s) => s.activeSessionId);
  const query = useApp((s) => s.commandsQuery);
  const setCommandsOpen = useApp((s) => s.setCommandsOpen);
  const [q, setQ] = useState(query);

  const close = () => setCommandsOpen(false);

  // Sorgu dışarıdan gelir (`/yardım model`); ekran açılırken kutuya yazılır.
  useEffect(() => setQ(query), [query]);

  // Escape odak nerede olursa olsun ekranı kapatır: kullanıcı bir satıra tıkladıktan sonra odak
  // kutudan çıkabilir ve tam ekran örtünün altındaki uygulamanın Escape'i çalışmamalıdır.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setCommandsOpen(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [setCommandsOpen]);

  const commands = useMemo(() => {
    const needle = q.trim();
    // Komutlar tek yerde listelenir (kısayol + eylem): kullanıcı hangi biçimin hangi işi
    // yaptığını kullanımdan okur, listenin ikiye bölünmesi keşfi zorlaştırıyordu.
    return SLASH_COMMANDS.filter((c) => !c.onlyIn || c.onlyIn === mode).filter(
      (c) =>
        !needle ||
        matchesFold(
          `${c.name} ${c.aliases.join(" ")} ${usageLine(c, t)} ${t(c.labelKey)} ${t(c.descKey)}`,
          needle,
        ),
    );
  }, [q, mode, t]);

  const ports = () => (activeSessionId ? sessionCommandPorts(activeSessionId) : homeCommandPorts());

  /** Satır çalıştırılabilir mi: yerel eylem ve argüman istemeyen komutlar tek tıkla yürür. */
  const runnable = (command: SlashCommand) =>
    command.action && !command.takesArgs && (!command.sessionOnly || !!activeSessionId);

  const run = (command: SlashCommand) => {
    if (!runnable(command)) return;
    // Komut, ekranda görünen kanonik adıyla çalıştırılır (`/help`); Türkçe takma adlar da
    // çözümleyicide geçerlidir.
    const text = `/${commandName(command)}`;
    void runSlashCommand(text, ports())
      .then(() => close())
      .catch((error: unknown) => {
        // Ekran açık kalır: kullanıcı hatayı okuyup komutu düzeltilmiş hâliyle yazabilsin.
        toast.error(error instanceof Error ? error.message : String(error));
      });
  };

  return (
    <div
      className="fixed inset-0 z-[120] flex items-start justify-center bg-[var(--scrim)] pt-[12vh]"
      onClick={close}
    >
      <div
        {...testId(TEST_IDS.commandsScreen)}
        role="dialog"
        aria-modal="true"
        aria-label={t("commands.screenTitle")}
        className="w-[620px] max-w-[92vw] overflow-hidden rounded-[14px] border border-line2 bg-card shadow-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <Icon name="info" size={15} className="text-tx3" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("commands.searchPlaceholder")}
            className="flex-1 bg-transparent text-[14px] text-tx outline-none placeholder:text-tx3"
          />
          <span className="font-mono text-[12px] text-tx3">⎋</span>
        </div>
        <div className="max-h-[56vh] overflow-y-auto p-[6px]">
          {commands.length === 0 ? (
            <div className="px-3 py-4 text-[13px] text-tx3">{t("commands.noMatch")}</div>
          ) : null}
          {commands.map((command) => {
            const can = runnable(command);
            return (
              <button
                type="button"
                key={command.name}
                onClick={() => run(command)}
                // Çalıştırılamayan satır düğme gibi görünmez: imleç de değişmez.
                className={`flex w-full items-start gap-3 rounded-[8px] px-3 py-2 text-left ${
                  can ? "hover:bg-hov" : "cursor-default"
                }`}
              >
                <Icon
                  name={command.icon}
                  size={15}
                  className={`mt-[2px] shrink-0 ${command.color}`}
                />
                <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                  <span className="flex items-baseline gap-2">
                    <span className="shrink-0 text-[13px] font-medium text-tx">
                      {t(command.labelKey)}
                    </span>
                    <span className="min-w-0 truncate font-mono text-[12px] text-tx3">
                      {usageLine(command, t)}
                    </span>
                  </span>
                  <span className="text-[12px] text-tx3">{t(command.descKey)}</span>
                </span>
                {can ? (
                  <span className="mt-[2px] shrink-0 font-mono text-[11px] text-tx3">
                    {t("commands.run")}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        <div className="border-t border-line px-4 py-2 text-[12px] text-tx3">
          {t("commands.screenHint")}
        </div>
      </div>
    </div>
  );
}
