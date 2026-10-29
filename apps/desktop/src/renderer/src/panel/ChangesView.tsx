import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../api";
import { askConfirm } from "../components/Confirm";
import { FileTypeIcon } from "../lib/fileIcons";
import { DiffLines, RowChevron } from "../session/ToolCard";
import { useGit } from "../stores/git";

/**
 * "Tümünü geri al" akışı: onay ister, çalışma ağacını boşaltır ve durumu tazeler. Düğmeyi konak
 * (Değişiklikler sekmesi) çizer; akış burada durur ki gövdeyle aynı yerde tanımlı kalsın.
 */
export function useDiscardAll(cwd: string): { busy: boolean; discardAll: () => Promise<void> } {
  const { t } = useTranslation();
  const refresh = useGit((s) => s.refresh);
  const [busy, setBusy] = useState(false);
  const discardAll = async () => {
    const ok = await askConfirm({
      title: t("changes.discardTitle"),
      body: t("changes.confirmAll"),
      okLabel: t("changes.discardTitle"),
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await invoke("git:discard", { cwd });
      await refresh(cwd);
    } finally {
      setBusy(false);
    }
  };
  return { busy, discardAll };
}

/**
 * Değişiklik listesi: dal ve toplamlar, dosya satırları (durum harfi, +/−), satır içi diff ve
 * dosya başına "geri al". Sağ paneldeki Değişiklikler sekmesi kullanır; eylemler (`actions`) ve
 * alt şerit (`footer`) konağa bırakılır.
 */
export function ChangesView({
  cwd,
  actions,
  footer,
}: {
  cwd: string;
  /** Üst şeridin sağındaki küçük eylemler (ör. yenile). */
  actions?: ReactNode;
  /** Alt şerit: dar panelde sığmayan eylemler (geri al, commit) buraya. */
  footer?: ReactNode;
}) {
  const { t } = useTranslation();
  const status = useGit((s) => s.status[cwd]);
  const refresh = useGit((s) => s.refresh);
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [diff, setDiff] = useState("");

  useEffect(() => {
    void refresh(cwd);
  }, [cwd, refresh]);

  useEffect(() => {
    if (!diffPath) return;
    // İstek kimliği: `git:diff` süreç doğurur ve yavaş olabilir; kullanıcı bu sırada başka bir
    // dosyaya geçerse geç dönen yanıt eskiden yeni dosyanın altına çiziliyordu (yanlış diff).
    let current = true;
    invoke("git:diff", { cwd, path: diffPath })
      .then((text) => {
        if (current) setDiff(text);
      })
      .catch(() => {
        if (current) setDiff("");
      });
    return () => {
      current = false;
    };
  }, [cwd, diffPath]);

  const discardOne = async (path: string) => {
    const ok = await askConfirm({
      title: t("changes.discardTitle"),
      body: t("changes.confirmOne", { path }),
      okLabel: t("changes.discardTitle"),
      danger: true,
    });
    if (!ok) return;
    await invoke("git:discard", { cwd, path });
    await refresh(cwd);
    if (diffPath === path) setDiffPath(null);
  };

  const files = status?.files ?? [];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-[10px] py-[7px]">
        {/* Dal ve toplamlar solda, eylemler (yenile) sağda; dar panelde dal kırpılır. */}
        <span className="min-w-0 flex-1 truncate font-code text-[12px] text-tx3">
          {status?.branch ?? ""}
        </span>
        {files.length > 0 ? (
          <span className="shrink-0 font-code text-[12px] text-tx2">
            {t("env.changedFiles", { count: files.length })}
          </span>
        ) : null}
        <span className="shrink-0 font-code text-[12px] text-add">+{status?.additions ?? 0}</span>
        <span className="shrink-0 font-code text-[12px] text-del">−{status?.deletions ?? 0}</span>
        {actions}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {!status?.isRepo ? (
          <div className="px-1 py-4 text-[13px] text-tx3">{t("changes.notRepo")}</div>
        ) : null}
        {status?.isRepo && files.length === 0 ? (
          <div className="px-1 py-4 text-[13px] text-tx3">{t("changes.clean")}</div>
        ) : null}
        <div className="flex flex-col">
          {files.map((f, index) => {
            const deleted = f.status === "D";
            const name = f.path.split("/").pop() ?? f.path;
            const dir = f.path.slice(0, Math.max(0, f.path.length - name.length - 1));
            const open = diffPath === f.path;
            return (
              <div key={f.path} className={index === 0 ? "" : "border-t border-line"}>
                {/* ZCode'un dosya satırı: tür ikonu, ad, soluk klasör, +/- ve açılma oku. */}
                <div
                  onClick={() => setDiffPath(open ? null : f.path)}
                  className="group flex cursor-pointer items-center gap-[8px] px-[10px] py-[7px] font-code text-[12.5px] hover:bg-hov"
                >
                  <FileTypeIcon name={name} size={15} />
                  <span
                    className={`min-w-0 shrink-0 truncate font-medium ${deleted ? "text-tx3 line-through" : "text-tx"}`}
                  >
                    {name}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-tx3">
                    {f.renamedFrom ? `← ${f.renamedFrom}` : dir}
                  </span>
                  <span className="shrink-0 text-[12px] text-add">+{f.additions}</span>
                  <span className="shrink-0 text-[12px] text-del">−{f.deletions}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void discardOne(f.path);
                    }}
                    className="invisible shrink-0 text-[12px] text-tx3 hover:text-red group-hover:visible"
                    title={t("changes.discardTitle")}
                  >
                    ↺
                  </button>
                  <RowChevron open={open} always />
                </div>
                {open ? (
                  // Diff görünümü sohbet kartlarıyla aynı: satır numarası cetveli, ekleme/silme
                  // dolgusu, değişen parçanın vurgusu ve değişmeyen blok ayraçları. Yükseklik
                  // sınırlanmaz: dosyanın **tüm** hunk'ları görünür, kaydırmayı panel yapar (iç
                  // kaydırma kutusu dosyanın yalnız ilk parçasını gösteriyordu).
                  <div className="my-1 overflow-x-auto rounded-[8px] border border-line bg-bg">
                    <DiffLines
                      output={diff}
                      kind="edit"
                      empty={t("changes.noDiff")}
                      path={f.path}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      {footer ? (
        <div className="flex shrink-0 items-center gap-3 border-t border-line px-3 py-2">
          {footer}
        </div>
      ) : null}
    </div>
  );
}
