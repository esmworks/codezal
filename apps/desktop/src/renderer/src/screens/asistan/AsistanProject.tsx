import { type AssistantContext, formatBytes, type ImageAttachment } from "@codezal/contracts";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../../api";
import { askConfirm } from "../../components/Confirm";
import { ErrorBar, splitError } from "../../components/ErrorBar";
import { Icon } from "../../components/Icon";
import { addMemoryNote, MemoryList } from "../../components/MemoryList";
import { askText } from "../../components/Prompt";
import { shortAgo } from "../../lib/format";
import { useLocale } from "../../lib/i18n";
import { expandPrompt } from "../../lib/promptText";
import { useNow } from "../../lib/useNow";
import { Composer } from "../../session/Composer";
import { useComposerPalette } from "../../session/ComposerPalette";
import { HomeChips } from "../../session/chips";
import type { ComposerDraft } from "../../session/composerParts";
import { useApp } from "../../stores/app";
import { useAssistant } from "../../stores/assistant";
import { draftFor, useDrafts } from "../../stores/drafts";
import { useMenu } from "../../stores/menu";
import { useModels } from "../../stores/models";
import { useSessions } from "../../stores/sessions";
import { describeSchedule, ScheduleModal } from "./ScheduleModal";

/** Asistan proje ekranı: görevler, talimatlar, bellek, bağlam, zamanlanmış (TODO 4). */
export function AsistanProject({ id }: { id: string }) {
  const { t } = useTranslation();
  const lang = useLocale();
  const now = useNow();
  const { openSession, setMode } = useApp();
  const { projects, tasks, saveProject, deleteProject, cwdFor, load, copyContext, removeContext } =
    useAssistant();
  const project = projects.find((p) => p.id === id);
  const { model, thinking, permission } = useModels();
  const create = useSessions((s) => s.create);
  const runCommand = useSessions((s) => s.runCommand);
  const allSessions = useSessions((s) => s.list);
  // Seçicide filter yeni dizi döndürür ve React sonsuz döngüye girer; burada memo ile süz.
  const sessions = useMemo(
    () => allSessions.filter((x) => x.projectId === id && !x.archived),
    [allSessions, id],
  );
  const openAt = useMenu((s) => s.openAt);
  const [schedule, setSchedule] = useState<"new" | string | null>(null);
  const [editInstr, setEditInstr] = useState(false);
  const [instr, setInstr] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** Kopyalanan bağlamın `value`su; satır düğmesi bu sırada kilitli kalır. */
  const [copying, setCopying] = useState<string | null>(null);
  // Proje başına taslak: oturuma gidip dönünce metin ve görseller yerinde kalır.
  const draftKey = `project:${id}`;
  const [draft] = useState<ComposerDraft | null>(() => draftFor(draftKey));
  const saveDraft = useDrafts((s) => s.set);
  const palette = useComposerPalette({ cwd: cwdFor(id), mode: "asistan", size: 26 });

  useEffect(() => {
    if (!project) void load();
  }, [project, load]);

  if (!project)
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-tx3">
        {t("asistan.loading")}
      </div>
    );

  const send = async (text: string, images: ImageAttachment[] = []) => {
    // Yerel komut (`/yardım`, `/model`) sağlayıcı denetiminden önce sorulur: oturum açmadan
    // çalışır ve gönderimi bitirir; bağlı sağlayıcı yokken de çalışabilmelidir.
    if (await runCommand(text)) return;
    // Gönderim başarısızsa Composer taslağı geri yükler; hata toast'ı da oradan gelir.
    if (!model) throw new Error(t("asistan.noProvider"));
    const s = await create(
      {
        cwd: cwdFor(id),
        mode: "asistan",
        model,
        thinking,
        permission,
        location: "local",
        projectId: id,
      },
      text,
      images,
    );
    if (s) openSession(s.id, "asistan");
  };

  /** Composer dışı gönderimler (zamanlanmış görev): hata fırlatmaz, ekranda gösterilir. */
  const submit = (text: string) =>
    void send(text).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));

  const memoryScope = { kind: "asistan", projectId: id } as const;

  const addContext = (e: React.MouseEvent) =>
    openAt(e.currentTarget as HTMLElement, {
      items: [
        {
          label: t("settings.skills.addFolder"),
          icon: "folder",
          onSelect: () =>
            void invoke("settings:pickFolder", { title: t("asistan.contextFolderTitle") }).then(
              (p) => {
                if (p)
                  void saveProject({
                    ...project,
                    context: [
                      ...project.context,
                      { kind: "folder", value: p, label: p.split("/").pop() ?? p, copy: null },
                    ],
                  });
              },
            ),
        },
        {
          label: t("asistan.addFile"),
          icon: "file",
          onSelect: () =>
            void invoke("files:pickFiles", { title: t("asistan.contextFileTitle") }).then(
              (paths) => {
                // Bağlam yerinde okunur; istenirse satır düğmesiyle proje klasörüne kopyalanır.
                const known = new Set(project.context.map((c) => c.value));
                const added: AssistantContext[] = paths
                  .filter((p) => !known.has(p))
                  .map((p) => ({
                    kind: "file",
                    value: p,
                    label: p.split("/").pop() ?? p,
                    copy: null,
                  }));
                if (added.length)
                  void saveProject({ ...project, context: [...project.context, ...added] });
              },
            ),
        },
        {
          label: t("asistan.addLink"),
          icon: "globe",
          onSelect: () => {
            void askText({ title: t("asistan.linkTitle"), initial: "https://" }).then((p) => {
              if (p)
                void saveProject({
                  ...project,
                  context: [
                    ...project.context,
                    { kind: "link", value: p, label: p.replace(/^https?:\/\//, ""), copy: null },
                  ],
                });
            });
          },
        },
      ],
    });
  /** Bağlamı proje klasörüne kopyalar; 500 MB üstünde önce onay ister. */
  const copy = async (c: AssistantContext) => {
    setCopying(c.value);
    setError(null);
    try {
      const first = await copyContext(id, c.value);
      if (first.needsConfirm) {
        const ok = await askConfirm({
          title: t("asistan.contextCopyConfirmTitle"),
          body: t("asistan.contextCopyConfirmBody", {
            name: c.label,
            size: formatBytes(first.bytes, lang),
          }),
        });
        if (!ok) return;
        await copyContext(id, c.value, true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCopying(null);
    }
  };

  const remove = async (c: AssistantContext) => {
    // Kopya çöp kutusuna gideceği için bağlamı kaldırmadan önce haber ver.
    if (c.copy) {
      const ok = await askConfirm({
        title: t("asistan.contextRemoveTitle"),
        body: t("asistan.contextRemoveCopyBody", { name: c.label }),
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await removeContext(id, c.value);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const projectMenu = (e: React.MouseEvent) =>
    openAt(e.currentTarget as HTMLElement, {
      items: [
        {
          label: t("sidebar.rename"),
          icon: "pen",
          onSelect: () => {
            void askText({ title: t("sidebar.projectName"), initial: project.name }).then((n) => {
              if (n) void saveProject({ ...project, name: n });
            });
          },
        },
        {
          label: t("asistan.descriptionMenu"),
          icon: "docs",
          onSelect: () => {
            void askText({
              title: t("asistan.descriptionTitle"),
              initial: project.description,
            }).then((d) => {
              if (d !== null) void saveProject({ ...project, description: d });
            });
          },
        },
        {
          label: t("sidebar.deleteProject"),
          icon: "trash",
          danger: true,
          top: true,
          onSelect: () => {
            void askConfirm({
              title: t("sidebar.deleteProject"),
              body: t("asistan.confirmDeleteProject", { name: project.name }),
              danger: true,
            }).then((ok) => {
              if (ok) void deleteProject(id).then(() => setMode("asistan"));
            });
          },
        },
      ],
    });

  const projectTasks = tasks.filter((t) => t.projectId === id);
  const editing = schedule && schedule !== "new" ? tasks.find((t) => t.id === schedule) : undefined;
  const ctxIcon = (k: AssistantContext["kind"]) =>
    k === "folder" ? "folder" : k === "file" ? "file" : "globe";

  return (
    // Sohbet ekranıyla aynı yerleşim: iki sütun ayrı kayar, sağ panel gezinirken
    // başlık ve yazma kutusu yukarı kaçmaz.
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col items-center gap-5 overflow-y-auto px-7 pt-[22px] pb-10">
        <div className="flex w-full max-w-[640px] items-center gap-2 text-[13px] text-tx3">
          <button type="button" onClick={() => setMode("asistan")} className="hover:text-tx">
            {t("asistan.projects")}
          </button>
          <span>/</span>
          <span className="text-tx2">{project.name}</span>
        </div>
        <div className="flex w-full max-w-[640px] items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[28px] font-semibold tracking-[-0.02em]">{project.name}</div>
            <div className="pt-1 text-[13px] text-tx3">
              {project.description || t("asistan.addDescription")}
            </div>
          </div>
          <button
            type="button"
            onClick={projectMenu}
            className="flex h-7 w-7 items-center justify-center rounded-[7px] text-tx3 hover:bg-hov hover:text-tx"
          >
            ⋮
          </button>
        </div>
        <div className="relative w-full max-w-[640px]">
          <Composer
            ref={palette.composerRef}
            hideAttach
            draft={draft}
            onDraft={(d) => saveDraft(draftKey, d)}
            placeholder={t("asistan.projectComposer")}
            variant="home"
            onSend={(text, imgs) => send(expandPrompt(text, lang), imgs)}
            slash={palette.slash}
            left={palette.button}
            right={<HomeChips />}
          />
          {error ? (
            <ErrorBar {...splitError(error)} onDismiss={() => setError(null)} className="mt-2" />
          ) : null}
        </div>
        <div className="flex w-full max-w-[640px] flex-col gap-2">
          <div className="text-[12px] uppercase tracking-[0.06em] text-tx3">
            {t("asistan.projectTasks")}
          </div>
          {sessions.length === 0 ? (
            <div className="text-[13px] text-tx3">{t("asistan.noTasks")}</div>
          ) : null}
          {sessions.map((s) => (
            <button
              type="button"
              key={s.id}
              onClick={() => openSession(s.id, "asistan")}
              className="flex items-center gap-[11px] rounded-[10px] border border-line bg-card2 px-3 py-[9px] text-left hover:border-line2"
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${s.live ? "animate-pulse bg-green" : "bg-tx3"}`}
              />
              <span className="min-w-0 flex-1 truncate text-[14px]">{s.name}</span>
              <span className="font-mono text-[12px] text-tx3">
                {shortAgo(s.modifiedAt, lang, now)}
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 w-[312px] shrink-0 overflow-y-auto pt-14 pr-6 pb-10">
        <div className="flex flex-col rounded-[14px] border border-line bg-card2">
          <div className="flex flex-col gap-[5px] px-4 py-[14px]">
            <div className="flex items-center">
              <div className="flex-1 text-[14px] font-semibold">{t("asistan.instructions")}</div>
              <button
                type="button"
                onClick={() => {
                  setInstr(project.instructions);
                  setEditInstr(!editInstr);
                }}
                className="flex h-[22px] w-[22px] items-center justify-center rounded-[6px] text-tx3 hover:bg-chip hover:text-tx"
              >
                <Icon name={editInstr ? "x" : "pen"} size={13} stroke={2} />
              </button>
            </div>
            {editInstr ? (
              <div className="flex flex-col gap-2">
                <textarea
                  value={instr}
                  onChange={(e) => setInstr(e.target.value)}
                  rows={4}
                  className="w-full resize-y rounded-[8px] border border-line2 bg-card px-2 py-1 text-[13px] text-tx outline-none"
                />
                <button
                  type="button"
                  onClick={() => {
                    void saveProject({ ...project, instructions: instr });
                    setEditInstr(false);
                  }}
                  className="self-end text-[12px] text-accTx hover:text-tx"
                >
                  {t("common.save")}
                </button>
              </div>
            ) : (
              <div className="text-[13px] leading-[1.5] text-tx3">
                {project.instructions || t("asistan.instructionsEmpty")}
              </div>
            )}
          </div>
          <div className="flex flex-col gap-2 border-t border-line px-4 py-[14px]">
            <div className="flex items-center gap-2">
              <div className="flex-1 text-[14px] font-semibold">{t("asistan.memory")}</div>
              <span className="flex items-center gap-[5px] rounded-full border border-line bg-chip px-2 py-[2px] text-[12px] text-tx2">
                <Icon name="permAsk" size={10} stroke={2} />
                {t("asistan.onlyYou")}
              </span>
              <button
                type="button"
                onClick={() => void addMemoryNote(memoryScope)}
                title={t("settings.memory.addNote")}
                className="flex h-[22px] w-[22px] items-center justify-center rounded-[6px] text-tx3 hover:bg-chip hover:text-tx"
              >
                <Icon name="plus" size={13} stroke={2} />
              </button>
            </div>
            <MemoryList scope={memoryScope} empty={t("asistan.memoryEmpty")} />
          </div>
          <div className="flex flex-col gap-[9px] border-t border-line px-4 py-[14px]">
            <div className="flex items-center">
              <div className="flex-1 text-[14px] font-semibold">{t("asistan.context")}</div>
              <button
                type="button"
                onClick={addContext}
                className="flex h-[22px] w-[22px] items-center justify-center rounded-[6px] text-tx3 hover:bg-chip hover:text-tx"
              >
                <Icon name="plus" size={13} stroke={2} />
              </button>
            </div>
            {project.context.length === 0 ? (
              <div className="text-[13px] text-tx3">{t("asistan.contextEmpty")}</div>
            ) : (
              // Uzun bağlam listesi paneli uzatmasın: görev ekranındaki Bağlam kutusuyla aynı
              // ölçüde kendi içinde kayar, altındaki Zamanlanmış bölümü aşağı itilmez.
              <div className="flex max-h-[236px] flex-col gap-[9px] overflow-y-auto">
                {project.context.map((c) => (
                  <div
                    key={`${c.kind}:${c.value}`}
                    className="group flex items-center gap-2 text-[13px] text-tx2"
                  >
                    <Icon name={ctxIcon(c.kind)} size={13} className="shrink-0" />
                    <span
                      className="min-w-0 flex-1 truncate"
                      title={c.copy ? c.copy.path : c.value}
                    >
                      {c.label}
                    </span>
                    {c.copy ? (
                      <span
                        title={t("asistan.contextCopied", {
                          time: shortAgo(c.copy.copiedAt, lang, now),
                        })}
                        className="shrink-0 text-green"
                      >
                        <Icon name="check" size={11} stroke={2} />
                      </span>
                    ) : null}
                    {c.kind === "link" ? null : (
                      <button
                        type="button"
                        title={c.copy ? t("asistan.contextRefresh") : t("asistan.contextCopy")}
                        disabled={copying === c.value}
                        onClick={() => void copy(c)}
                        className="invisible shrink-0 text-tx3 hover:text-tx group-hover:visible disabled:opacity-40"
                      >
                        <Icon name="copy" size={11} stroke={2} />
                      </button>
                    )}
                    <button
                      type="button"
                      title={c.copy ? t("asistan.contextRemoveTitle") : undefined}
                      onClick={() => void remove(c)}
                      className="invisible shrink-0 text-tx3 hover:text-red group-hover:visible"
                    >
                      <Icon name="x" size={11} stroke={2} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="flex flex-col gap-[9px] border-t border-line px-4 py-[14px]">
            <div className="flex items-center">
              <div className="flex-1 text-[14px] font-semibold">{t("asistan.scheduledShort")}</div>
              <button
                type="button"
                title={t("asistan.newSchedule")}
                onClick={(e) =>
                  openAt(e.currentTarget, {
                    minWidth: 280,
                    items: [
                      {
                        label: t("asistan.scheduleWithAssistant"),
                        desc: t("asistan.scheduleWithAssistantDesc"),
                        icon: "sparkle",
                        onSelect: () => submit(t("asistan.scheduleWithAssistantPrompt")),
                      },
                      {
                        label: t("asistan.scheduleManually"),
                        desc: t("asistan.scheduleManuallyDesc"),
                        icon: "pen",
                        onSelect: () => setSchedule("new"),
                      },
                    ],
                  })
                }
                className="flex h-[22px] w-[22px] items-center justify-center rounded-[6px] text-tx3 hover:bg-chip hover:text-tx"
              >
                <Icon name="plus" size={13} stroke={2} />
              </button>
            </div>
            {projectTasks.length === 0 ? (
              <div className="text-[13px] text-tx3">{t("asistan.noScheduledProject")}</div>
            ) : null}
            {projectTasks.map((t) => (
              <button
                type="button"
                key={t.id}
                onClick={() => setSchedule(t.id)}
                className="flex items-center gap-[9px] text-left"
              >
                <span
                  className={`h-[7px] w-[7px] shrink-0 rounded-full ${t.paused ? "bg-tx3" : "animate-pulse bg-green"}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] text-tx">{t.title}</div>
                  <div className="text-[12px] text-tx3">{describeSchedule(t)}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
      {schedule ? (
        <ScheduleModal
          projectId={id}
          {...(editing ? { initial: editing } : {})}
          onClose={() => setSchedule(null)}
        />
      ) : null}
    </div>
  );
}
