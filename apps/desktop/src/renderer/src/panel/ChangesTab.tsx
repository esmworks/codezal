import { useTranslation } from "react-i18next";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { useApp } from "../stores/app";
import { useGit } from "../stores/git";
import { ChangesView, useDiscardAll } from "./ChangesView";

/**
 * Sağ paneldeki Değişiklikler sekmesi: çalışma ağacının tam listesi, dosya başına geri alma ve
 * satır içi diff. "Commit" düğmesi commit penceresini açar (form olduğu için pencere olarak kalır).
 */
export function ChangesTab({ cwd }: { cwd: string }) {
  const { t } = useTranslation();
  const setModal = useApp((s) => s.setModal);
  const status = useGit((s) => s.status[cwd]);
  const refresh = useGit((s) => s.refresh);
  const { busy, discardAll } = useDiscardAll(cwd);
  const empty = (status?.files.length ?? 0) === 0;
  return (
    <ChangesView
      cwd={cwd}
      actions={
        <button
          type="button"
          title={t("changes.refresh")}
          onClick={() => void refresh(cwd)}
          className="flex h-[22px] shrink-0 items-center gap-[5px] rounded-[6px] px-[7px] text-[12px] text-tx3 hover:bg-hov hover:text-tx"
        >
          <Icon name="loop" size={12} />
          {t("changes.refresh")}
        </button>
      }
      footer={
        <>
          <button
            type="button"
            disabled={busy || empty}
            onClick={() => void discardAll()}
            className="shrink-0 text-[12px] text-red enabled:hover:underline disabled:text-tx3"
          >
            {t("changes.discardAll")}
          </button>
          <span className="flex-1" />
          <Button variant="primary" size="sm" disabled={empty} onClick={() => setModal("commit")}>
            {t("commit.title")}
          </Button>
        </>
      }
    />
  );
}
