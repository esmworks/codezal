import { type AppCommand, resolveAccelerator, SHORTCUTS } from "@codezal/contracts";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../../api";
import { Button } from "../../components/Button";
import { isMac } from "../../lib/platform";
import { acceleratorFromEvent, findConflict } from "../../lib/shortcutKeys";
import { useResolvedAccelerator, useShortcutKeys } from "../../shortcuts";
import { Keys, Row, Section } from "../rows";
import type { Patch, S } from "./common";

/** SHORTCUTS etiketleri çeviri anahtarına bağlanır; composer tuşları üç satır sabittir. */
const GROUPS = ["Genel", "Oturum"] as const;
const GROUP_KEY = { Genel: "shortcuts.group.genel", Oturum: "shortcuts.group.oturum" } as const;

// ---------- Klavye kısayolları ----------

/** Satır ayrı bileşen: tuşları çözen kancanın her kısayol için ayrı çağrılması gerekir. */
function ShortcutRow({
  command,
  label,
  first,
  recording,
  custom,
  onRecord,
  onCancel,
  onReset,
}: {
  command: AppCommand;
  label: string;
  first: boolean;
  recording: boolean;
  custom: boolean;
  onRecord: () => void;
  onCancel: () => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const accelerator = useResolvedAccelerator(command);
  const keys = useShortcutKeys(accelerator);
  return (
    <Row label={label} first={first}>
      <div className="flex items-center gap-2">
        {recording ? (
          <>
            <span className="text-[12px] text-amber">{t("shortcuts.recording")}</span>
            <Button variant="ghost" size="sm" onClick={onCancel}>
              {t("shortcuts.cancel")}
            </Button>
          </>
        ) : (
          <>
            <Keys keys={keys} />
            <Button variant="ghost" size="sm" onClick={onRecord}>
              {t("shortcuts.record")}
            </Button>
            {custom ? (
              <Button variant="ghost" size="sm" onClick={onReset}>
                {t("shortcuts.reset")}
              </Button>
            ) : null}
          </>
        )}
      </div>
    </Row>
  );
}

export function ShortcutsPage({ s, patch }: { s: S; patch: Patch }) {
  const { t } = useTranslation();
  const [recording, setRecording] = useState<AppCommand | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Etkin hızlandırıcılar: kayıt sırasında çakışma denetimi bu listeden yapılır.
  const resolved = useMemo(
    () =>
      SHORTCUTS.map((sc) => ({
        command: sc.command,
        accelerator: resolveAccelerator(sc.command, s.keybindings),
        label: t(`shortcuts.${sc.command}.label`),
      })),
    [s.keybindings, t],
  );

  useEffect(() => {
    if (!recording) return;
    // Kayıt sırasında menü hızlandırıcıları askıya alınır; yoksa mevcut kısayol (ör. ⌘K)
    // tuş yakalanmadan önce menü komutunu tetikler.
    void invoke("shortcuts:suspend", { suspended: true });
    const onKey = (event: KeyboardEvent) => {
      // Kayıt kipinde tuş uygulamaya gitmesin (menü kısayolu tetiklenmesin).
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecording(null);
        setNote(null);
        return;
      }
      const accelerator = acceleratorFromEvent(event, isMac);
      if (!accelerator) {
        setNote(t("shortcuts.modifierRequired"));
        return;
      }
      const conflict = findConflict(recording, accelerator, resolved);
      if (conflict) {
        const name = resolved.find((r) => r.command === conflict)?.label ?? conflict;
        setNote(t("shortcuts.conflict", { name }));
        return;
      }
      patch({ keybindings: { ...s.keybindings, [recording]: accelerator } });
      setRecording(null);
      setNote(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      void invoke("shortcuts:suspend", { suspended: false });
    };
  }, [recording, resolved, patch, s.keybindings, t]);

  const resetOne = (command: AppCommand) => {
    const next = { ...s.keybindings };
    delete next[command];
    patch({ keybindings: next });
  };

  const staticRows = [
    { label: t("shortcuts.send"), keys: ["⏎"] },
    { label: t("shortcuts.addLine"), keys: ["⇧", "⏎"] },
    { label: t("shortcuts.stop"), keys: ["⎋"] },
  ];

  return (
    <>
      {note ? <div className="px-1 text-[12px] text-tx2">{note}</div> : null}
      {Object.keys(s.keybindings).length > 0 ? (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={() => patch({ keybindings: {} })}>
            {t("shortcuts.resetAll")}
          </Button>
        </div>
      ) : null}
      {GROUPS.map((g) => {
        const rows = SHORTCUTS.filter((sc) => sc.group === g);
        return (
          <Section key={g} title={t(GROUP_KEY[g])}>
            {rows.map((sc, i) => (
              <ShortcutRow
                key={sc.command}
                command={sc.command}
                label={t(`shortcuts.${sc.command}.label`)}
                first={i === 0}
                recording={recording === sc.command}
                custom={Boolean(s.keybindings[sc.command])}
                onRecord={() => {
                  setRecording(sc.command);
                  setNote(null);
                }}
                onCancel={() => {
                  setRecording(null);
                  setNote(null);
                }}
                onReset={() => resetOne(sc.command)}
              />
            ))}
            {g === "Oturum"
              ? staticRows.map((r) => (
                  <Row key={r.label} label={r.label} first={false}>
                    <Keys keys={r.keys} />
                  </Row>
                ))
              : null}
          </Section>
        );
      })}
    </>
  );
}
