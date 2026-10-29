import type { WorktreeInfo } from "@codezal/contracts";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../../api";
import { Button } from "../../components/Button";
import { askConfirm } from "../../components/Confirm";
import { useApp } from "../../stores/app";
import { useCurrentProject } from "../../stores/projects";
import { useSessions } from "../../stores/sessions";
import { ButtonRow, Row, Section, ToggleRow } from "../rows";

import type { Patch, S } from "./common";

// ---------- Worktree ----------

export function WorktreePage({ s, patch }: { s: S; patch: Patch }) {
  const { t } = useTranslation();
  const current = useCurrentProject();
  const [list, setList] = useState<WorktreeInfo[]>([]);
  const openSession = useApp((a) => a.openSession);
  const sessions = useSessions((x) => x.list);
  const reload = useCallback(() => {
    if (current?.isGit) void invoke("worktree:list", { cwd: current.path }).then(setList);
  }, [current]);
  useEffect(reload, [reload]);
  const stateOf = (w: WorktreeInfo) =>
    w.changedFiles
      ? t("settings.worktree.changed", { count: w.changedFiles })
      : t("settings.worktree.clean");
  return (
    <>
      <Section title={t("settings.worktree.locationTitle")}>
        <ButtonRow
          first
          label={t("settings.worktree.rootLabel")}
          desc={s.worktreeRoot || t("settings.worktree.rootDescDefault")}
          value={t("settings.worktree.change")}
          onClick={() =>
            void invoke("settings:pickFolder", { title: t("settings.worktree.rootLabel") }).then(
              (p) => p && patch({ worktreeRoot: p }),
            )
          }
          extra={
            s.worktreeRoot ? (
              <Button variant="ghost" size="sm" onClick={() => patch({ worktreeRoot: "" })}>
                {t("settings.worktree.reset")}
              </Button>
            ) : null
          }
        />
        <ToggleRow
          label={t("settings.worktree.perTaskLabel")}
          desc={t("settings.worktree.perTaskDesc")}
          on={s.worktreePerTask}
          onChange={(v) => patch({ worktreePerTask: v })}
        />
        <ToggleRow
          label={t("settings.worktree.cleanLabel")}
          desc={t("settings.worktree.cleanDesc")}
          on={s.worktreeClean}
          onChange={(v) => patch({ worktreeClean: v })}
        />
      </Section>
      <Section
        title={
          current
            ? t("settings.worktree.activeTitle", { name: current.name })
            : t("settings.worktree.activeTitleNone")
        }
      >
        {!current?.isGit ? (
          <Row
            first
            label={t("settings.worktree.noGitLabel")}
            desc={t("settings.worktree.noGitDesc")}
          />
        ) : null}
        {list.map((w, i) => {
          const sess = sessions.find((x) => x.cwd === w.path);
          return (
            <ButtonRow
              key={w.path}
              first={i === 0}
              label={w.name}
              desc={`${w.branch} · ${stateOf(w)}${w.isMain ? ` · ${t("settings.worktree.mainTag")}` : ""}`}
              value={sess ? t("common.open") : t("settings.worktree.remove")}
              danger={!sess && !w.isMain}
              disabled={w.isMain}
              onClick={() => {
                if (sess) {
                  openSession(sess.id);
                  useApp.getState().setSettingsOpen(false);
                  return;
                }
                if (!current) return;
                void askConfirm({
                  title: t("settings.worktree.remove"),
                  body: t("settings.worktree.confirmRemove", { name: w.name }),
                  okLabel: t("settings.worktree.remove"),
                  danger: true,
                }).then((ok) => {
                  if (ok)
                    void invoke("worktree:remove", { cwd: current.path, path: w.path }).then(
                      reload,
                    );
                });
              }}
            />
          );
        })}
      </Section>
    </>
  );
}
