import type { ImageAttachment } from "@codezal/contracts";
import { localeOf } from "@codezal/i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../api";
import { askConfirm } from "../components/Confirm";
import { Icon } from "../components/Icon";
import { OpenWithButton } from "../components/OpenWithButton";
import { askText } from "../components/Prompt";
import { escapeAbortsTurn } from "../lib/escapeLayers";
import { CHAT_COLUMN, composerPad, FLOAT_PANEL_WIDTH, RAIL_PAD_CLASS } from "../lib/floatPanel";
import { i18n } from "../lib/i18n";
import { padRight } from "../lib/platform";
import { expandPrompt } from "../lib/promptText";
import { revealChanges } from "../lib/revealChanges";
import { revealTerminal } from "../lib/revealTerminal";
import { useWindowWidth } from "../lib/useWindowWidth";
import { Panel } from "../panel/Panel";
import { BackgroundChip } from "../session/BackgroundChip";
import { Composer, type ComposerHandle } from "../session/Composer";
import { useComposerPalette } from "../session/ComposerPalette";
import { SessionChips, SessionPermissionChip } from "../session/chips";
import { type ComposerDraft, emptyDraft } from "../session/composerParts";
import { EnvBox } from "../session/EnvBox";
import { GoalCard } from "../session/GoalCard";
import { QueueBar } from "../session/QueueBar";
import { SideChatPanel } from "../session/SideChatPanel";
import { Transcript } from "../session/Transcript";
import { TITLE_BAR_HEIGHT, titleLeftInset } from "../shell/titleBarMetrics";
import { useShortcutHint } from "../shortcuts";
import { selectRuns, useAgentRuns } from "../stores/agentRuns";
import { useApp } from "../stores/app";
import { useAudit } from "../stores/audit";
import { draftFor, useDrafts } from "../stores/drafts";
import { useGit } from "../stores/git";
import { useMenu } from "../stores/menu";
import { BASE_PANEL_TABS, usePanel } from "../stores/panel";
import { type ForkPoint, useSessions } from "../stores/sessions";
import { humanizeError, toast } from "../stores/toast";

export function SessionScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const terminalKey = useShortcutHint("terminal");
  const panelKey = useShortcutHint("toggle-panel");
  const { panelOpen, togglePanel, setModal, leaveSession, sidebarOpen, sidebarWidth, openSession } =
    useApp();

  const summary = useSessions((s) => s.list.find((x) => x.id === id));
  const rt = useSessions((s) => s.runtime[id]);
  const {
    open,
    prompt,
    followUp,
    clearQueue,
    abort,
    respond,
    respondPlan,
    respondQuestion,
    respondExtensionUi,
    dismissError,
    rename,
    regenerateTitle,
    remove,
    setArchived,
    fork,
    rewind,
    openSide,
  } = useSessions();
  const sideOpen = useSessions((s) => s.side[id]?.open === true);
  const sideComposer = useRef<ComposerHandle>(null);
  // Yan sohbet: açıksa seçilen metin panelin kutusuna alıntı olarak eklenir, değilse panel
  // alıntıyla açılır. Ana tur sürerken de açılır; ilk yanıt diske düşmeden açılamaz (hata toast).
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
  // Oturuma dönüldüğünde gönderilmemiş taslak (metin + yapıştırma parçaları + görseller) geri gelir.
  const [draft, setDraft] = useState<ComposerDraft | null>(() => draftFor(id));
  const saveDraft = useDrafts((s) => s.set);
  // Aynı metne ikinci kez dönülse de kutu tazelensin diye Composer'a hidrasyon sayacı verilir.
  const [draftSeq, setDraftSeq] = useState(0);
  const putDraft = useCallback(
    ({ text, quotes }: { text: string; quotes: string[] }) => {
      const next: ComposerDraft = { ...emptyDraft(), text, quotes };
      setDraft(next);
      saveDraft(id, next);
      setDraftSeq((n) => n + 1);
    },
    [id, saveDraft],
  );
  const openAt = useMenu((s) => s.openAt);
  const refreshGit = useGit((s) => s.refresh);
  const { full, openTab, setOpenFile } = usePanel();
  const winW = useWindowWidth();
  const avail = winW - (sidebarOpen ? sidebarWidth : 0);
  const cwd = summary?.cwd ?? "";
  const palette = useComposerPalette({ cwd: cwd || null, mode: "kodlama" });
  // Sonuç sekmeleri yalnız içeriği olduğunda palete girer: denetim run'ı olan oturumda "Bulgular",
  // işi olan oturumda "İşler" (boşta duran sekme iş yapıyormuş gibi duruyor).
  const workers = useAgentRuns(selectRuns(id));
  const hasResults = (rt?.subagents.length ?? 0) > 0 || workers.length > 0;
  // "İşler" ajanı ya da arka plan komutu olan oturumda açılır. Biten komut tur başında listeden
  // düşse de ayrıntısı açık iş sekmeyi açık tutar (çıktısı runner'da durur).
  const hasOpenJob = usePanel((s) => s.job?.sessionId === id);
  const hasJobs = hasResults || (rt?.backgrounds.length ?? 0) > 0 || hasOpenJob;
  const panelTabs = useMemo(
    () => [
      ...BASE_PANEL_TABS,
      ...(summary?.auditRunId ? (["Bulgular"] as const) : []),
      ...(hasJobs ? (["İşler"] as const) : []),
    ],
    [summary?.auditRunId, hasJobs],
  );
  // Seçili iş oturuma aittir: başka oturuma geçince eskisinin ayrıntısı açık kalmaz.
  useEffect(() => {
    usePanel.getState().clearJobExcept(id);
  }, [id]);

  useEffect(() => {
    // Kayıp/geçersiz oturum kimliği: hata sessizce yutulmasın, listeye dön. Açılış yavaşken
    // kullanıcı başka sohbete geçtiyse bayat hata onu oradan atmamalı.
    void open(id).catch((e: unknown) => {
      toast.error(humanizeError(e));
      leaveSession(id);
    });
    // Ajan koşuları oturumdan ayrı saklanır: inceleme bekleyen worktree işleri açılışta gelir.
    void useAgentRuns
      .getState()
      .load(id)
      .catch(() => {});
  }, [id, open, leaveSession]);

  useEffect(() => {
    if (cwd) void refreshGit(cwd);
  }, [cwd, refreshGit]);

  useEffect(() => {
    // Denetim run'ı olan oturumda Bulgular sekmesi kendiliğinden açılır ve durum tazelenir.
    if (!summary?.auditRunId) return;
    openTab("Bulgular");
    void useAudit.getState().load(id);
  }, [id, summary?.auditRunId, openTab]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Menü, modal, arama, ışık kutusu ya da Ayarlar açıkken Esc önce onları kapatır; tur
      // yalnız hiçbir katman Esc'i almadıysa durur.
      if (escapeAbortsTurn(e, rt?.status === "working")) void abort(id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id, rt?.status, abort]);

  const askRename = () => {
    void askText({ title: t("session.rename"), initial: summary?.name ?? "" }).then((name) => {
      if (name) void rename(id, name);
    });
  };

  const menu = (e: React.MouseEvent) =>
    openAt(e.currentTarget as HTMLElement, {
      minWidth: 230,
      items: [
        {
          label: t("shortcuts.changes.label"),
          icon: "changes",
          onSelect: () => revealChanges(),
        },
        { label: t("shortcuts.commit.label"), icon: "commit", onSelect: () => setModal("commit") },
        {
          label: t("shortcuts.terminal.label"),
          icon: "terminal",
          key: terminalKey,
          onSelect: () => revealTerminal(cwd),
        },
        {
          label: t("session.traceLabel"),
          icon: "bug",
          onSelect: () => setModal("trace"),
        },
        {
          label: t("session.sideChatOpen"),
          icon: "chat",
          onSelect: () => startSide(),
        },
        {
          label: t("session.rename"),
          icon: "pen",
          top: true,
          onSelect: askRename,
        },
        {
          label: t("session.regenerateTitle"),
          icon: "sparkle",
          onSelect: () => {
            void regenerateTitle(id).catch((e: unknown) => toast.error(humanizeError(e)));
          },
        },
        {
          label: t("sidebar.export"),
          icon: "export",
          onSelect: () => void invoke("sessions:export", { id }),
        },
        {
          label: t("sidebar.archive"),
          icon: "folderClosed",
          // Açık sohbetten çıkışı (komşu sohbet ya da ana ekran) store yapar.
          onSelect: () => void setArchived(id, true),
        },
        {
          label: t("session.deleteSession"),
          icon: "trash",
          danger: true,
          onSelect: () => {
            void askConfirm({
              title: t("session.deleteSession"),
              body: t("session.confirmDelete"),
              danger: true,
            }).then((ok) => {
              if (ok) void remove(id);
            });
          },
        },
      ],
    });

  const status = rt?.status ?? "idle";
  const busy = status === "working";
  // "waiting" hem izin/plan onayını hem sağlayıcı yeniden denemesini taşır;
  // onay kartı yoksa metin ve placeholder yanıltmasın: ajan bekliyor ama yanıtlamamız gerekmiyor.
  const awaitingApproval =
    status === "waiting" && (!!rt?.permissions.some((r) => !r.run) || !!rt?.planReview);
  // İlerleme kutusu yalnızca tur sürerken görünür: onay beklerken de tur açıktır.
  const runActive = status === "working" || status === "waiting";

  const send = async (
    raw: string,
    imgs: ImageAttachment[],
    deliver: "steer" | "followUp" = "steer",
  ): Promise<void> => {
    // Yerel komutlar (`/goal`, `/model`, `/compact`, `/yardım`, …) depodaki tek kapıda yürür;
    // komut olduğu anlaşılırsa metin modele gitmez. Kısayol komutları burada genişler.
    const text = expandPrompt(raw, localeOf(i18n.language));
    await (deliver === "followUp" ? followUp(id, text, imgs) : prompt(id, text, imgs));
  };
  // Geri çağrılar `useCallback` ile sabitlenir: Transcript satırları `memo`lu olduğu için kimliği
  // her çizimde değişen bir işlev, bütün satırların yeniden çizilmesine yol açardı.
  const onRewind = useCallback(
    (userOrdinal: number) => {
      void rewind(id, userOrdinal)
        .then(putDraft)
        .catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)));
    },
    [id, rewind, putDraft],
  );
  const onFork = useCallback(
    (at: ForkPoint) => {
      void fork(id, at).then((newId) => {
        toast.success(t("session.forkedToast"));
        openSession(newId, "kodlama");
      });
    },
    [id, fork, openSession, t],
  );
  const showEnv = !panelOpen && avail >= 980;
  // Yan sohbet paneli ortam kutusunun sütununda durur: açıkken kutu gizlenir, sütun payı korunur.
  const floatCol = showEnv || sideOpen;
  const hideChat = panelOpen && full;
  // Sohbetteki yol çipleri, tur altı listesi ve sağdaki "Bu oturumda" aynı yere açar.
  const openFile = useCallback(
    (path: string) => {
      setOpenFile(cwd, path);
      openTab("Dosyalar");
      if (!panelOpen) togglePanel();
    },
    [cwd, setOpenFile, openTab, panelOpen, togglePanel],
  );
  const onUndoFiles = useCallback(
    (userOrdinal: number) => invoke("sessions:undoFiles", { id, userOrdinal }),
    [id],
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className={`relative min-w-0 flex-1 flex-col ${hideChat ? "hidden" : "flex"}`}>
        <header
          className="flex h-12 shrink-0 items-start [-webkit-app-region:drag]"
          style={{
            paddingLeft: sidebarOpen ? 16 : titleLeftInset(),
            paddingRight: padRight(16),
          }}
        >
          {/* Başlık, pencere kontrolleriyle aynı 34px'lik şeritte ortalanır; kalan yükseklik
              transkripte nefes payı bırakır (düğmelerle aynı hizada durur). */}
          <div
            className="flex min-w-0 flex-1 items-center gap-[10px]"
            style={{ height: TITLE_BAR_HEIGHT }}
          >
            {/* Çift tıklama yeniden adlandırır; sürükleme bölgesinden çıkarılır ki pencereyi
                taşımak yerine tıklama başlığa ulaşsın. */}
            <div
              title={t("session.renameHint")}
              onDoubleClick={askRename}
              className="min-w-0 max-w-[520px] cursor-default truncate text-[14px] font-semibold [-webkit-app-region:no-drag]"
            >
              {summary?.name ?? t("session.name")}
            </div>
            <span className="flex-1" />
            <Icon name="mac" size={13} className="text-tx3" />
            <OpenWithButton cwd={cwd} />
            <button
              type="button"
              onClick={menu}
              className="flex h-[26px] w-[26px] items-center justify-center rounded-[6px] text-[13px] tracking-[1px] text-tx3 [-webkit-app-region:no-drag] hover:bg-hov hover:text-tx"
            >
              ···
            </button>
            <button
              type="button"
              onClick={togglePanel}
              title={t("session.panelTitle", { key: panelKey })}
              className={`flex h-[26px] w-[26px] items-center justify-center rounded-[6px] [-webkit-app-region:no-drag] hover:bg-hov ${panelOpen ? "bg-sel text-tx" : "text-tx3"}`}
            >
              <Icon name="panel" size={15} />
            </button>
          </div>
        </header>

        {/* Ortam kutusu yüzen katman: sohbet alanı pencerenin sağına kadar uzanır (dikey kaydırma
            çubuğu pencere kenarında kalır), içerik ve composer yine soldaki kolonda durur. */}
        <div className="@container/chat relative flex min-h-0 flex-1">
          <div className={`flex min-h-0 min-w-0 flex-1 flex-col ${RAIL_PAD_CLASS}`}>
            {rt ? (
              <Transcript
                rt={rt}
                sessionId={id}
                findKey={id}
                reserveRight={floatCol ? FLOAT_PANEL_WIDTH : 0}
                onDecide={(requestId, d) => void respond(id, requestId, d)}
                onPlanDecide={(requestId, d) => void respondPlan(id, requestId, d)}
                onQuestionAnswer={(requestId, answers) =>
                  void respondQuestion(id, requestId, answers)
                }
                onExtensionUi={(requestId, value) => void respondExtensionUi(id, requestId, value)}
                onDismissError={() => dismissError(id)}
                onFork={onFork}
                onRewind={onRewind}
                onQuote={(text) => palette.composerRef.current?.addQuote(text)}
                onSideChat={startSide}
                cwd={cwd}
                onOpenFile={openFile}
                onUndo={onUndoFiles}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center text-[13px] text-tx3">
                {t("common.loading")}
              </div>
            )}

            {/* Composer Transcript ile aynı yatay çerçeveyi paylaşır (CHAT_COLUMN); böylece her
                pencere genişliğinde kenarlar sohbetle birebir hizalı kalır. */}
            {/* Sol boşluk mesaj çubuğunun şeridi: composer sohbet kolonuyla hizalı kalsın. */}
            <div className="pb-[14px]" style={composerPad(floatCol)}>
              <div className={CHAT_COLUMN}>
                {rt?.goal ? <GoalCard id={id} goal={rt.goal} /> : null}
                {rt && (rt.queue.steering.length > 0 || rt.queue.followUp.length > 0) ? (
                  <QueueBar
                    steering={rt.queue.steering}
                    followUp={rt.queue.followUp}
                    onClear={() => void clearQueue(id)}
                  />
                ) : null}
                <div className="relative">
                  <Composer
                    ref={palette.composerRef}
                    hideAttach
                    draft={draft}
                    hydrateKey={draftSeq}
                    onDraft={(d) => saveDraft(id, d)}
                    placeholder={
                      awaitingApproval
                        ? t("session.placeholderWaiting")
                        : status === "waiting" || busy
                          ? t("session.placeholderBusy")
                          : t("session.placeholderIdle")
                    }
                    busy={busy}
                    allowWhileBusy
                    onStop={() => void abort(id)}
                    slash={palette.slash}
                    onSend={send}
                    onQueue={(raw, imgs) => send(raw, imgs, "followUp")}
                    historyKey={cwd || id}
                    left={
                      <>
                        {palette.button}
                        <SessionPermissionChip id={id} />
                        <BackgroundChip sessionId={id} />
                      </>
                    }
                    right={
                      <>
                        {status === "waiting" ? (
                          <span className="text-[12px] text-amber">
                            {awaitingApproval
                              ? t("session.statusWaiting")
                              : t("session.statusRetrying")}
                          </span>
                        ) : null}
                        <SessionChips
                          id={id}
                          usage={rt?.context ?? null}
                          stats={rt?.usage ?? null}
                        />
                      </>
                    }
                  />
                </div>
              </div>
            </div>
          </div>
          {sideOpen ? (
            <SideChatPanel
              parentId={id}
              cwd={cwd}
              onOpenFile={openFile}
              composerRef={sideComposer}
              onPromote={(sideId) => openSession(sideId, summary?.mode ?? "kodlama")}
            />
          ) : null}
          {showEnv && !sideOpen && cwd ? (
            <EnvBox
              sessionId={id}
              cwd={cwd}
              transcript={rt?.transcript ?? []}
              backgrounds={rt?.backgrounds ?? []}
              subagents={rt?.subagents ?? []}
              active={runActive}
            />
          ) : null}
        </div>
      </div>
      {cwd ? (
        <Panel open={panelOpen} cwd={cwd} sessionId={id} avail={avail} available={panelTabs} />
      ) : null}
    </div>
  );
}
