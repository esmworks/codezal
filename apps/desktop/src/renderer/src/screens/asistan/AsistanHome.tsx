import type { ImageAttachment } from "@codezal/contracts";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BrandLogo } from "../../components/BrandLogo";
import { ErrorBar, splitError } from "../../components/ErrorBar";
import { HomeBackdrop } from "../../components/HomeBackdrop";
import { Icon } from "../../components/Icon";
import { askText } from "../../components/Prompt";
import { useLocale } from "../../lib/i18n";
import { expandPrompt } from "../../lib/promptText";
import { Composer } from "../../session/Composer";
import { useComposerPalette } from "../../session/ComposerPalette";
import { HomeChips, PermissionChip } from "../../session/chips";
import type { ComposerDraft } from "../../session/composerParts";
import { useApp } from "../../stores/app";
import { useAssistant } from "../../stores/assistant";
import { draftFor, useDrafts } from "../../stores/drafts";
import { useModels } from "../../stores/models";
import { useSessions } from "../../stores/sessions";
import { useSettings } from "../../stores/settings";
import { HomeBox, type Suggestion, Suggestions } from "../home";

/** Giriş ekranı taslağı bu anahtarla saklanır: oturuma gidip dönünce metin ve görseller yerinde kalır. */
const HOME_DRAFT = "home:asistan";

/** Asistan ana ekranı: composer ve projeler; zamanlanmış görevlerin kendi sayfası var. */
export function AsistanHome() {
  const { t } = useTranslation();
  const lang = useLocale();
  const { openSession, openProject } = useApp();
  const { projects, load, cwdFor, createProject } = useAssistant();
  const { model, permission, thinking, setPermission } = useModels();
  const create = useSessions((s) => s.create);
  const runCommand = useSessions((s) => s.runCommand);
  const sessions = useSessions((s) => s.list);
  const showCards = useSettings((s) => s.settings?.cards ?? true);
  const [draft] = useState<ComposerDraft | null>(() => draftFor(HOME_DRAFT));
  const saveHomeDraft = useDrafts((s) => s.set);
  const [error, setError] = useState<string | null>(null);
  // Oturum açılana kadar çift gönderimi engeller.
  const [sending, setSending] = useState(false);
  const palette = useComposerPalette({ cwd: null, mode: "asistan", size: 26 });

  useEffect(() => {
    void load();
  }, [load]);

  const send = async (
    text: string,
    images: ImageAttachment[] = [],
    projectId: string | null = null,
  ) => {
    if (sending) return;
    setSending(true);
    try {
      // Yerel komut (`/yardım`, `/model`) oturum açmadan çalışır ve gönderimi bitirir; sağlayıcı
      // denetiminden önce sorulur, yoksa bağlı sağlayıcı yokken komut hiç çalışmazdı.
      if (await runCommand(text)) return;
      // Gönderim başarısızsa Composer taslağı geri yükler; hata toast'ı da oradan gelir.
      if (!model) throw new Error(t("asistan.noProviderHome"));
      const s = await create(
        {
          cwd: cwdFor(projectId),
          mode: "asistan",
          model,
          thinking,
          permission,
          location: "local",
          projectId,
        },
        text,
        images,
      );
      if (s) openSession(s.id, "asistan");
    } finally {
      setSending(false);
    }
  };

  /** Composer dışı gönderimler (öneri kartı): hata ekranda gösterilir. */
  const submit = (text: string) =>
    void send(text).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));

  const newProject = async () => {
    const name = await askText({
      title: t("sidebar.newProject"),
      placeholder: t("sidebar.newProjectPlaceholder"),
      okLabel: t("sidebar.create"),
    });
    if (name) openProject(await createProject(name));
  };

  const suggestions: Suggestion[] = [
    {
      icon: "globe",
      label: t("asistan.suggestions.researchTitle"),
      hint: t("asistan.suggestions.researchHint"),
      text: t("asistan.suggestions.researchText"),
    },
    {
      icon: "list",
      label: t("asistan.suggestions.weekTitle"),
      hint: t("asistan.suggestions.weekHint"),
      text: t("asistan.suggestions.weekText"),
    },
    {
      icon: "folder",
      label: t("asistan.suggestions.tidyTitle"),
      hint: t("asistan.suggestions.tidyHint"),
      text: t("asistan.suggestions.tidyText"),
    },
  ];

  return (
    <div className="relative isolate flex min-h-0 flex-1 flex-col items-center justify-center-safe gap-6 overflow-y-auto px-10 py-10">
      <HomeBackdrop />
      {/* Logo yalnızca yeterince yüksek pencerede; yazma kutusunu aşağı itmez. */}
      <BrandLogo size={88} className="hidden shrink-0 [@media(min-height:640px)]:block" />
      <h1 className="text-[28px] font-semibold tracking-[-0.02em]">{t("asistan.title")}</h1>
      <div className="relative w-full max-w-[680px]">
        <HomeBox>
          <Composer
            ref={palette.composerRef}
            hideAttach
            draft={draft}
            onDraft={(d) => saveHomeDraft(HOME_DRAFT, d)}
            placeholder={t("asistan.composerPlaceholder")}
            variant="home"
            busy={sending}
            onSend={(text, imgs) => send(expandPrompt(text, lang), imgs)}
            slash={palette.slash}
            left={
              <>
                {palette.button}
                <PermissionChip value={permission} onChange={setPermission} />
              </>
            }
            right={<HomeChips />}
          />
        </HomeBox>
        {error ? (
          <ErrorBar {...splitError(error)} onDismiss={() => setError(null)} className="mt-2" />
        ) : null}
        {showCards ? <Suggestions items={suggestions} onPick={(text) => submit(text)} /> : null}
      </div>

      <div className="flex w-full max-w-[680px] flex-col gap-[10px]">
        <div className="text-[12px] font-medium text-tx">{t("asistan.projects")}</div>
        <div className="grid grid-cols-2 gap-[10px]">
          {projects.map((p) => {
            const n = sessions.filter((s) => s.projectId === p.id && s.mode === "asistan").length;
            return (
              <button
                type="button"
                key={p.id}
                onClick={() => openProject(p.id)}
                className="flex items-center gap-[11px] rounded-[12px] border border-line bg-card2 px-[14px] py-[13px] text-left hover:border-line2"
              >
                <Icon name="folder" size={15} className="shrink-0 text-tx2" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium">{p.name}</div>
                  <div className="text-[12px] text-tx2">
                    {t("asistan.projectStats", { count: n, items: p.context.length })}
                  </div>
                </div>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => void newProject()}
            className="flex items-center justify-center gap-2 rounded-[12px] border border-dashed border-line2 px-[13px] py-[13px] text-[13px] text-tx2 hover:border-tx3 hover:text-tx"
          >
            <Icon name="plus" size={13} stroke={2} />
            {t("sidebar.newProject")}
          </button>
        </div>
      </div>
    </div>
  );
}
