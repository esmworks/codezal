import type { AssistantContext, FileNode } from "@codezal/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../../api";
import { askConfirm } from "../../components/Confirm";
import { Icon } from "../../components/Icon";
import { askText } from "../../components/Prompt";
import { CHAT_COLUMN, composerPad, FLOAT_PANEL_WIDTH, RAIL_PAD_CLASS } from "../../lib/floatPanel";
import { basename } from "../../lib/format";
import { useLocale } from "../../lib/i18n";
import { mergeDiskOutputs, taskOutputs } from "../../lib/outputs";
import { padRight } from "../../lib/platform";
import { openStepsOfLastTurn, progressSteps } from "../../lib/progress";
import { expandPrompt } from "../../lib/promptText";
import { withMentions } from "../../lib/skills";
import { useWindowWidth } from "../../lib/useWindowWidth";
import { Composer, type ComposerHandle } from "../../session/Composer";
import { useComposerPalette } from "../../session/ComposerPalette";
import { SessionChips, SessionPermissionChip } from "../../session/chips";
import { type ComposerDraft, emptyDraft } from "../../session/composerParts";
import { SideChatPanel } from "../../session/SideChatPanel";
import { Transcript } from "../../session/Transcript";
import { TITLE_BAR_HEIGHT, titleLeftInset } from "../../shell/titleBarMetrics";
import { useApp } from "../../stores/app";
import { useAssistant } from "../../stores/assistant";
import { draftFor, useDrafts } from "../../stores/drafts";
import { useMenu } from "../../stores/menu";
import { type ForkPoint, useSessions } from "../../stores/sessions";
import { humanizeError, toast } from "../../stores/toast";
import { OutputViewer } from "./OutputViewer";
import { TaskBoxes } from "./TaskBoxes";

/** Asistan görev ekranı: sohbet + sağda ilerleme, çıktılar, proje ve bağlam (TODO 4). */
export function AsistanTask({ id }: { id: string }) {
  const { t } = useTranslation();
  const lang = useLocale();
  const {
    taskBoxesOpen,
    toggleTaskBoxes,
    openProject,
    setMode,
    goHome,
    leaveSession,
    sidebarOpen,
    sidebarWidth,
    contextToProject,
    setContextToProject,
  } = useApp();
  const winW = useWindowWidth();
  const avail = winW - (sidebarOpen ? sidebarWidth : 0);

  const summary = useSessions((s) => s.list.find((x) => x.id === id));
  const rt = useSessions((s) => s.runtime[id]);
  const {
    open,
    prompt,
    abort,
    respond,
    respondPlan,
    respondQuestion,
    respondExtensionUi,
    rename,
    remove,
    fork,
    rewind,
    openSide,
  } = useSessions();
  const openSession = useApp((s) => s.openSession);
  const sideOpen = useSessions((s) => s.side[id]?.open === true);
  const sideComposer = useRef<ComposerHandle>(null);
  // Yan sohbet (Kodlama'daki gibi): açıksa seçilen metin panelin kutusuna alıntı olarak eklenir,
  // değilse panel alıntıyla açılır.
  const startSide = useCallback(
    (quote?: string) => {
      if (useSessions.getState().side[id]?.open) {
        if (quote) sideComposer.current?.addQuote(quote);
        return;
      }
      void openSide(id, quote).catch((e: unknown) => toast.error(humanizeError(e)));
    },
    [id, openSide],
  );
  const projects = useAssistant((s) => s.projects);
  const saveProject = useAssistant((s) => s.saveProject);
  const outputsDirFor = useAssistant((s) => s.outputsDirFor);
  const project = projects.find((p) => p.id === summary?.projectId);
  const openAt = useMenu((s) => s.openAt);
  const [openOutput, setOpenOutput] = useState<string | null>(null);
  const [viewerFull, setViewerFull] = useState(false);
  // Geri sarınca mesaj metni yazma kutusuna döner (Composer hidrasyon sayacıyla tazelenir).
  // Oturuma dönüldüğünde gönderilmemiş taslak (metin + yapıştırma parçaları + görseller) geri gelir.
  const [draft, setDraft] = useState<ComposerDraft | null>(() => draftFor(id));
  const saveDraft = useDrafts((s) => s.set);
  const [draftSeq, setDraftSeq] = useState(0);
  const putDraft = ({ text, quotes }: { text: string; quotes: string[] }) => {
    const next: ComposerDraft = { ...emptyDraft(), text, quotes };
    setDraft(next);
    saveDraft(id, next);
    setDraftSeq((n) => n + 1);
  };
  const palette = useComposerPalette({ cwd: summary?.cwd ?? null, mode: "asistan" });

  useEffect(() => {
    // Kayıp/geçersiz oturum kimliği: hata sessizce yutulmasın, listeye dön.
    // Bu arada başka sohbete geçildiyse bayat hata oradan atmasın.
    void open(id).catch((e: unknown) => {
      toast.error(e instanceof Error ? e.message : String(e));
      leaveSession(id);
    });
  }, [id, open, leaveSession]);

  const steps = progressSteps(rt?.transcript ?? []);
  const transcript = rt?.transcript;
  // Tur bittiğinde açık kalan adımlar kutuda kalsın (EnvBox ile aynı kural).
  const openLeft = openStepsOfLastTurn(rt?.transcript ?? []).length;
  const outputsDir = outputsDirFor(summary?.projectId ?? null);
  const busy = rt?.status === "working";
  // Tur gerçekten bitti mi: izin sorusu beklerken durum "waiting" olur, bu bitiş sayılmaz.
  const running = !!rt && (rt.status !== "idle" || rt.permissions.length > 0);
  // Çıktı klasörü diskten de okunur: terminal komutuyla üretilen PDF vb. transkriptte yoktur.
  // Her araç bitişinde ve tur sonunda yenilenir; klasör yoksa ya da okunamazsa liste boş kalır.
  const [diskFiles, setDiskFiles] = useState<FileNode[]>([]);
  const settledTools = (transcript ?? []).filter(
    (i) => i.type === "tool" && i.status !== "running",
  ).length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: settledTools ve running yalnızca yenileme tetikleyicisidir
  useEffect(() => {
    if (!outputsDir) return;
    let cancelled = false;
    invoke("files:list", { root: outputsDir, dir: outputsDir })
      .then((nodes) => {
        if (!cancelled) setDiskFiles(nodes);
      })
      .catch(() => {
        if (!cancelled) setDiskFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [outputsDir, settledTools, running]);
  // Süren görevde üst uç yok; duran görevde son etkinliği geçen dosyalar başka göreve aittir.
  const outputsUntil = running ? undefined : summary?.modifiedAt;
  const outputs = useMemo(
    () =>
      mergeDiskOutputs(
        taskOutputs(transcript ?? [], summary?.cwd ?? ""),
        diskFiles,
        summary?.createdAt ?? 0,
        outputsUntil,
      ),
    [transcript, summary?.cwd, summary?.createdAt, diskFiles, outputsUntil],
  );
  const outputPathList = useMemo(() => outputs.map((o) => o.path), [outputs]);
  // Bağlam: yalnızca okunan dosyalar; bu görevde üretilen çıktılar Çıktılar kutusunda, burada tekrar etmez.
  const outputPaths = new Set(outputs.map((o) => o.path));
  const readFiles = [
    ...new Set(
      (transcript ?? []).flatMap((t) =>
        t.type === "tool" && t.kind === "read" && t.target && !outputPaths.has(t.target)
          ? [t.target]
          : [],
      ),
    ),
  ];
  // Tur bitince tek bir Markdown çıktısı varsa görüntüleyici kendiliğinden açılır: rapor,
  // plan ve özetler tek .md olarak yazılır (prompt.outputsRule), kullanıcı zaten onu okumak ister.
  // Birden çok dosyada hangisinin açılacağı belirsiz olduğundan seçim kullanıcıda kalır.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (running) {
      wasRunning.current = true;
      return;
    }
    if (!wasRunning.current) return;
    // Anahtar değişimi ya da yeniden deneme sırasında tur bir an boşta görünür. Kısa bekleme bu
    // sahte bitişleri eler; gerçekten bittiyse durum boşta kalır ve görüntüleyici açılır.
    const timer = window.setTimeout(() => {
      wasRunning.current = false;
      const only = outputs.length === 1 ? outputs[0] : undefined;
      if (only && !only.running && only.name.endsWith(".md"))
        setOpenOutput((cur) => cur ?? only.path);
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [running, outputs]);
  // Görüntüleyici: çıktı listesindeki dosya ya da tur altından açılan herhangi bir yol.
  const viewing = openOutput
    ? (outputs.find((o) => o.path === openOutput) ?? {
        path: openOutput,
        name: basename(openOutput),
        at: 0,
        running: false,
      })
    : undefined;
  // Yüzen kutular Kodlama ekranındaki gibi sohbetin üstünde; varsayılan açık, düğme gizler.
  const showBoxes = taskBoxesOpen && avail >= 980 && !viewing;
  // Yan sohbet görev kutularıyla aynı sağ yüzen kolonu kullanır; açıkken kutular gizlenir.
  const floatCol = showBoxes || sideOpen;
  // Bağlam kutusundaki "+": seçilen klasör/dosya `@yol` olarak, bağlantı düz metin olarak yazma
  // kutusuna eklenir ve kutu odaklanır. Tur hemen başlamaz; kullanıcı sorusunu yazıp gönderir,
  // ajan önce bunları okur. "Projeye de kaydet" açıksa seçilenler proje bağlamına da yazılır;
  // sonraki görevler onları sistem isteminde görür.
  const addContext = (anchor: HTMLElement) => {
    const c = palette.composerRef.current;
    const persistToProject = (items: AssistantContext[]) => {
      if (!contextToProject || !project) return;
      const known = new Set(project.context.map((x) => x.value));
      const added = items.filter((x) => !known.has(x.value));
      if (added.length)
        void saveProject({ ...project, context: [...project.context, ...added] }).catch(
          (e: unknown) => toast.error(e instanceof Error ? e.message : String(e)),
        );
    };
    const appendPaths = (kind: "folder" | "file", paths: string[]) => {
      if (paths.length === 0) return;
      c?.setText(withMentions(c.getDraft().text, paths));
      persistToProject(paths.map((p) => ({ kind, value: p, label: basename(p) || p, copy: null })));
    };
    openAt(anchor, {
      items: [
        {
          label: t("settings.skills.addFolder"),
          icon: "folder",
          onSelect: () =>
            void invoke("settings:pickFolder", { title: t("asistan.contextFolderTitle") }).then(
              (p) => appendPaths("folder", p ? [p] : []),
            ),
        },
        {
          label: t("asistan.addFile"),
          icon: "file",
          onSelect: () =>
            void invoke("files:pickFiles", { title: t("asistan.contextFileTitle") }).then((paths) =>
              appendPaths("file", paths),
            ),
        },
        {
          label: t("asistan.addLink"),
          icon: "globe",
          onSelect: () =>
            void askText({ title: t("asistan.linkTitle"), initial: "https://" }).then((url) => {
              if (!url || url === "https://") return;
              const text = c?.getDraft().text.trimEnd() ?? "";
              c?.setText(text ? `${text} ${url} ` : `${url} `);
              persistToProject([
                { kind: "link", value: url, label: url.replace(/^https?:\/\//, ""), copy: null },
              ]);
            }),
        },
        ...(project
          ? [
              {
                label: t("asistan.contextToProject"),
                desc: t("asistan.contextToProjectDesc", { name: project.name }),
                check: contextToProject,
                top: true,
                onSelect: () => setContextToProject(!contextToProject),
              },
            ]
          : []),
      ],
    });
  };
  const onRewind = (userOrdinal: number) => {
    void rewind(id, userOrdinal)
      .then(putDraft)
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)));
  };
  const onFork = (at: ForkPoint) => {
    void fork(id, at).then((newId) => {
      toast.success(t("asistan.forkedToast"));
      openSession(newId, "asistan");
    });
  };
  const closeViewer = () => {
    setOpenOutput(null);
    setViewerFull(false);
  };

  const menu = (e: React.MouseEvent) =>
    openAt(e.currentTarget as HTMLElement, {
      items: [
        {
          label: t("sidebar.rename"),
          icon: "pen",
          onSelect: () => {
            void askText({ title: t("sidebar.rename"), initial: summary?.name ?? "" }).then((n) => {
              if (n) void rename(id, n);
            });
          },
        },
        {
          label: t("session.sideChatOpen"),
          icon: "chat",
          onSelect: () => startSide(),
        },
        {
          label: t("sidebar.export"),
          icon: "export",
          onSelect: () => void invoke("sessions:export", { id }),
        },
        {
          label: t("asistan.deleteTask"),
          icon: "trash",
          danger: true,
          top: true,
          onSelect: () => {
            void askConfirm({
              title: t("asistan.deleteTask"),
              body: t("asistan.confirmDeleteTask"),
              danger: true,
            }).then((ok) => {
              // Store aynı bölümdeki komşu göreve geçer; komşu yoksa projenin ekranına dönülür.
              if (ok)
                void remove(id).then(() => {
                  if (useApp.getState().activeSessionId) return;
                  if (project) openProject(project.id);
                  else setMode("asistan");
                });
            });
          },
        },
      ],
    });

  return (
    <div className="flex min-h-0 flex-1">
      <div
        className={`relative flex min-w-0 flex-1 flex-col ${viewing && viewerFull ? "hidden" : ""}`}
      >
        <header
          className="flex h-12 shrink-0 items-start [-webkit-app-region:drag]"
          style={{
            paddingLeft: sidebarOpen ? 16 : titleLeftInset(),
            paddingRight: padRight(16),
          }}
        >
          {/* Başlık, pencere kontrolleriyle aynı 34px'lik şeritte ortalanır; kalan yükseklik
              sohbete nefes payı bırakır. */}
          <div
            className="flex min-w-0 flex-1 items-center gap-2"
            style={{ height: TITLE_BAR_HEIGHT }}
          >
            <button
              type="button"
              onClick={() => (project ? openProject(project.id) : goHome())}
              className="text-[14px] text-tx3 [-webkit-app-region:no-drag] hover:text-tx"
            >
              {project?.name ?? t("sidebar.navAsistan")}
            </button>
            <span className="text-[14px] text-tx3">/</span>
            <span className="min-w-0 truncate text-[14px] font-medium">
              {summary?.name ?? t("asistan.taskName")}
            </span>
            <button
              type="button"
              onClick={menu}
              className="px-1 text-[13px] tracking-[1px] text-tx3 [-webkit-app-region:no-drag] hover:text-tx"
            >
              ···
            </button>
            <span className="flex-1" />
            <button
              type="button"
              onClick={toggleTaskBoxes}
              title={taskBoxesOpen ? t("asistan.hideBoxes") : t("asistan.showBoxes")}
              className={`flex h-7 w-7 items-center justify-center rounded-[7px] [-webkit-app-region:no-drag] ${taskBoxesOpen ? "border border-accLine bg-accSoft text-tx" : "border border-transparent text-tx3 hover:bg-hov"}`}
            >
              <Icon name="panel" size={15} />
            </button>
          </div>
        </header>
        {/* Görev kutuları yüzen katman: sohbet alanı pencerenin sağına kadar uzanır (dikey kaydırma
            çubuğu pencere kenarında kalır), içerik ve composer yine soldaki kolonda durur. */}
        <div className="@container/chat relative flex min-h-0 flex-1">
          <div className={`flex min-h-0 min-w-0 flex-1 flex-col ${RAIL_PAD_CLASS}`}>
            {rt ? (
              <Transcript
                rt={rt}
                reserveRight={floatCol ? FLOAT_PANEL_WIDTH : 0}
                findKey={id}
                onDecide={(requestId, d) => void respond(id, requestId, d)}
                onPlanDecide={(requestId, d) => void respondPlan(id, requestId, d)}
                onQuestionAnswer={(requestId, answers) =>
                  void respondQuestion(id, requestId, answers)
                }
                onExtensionUi={(requestId, value) => void respondExtensionUi(id, requestId, value)}
                onFork={onFork}
                onRewind={onRewind}
                onQuote={(text) => palette.composerRef.current?.addQuote(text)}
                onSideChat={startSide}
                cwd={summary?.cwd ?? ""}
                onOpenFile={setOpenOutput}
                openRoots={[outputsDir]}
                knownPaths={outputPathList}
                onUndo={(userOrdinal) => invoke("sessions:undoFiles", { id, userOrdinal })}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center text-[13px] text-tx3">
                {t("common.loading")}
              </div>
            )}
            {/* Composer Transcript ile aynı yatay çerçeveyi paylaşır (CHAT_COLUMN); böylece her
                pencere genişliğinde kenarlar sohbetle birebir hizalı kalır. */}
            <div className="flex shrink-0 flex-col items-center pb-4" style={composerPad(floatCol)}>
              <div className={CHAT_COLUMN}>
                <div className="relative">
                  <Composer
                    ref={palette.composerRef}
                    hideAttach
                    draft={draft}
                    hydrateKey={draftSeq}
                    onDraft={(d) => saveDraft(id, d)}
                    placeholder={t("asistan.messagePlaceholder")}
                    busy={!!busy}
                    onStop={() => void abort(id)}
                    onSend={(text, imgs) => prompt(id, expandPrompt(text, lang), imgs)}
                    slash={palette.slash}
                    left={
                      <>
                        {palette.button}
                        <SessionPermissionChip id={id} />
                      </>
                    }
                    right={
                      <SessionChips id={id} usage={rt?.context ?? null} stats={rt?.usage ?? null} />
                    }
                  />
                </div>
              </div>
            </div>
          </div>
          {sideOpen ? (
            <SideChatPanel
              parentId={id}
              cwd={summary?.cwd ?? ""}
              onOpenFile={setOpenOutput}
              openRoots={[outputsDir]}
              knownPaths={outputPathList}
              composerRef={sideComposer}
              onPromote={(sideId) => openSession(sideId, "asistan")}
            />
          ) : null}
          {showBoxes && !sideOpen ? (
            <TaskBoxes
              sessionId={id}
              steps={steps}
              outputs={outputs}
              outputsDir={outputsDir}
              project={project}
              readFiles={readFiles}
              active={running}
              openLeft={openLeft}
              onOpenOutput={setOpenOutput}
              onAddContext={addContext}
            />
          ) : null}
        </div>
      </div>
      {viewing ? (
        <OutputViewer
          output={viewing}
          fullscreen={viewerFull}
          onToggleFullscreen={() => setViewerFull((v) => !v)}
          onClose={closeViewer}
        />
      ) : null}
    </div>
  );
}
