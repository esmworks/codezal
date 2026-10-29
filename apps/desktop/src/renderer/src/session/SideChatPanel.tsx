import type { ImageAttachment } from "@codezal/contracts";
import { type RefObject, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { FLOAT_PANEL_WIDTH } from "../lib/floatPanel";
import { useLocale } from "../lib/i18n";
import { expandPrompt } from "../lib/promptText";
import { draftFor, useDrafts } from "../stores/drafts";
import { useSessions } from "../stores/sessions";
import { humanizeError, toast } from "../stores/toast";
import { Composer, type ComposerHandle } from "./Composer";
import { Transcript } from "./Transcript";

/** Panelin pencere kenarından ve sohbet alanının altından payı (EnvBox'la aynı sağ pay). */
const EDGE_RIGHT = 18;

/**
 * Yan sohbet paneli: ana oturumun bağlamını taşıyan salt okunur dal, sohbetin sağ altında yüzer.
 * Ortak geçmiş panelde çizilmez (ana sohbet zaten solda); yalnız yan sohbette konuşulanlar görünür.
 * İzin, plan ve soru kartları Transcript'ten gelir: salt okunur modda da web araçları ve soru
 * aracı kullanıcıya sorar.
 */
export function SideChatPanel({
  parentId,
  cwd,
  onOpenFile,
  openRoots,
  knownPaths,
  onPromote,
  composerRef,
}: {
  parentId: string;
  cwd: string;
  onOpenFile: (path: string) => void;
  /** Asistan: çıktı klasörü ve bilinen çıktılar; yanıttaki dosya adları bağlantıya döner. */
  openRoots?: readonly string[] | undefined;
  knownPaths?: readonly string[] | undefined;
  /** Ayrı oturuma çevrildi: çağıran yeni oturumu açar. */
  onPromote: (id: string) => void;
  composerRef: RefObject<ComposerHandle | null>;
}) {
  const { t } = useTranslation();
  const lang = useLocale();
  const entry = useSessions((s) => s.side[parentId]);
  const rt = useSessions((s) => (entry ? s.runtime[entry.id] : undefined));
  const {
    open,
    prompt,
    followUp,
    abort,
    respond,
    respondPlan,
    respondQuestion,
    respondExtensionUi,
    dismissError,
    closeSide,
    promoteSide,
  } = useSessions();
  const saveDraft = useDrafts((s) => s.set);
  const sideId = entry?.id;

  // Runtime bellekten düşmüşse (uzun süre başka oturumdayken) snapshot'tan yeniden kurulur.
  useEffect(() => {
    if (sideId && !rt) void open(sideId).catch((e: unknown) => toast.error(humanizeError(e)));
  }, [sideId, rt, open]);

  const view = useMemo(
    () => (rt && entry ? { ...rt, transcript: rt.transcript.slice(entry.base) } : undefined),
    [rt, entry],
  );
  // Taslak oturumlar arası gidip gelince ve panel kapanıp açılınca korunur; açarken seçilen
  // metin store tarafından taslağa alıntı olarak yazılır.
  const draft = useMemo(() => (sideId ? draftFor(sideId) : null), [sideId]);

  if (!entry?.open || !sideId) return null;
  const busy = rt?.status === "working";
  const send = (raw: string, imgs: ImageAttachment[], deliver: "steer" | "followUp" = "steer") => {
    const text = expandPrompt(raw, lang);
    return deliver === "followUp" ? followUp(sideId, text, imgs) : prompt(sideId, text, imgs);
  };
  const iconBtn =
    "flex h-[26px] w-[26px] items-center justify-center rounded-[6px] text-tx3 hover:bg-hov hover:text-tx";

  return (
    <section
      aria-label={t("session.sideChat")}
      // Paneldeki Esc ana turu durdurmasın: kutu kendi turunu durdurur (ve işaretler), kalan Esc
      // burada işaretlenir; oturum ekranının pencere dinleyicisi işaretli Esc'i yok sayar.
      onKeyDown={(e) => {
        if (e.key === "Escape") e.preventDefault();
      }}
      className="absolute bottom-[14px] z-30 flex flex-col overflow-hidden rounded-[14px] border border-line2 bg-card shadow-panel"
      style={{
        right: EDGE_RIGHT,
        width: FLOAT_PANEL_WIDTH - EDGE_RIGHT,
        height: "min(640px, calc(100% - 26px))",
      }}
    >
      <header className="flex shrink-0 items-center gap-1 border-b border-line py-[6px] pr-[6px] pl-[14px]">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-[13px] font-semibold text-tx">{t("session.sideChat")}</span>
          <span className="truncate text-[11.5px] text-tx3">{t("session.sideChatReadOnly")}</span>
        </div>
        <button
          type="button"
          title={t("session.sideChatPromote")}
          aria-label={t("session.sideChatPromote")}
          onClick={() => {
            void promoteSide(parentId)
              .then((summary) => onPromote(summary.id))
              .catch((e: unknown) => toast.error(humanizeError(e)));
          }}
          className={iconBtn}
        >
          <Icon name="expand" size={14} stroke={1.7} />
        </button>
        <button
          type="button"
          title={t("session.sideChatClose")}
          aria-label={t("session.sideChatClose")}
          onClick={() => {
            closeSide(parentId);
          }}
          className={iconBtn}
        >
          <Icon name="x" size={14} stroke={1.8} />
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        {view && view.transcript.length > 0 ? (
          <Transcript
            compact
            rt={view}
            cwd={cwd}
            onOpenFile={onOpenFile}
            openRoots={openRoots}
            knownPaths={knownPaths}
            onDecide={(requestId, d) => void respond(sideId, requestId, d)}
            onPlanDecide={(requestId, d) => void respondPlan(sideId, requestId, d)}
            onQuestionAnswer={(requestId, answers) =>
              void respondQuestion(sideId, requestId, answers)
            }
            onExtensionUi={(requestId, value) => void respondExtensionUi(sideId, requestId, value)}
            onDismissError={() => dismissError(sideId)}
            onQuote={(text) => composerRef.current?.addQuote(text)}
          />
        ) : (
          <div className="flex flex-1 items-center px-4 text-[12.5px] leading-[1.5] text-tx3">
            {view ? t("session.sideChatEmpty") : t("common.loading")}
          </div>
        )}
      </div>
      <div className="shrink-0 px-[10px] pb-[10px]">
        <Composer
          ref={composerRef}
          hideAttach
          commandAnchor={false}
          autoFocus
          draft={draft}
          onDraft={(d) => saveDraft(sideId, d)}
          placeholder={t("session.sideChatPlaceholder")}
          busy={busy}
          allowWhileBusy
          onStop={() => void abort(sideId)}
          onSend={send}
          onQueue={(raw, imgs) => send(raw, imgs, "followUp")}
          historyKey={`side:${cwd}`}
        />
      </div>
    </section>
  );
}
