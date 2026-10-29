import type { ImageAttachment } from "@codezal/contracts";
import type { TFunction } from "i18next";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../api";
import { BrandLogo } from "../components/BrandLogo";
import { ErrorBar, splitError } from "../components/ErrorBar";
import { HomeBackdrop } from "../components/HomeBackdrop";
import { formatTokens, greeting } from "../lib/format";
import { useLocale } from "../lib/i18n";
import { isMac } from "../lib/platform";
import { expandPrompt } from "../lib/promptText";
import { Composer } from "../session/Composer";
import { useComposerPalette } from "../session/ComposerPalette";
import { Chip, HomeChips, PermissionChip } from "../session/chips";
import type { ComposerDraft } from "../session/composerParts";
import { useApp } from "../stores/app";
import { draftFor, useDrafts } from "../stores/drafts";
import { useGit } from "../stores/git";
import { useMenu } from "../stores/menu";
import { useModels } from "../stores/models";
import { useCurrentProject, useProjects } from "../stores/projects";
import { useSessions } from "../stores/sessions";
import { useSettings } from "../stores/settings";
import { HomeBox, HomeTray, type Suggestion, Suggestions } from "./home";

/** Giriş ekranı taslağı bu anahtarla saklanır: oturuma gidip dönünce metin ve görseller yerinde kalır. */
const HOME_DRAFT = "home:kodlama";

/** Öneri hapları: git deposu varsa git odaklı, yoksa projeyi tanıma odaklı. */
function suggestionsFor(isGit: boolean, t: TFunction): Suggestion[] {
  const git: Suggestion[] = [
    {
      icon: "list",
      label: t("home.suggestions.standupTitle"),
      hint: t("home.suggestions.standupDesc"),
      text: t("home.suggestions.standupText"),
    },
    {
      icon: "search",
      label: t("home.suggestions.reviewTitle"),
      hint: t("home.suggestions.reviewDesc"),
      text: t("home.suggestions.reviewText"),
    },
  ];
  const plain: Suggestion[] = [
    {
      icon: "eye",
      label: t("home.suggestions.introTitle"),
      hint: t("home.suggestions.introDesc"),
      text: t("home.suggestions.introText"),
    },
    {
      icon: "check",
      label: t("home.suggestions.testsTitle"),
      hint: t("home.suggestions.testsDesc"),
      text: t("home.suggestions.testsText"),
    },
  ];
  return [
    ...(isGit ? git : plain),
    {
      icon: "sparkle",
      label: t("home.suggestions.customizeTitle"),
      hint: t("home.suggestions.customizeDesc"),
      text: "",
    },
  ];
}

export function KodlamaHome() {
  const { t } = useTranslation();
  const lang = useLocale();
  const { userName, openSession } = useApp();
  const { recent, pick, select } = useProjects();
  const current = useCurrentProject();
  const branch = current?.branch ?? "main";
  const { model, permission, thinking, setPermission } = useModels();
  const create = useSessions((s) => s.create);
  const runCommand = useSessions((s) => s.runCommand);
  const openAt = useMenu((s) => s.openAt);
  const list = useSessions((s) => s.list);
  const showGreeting = useSettings((s) => s.settings?.greet ?? true);
  const showCards = useSettings((s) => s.settings?.cards ?? true);
  const [tokens, setTokens] = useState(0);
  useEffect(() => {
    invoke("usage:list", undefined)
      .then((rows) => setTokens(rows.reduce((n, r) => n + r.input + r.output, 0)))
      .catch(() => setTokens(0));
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [draft] = useState<ComposerDraft | null>(() => draftFor(HOME_DRAFT));
  const saveHomeDraft = useDrafts((s) => s.set);
  // Oturum açılana kadar çift gönderimi ve kutunun boşalmasını engeller; welcome'dan
  // sohbete geçiş metin kaybolmadan tek karede olur.
  const [sending, setSending] = useState(false);
  const palette = useComposerPalette({ cwd: current?.path ?? null, mode: "kodlama", size: 26 });
  // "Görev başına worktree" açıksa yer varsayılan olarak yeni worktree'dir; menüden seçim
  // ayarı bu ekran için ezer. Git olmayan projede worktree açılamaz, yer "Bu Mac" görünür.
  const perTask = useSettings((s) => s.settings?.worktreePerTask ?? false);
  const [worktreeChoice, setWorktree] = useState<boolean | null>(null);
  const wantsWorktree = worktreeChoice ?? perTask;
  const worktree = wantsWorktree && current?.isGit === true;
  // Windows/Linux'ta "Bu Mac" yanlış olur; yer etiketi platforma göre seçilir.
  const yerLabel = isMac ? t("home.thisMac") : t("home.thisComputer");
  const gitStatus = useGit((s) => (current ? s.status[current.path] : undefined));
  const branchesOf = useGit((s) => (current ? s.branches[current.path] : undefined));
  const { refresh, loadBranches, checkout } = useGit();

  useEffect(() => {
    if (current?.isGit) {
      void refresh(current.path);
      void loadBranches(current.path);
    }
  }, [current, refresh, loadBranches]);

  const send = async (raw: string, images: ImageAttachment[] = []) => {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      // Yerel komut (`/yardım`, `/model`, `/geçmiş`) oturum açmadan çalışır ve gönderimi bitirir.
      if (await runCommand(raw)) return;
      const text = expandPrompt(raw, lang);
      let project = current;
      if (!project) project = await pick();
      // Gönderim başarısızsa Composer taslağı geri yükler; hata toast'ı da oradan gelir.
      if (!project) throw new Error(t("home.noProjectError"));
      if (!model) throw new Error(t("home.noProviderError"));
      let cwd = project.path;
      let location: "local" | "worktree" = "local";
      if (wantsWorktree && project.isGit) {
        const wt = await invoke("worktree:create", { cwd: project.path });
        cwd = wt.path;
        location = "worktree";
      }
      const s = await create(
        {
          cwd,
          mode: "kodlama",
          model,
          thinking,
          permission,
          location,
        },
        text,
        images,
      );
      // Yerel komut (`/yardım`, `/model`) oturum açmadan yürüdü: açılacak oturum yok.
      if (s) openSession(s.id);
    } finally {
      setSending(false);
    }
  };

  /** Composer dışı gönderimler (öneri kartı): hata fırlatmaz, ekrandaki hata satırına yazar. */
  const submit = (text: string) =>
    void send(text).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));

  const projectMenu = (e: React.MouseEvent) =>
    openAt(e.currentTarget as HTMLElement, {
      minWidth: 240,
      items: [
        { label: t("home.recentLabel"), isLabel: true },
        ...recent.map((p) => ({
          label: p.name,
          icon: "folder" as const,
          check: p.path === current?.path,
          onSelect: () => select(p),
        })),
        {
          label: t("home.useExisting"),
          icon: "folderPlus",
          top: true,
          onSelect: () => void pick(),
        },
      ],
    });

  const yerMenu = (e: React.MouseEvent) =>
    openAt(e.currentTarget as HTMLElement, {
      minWidth: 220,
      items: [
        { label: t("home.whereLabel"), isLabel: true },
        {
          label: yerLabel,
          icon: "mac",
          check: !worktree,
          active: !worktree,
          onSelect: () => setWorktree(false),
        },
        {
          label: t("home.newWorktree"),
          icon: "branch",
          top: true,
          check: worktree,
          disabled: !current?.isGit,
          desc: current?.isGit ? t("home.worktreeDesc") : t("home.gitNeeded"),
          onSelect: () => setWorktree(true),
        },
      ],
    });

  const branchMenu = (e: React.MouseEvent) => {
    if (!current) return;
    const list = branchesOf ?? [];
    openAt(e.currentTarget as HTMLElement, {
      minWidth: 200,
      items: list.length
        ? list.map((b) => ({
            label: b.name,
            check: b.current,
            active: b.current,
            onSelect: () => {
              if (!b.current)
                void checkout(current.path, b.name).catch((err) => setError(String(err)));
            },
          }))
        : [{ label: t("home.noBranch"), disabled: true }],
    });
  };

  return (
    <div className="relative isolate flex min-h-0 flex-1 flex-col items-center justify-center-safe overflow-y-auto px-8 py-10">
      <HomeBackdrop />
      {/* Logo yalnızca yeterince yüksek pencerede; yazma kutusunu aşağı itmez. */}
      <BrandLogo size={88} className="mb-[22px] hidden shrink-0 [@media(min-height:640px)]:block" />
      <h1 className="pb-[26px] text-[28px] font-semibold tracking-[-0.01em]">
        {showGreeting ? greeting(lang, userName) : t("home.whatTitle")}
      </h1>

      <div className="relative w-full max-w-[680px]">
        <HomeBox>
          <HomeTray>
            <Chip
              muted
              icon="folder"
              label={current?.name ?? t("home.projectSelect")}
              onClick={projectMenu}
            />
            {current?.isGit ? (
              <Chip
                muted
                icon="branch"
                mono
                label={gitStatus?.branch || branch}
                onClick={branchMenu}
              />
            ) : null}
            <span className="flex-1" />
            <Chip
              muted
              icon={worktree ? "branch" : "mac"}
              label={worktree ? t("home.newWorktree") : yerLabel}
              onClick={yerMenu}
            />
          </HomeTray>
          <div className="relative">
            <Composer
              ref={palette.composerRef}
              hideAttach
              draft={draft}
              onDraft={(d) => saveHomeDraft(HOME_DRAFT, d)}
              placeholder={t("home.whatTitle")}
              variant="home"
              busy={sending}
              onSend={send}
              slash={palette.slash}
              left={
                <>
                  {palette.button}
                  <PermissionChip value={permission} onChange={setPermission} />
                </>
              }
              right={<HomeChips />}
            />
          </div>
        </HomeBox>
      </div>
      {error ? (
        <ErrorBar {...splitError(error)} onDismiss={() => setError(null)} className="mt-3" />
      ) : null}

      {showCards ? (
        <div className="w-full max-w-[680px]">
          <Suggestions
            items={suggestionsFor(current?.isGit ?? false, t)}
            // Metinsiz öneri ("Özelleştir") kutuyu boşaltır; palet metni doğrudan textarea'ya
            // yazdığı için temizlik de oradan geçmeli, taslak durumundan değil.
            onPick={(text) => (text ? submit(text) : palette.composerRef.current?.setText(""))}
          />
        </div>
      ) : null}

      <div className="pt-7 text-[12px] text-tx3">
        {t("home.stats", {
          sessions: list.filter((s) => s.mode === "kodlama" && !s.archived).length,
          projects: recent.length,
          tokens: formatTokens(tokens, lang),
        })}
      </div>
    </div>
  );
}
