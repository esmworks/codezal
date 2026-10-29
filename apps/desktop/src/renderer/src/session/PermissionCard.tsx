import type { PermissionDecision, PermissionRequest } from "@codezal/contracts";
import type { TranslationKey } from "@codezal/i18n";
import { useTranslation } from "react-i18next";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";

interface Props {
  request: PermissionRequest;
  onDecide: (decision: PermissionDecision) => void;
}

const TITLE_KEYS: Record<PermissionRequest["kind"], TranslationKey> = {
  read: "permission.read",
  search: "permission.search",
  create: "permission.create",
  edit: "permission.edit",
  delete: "permission.delete",
  terminal: "permission.terminal",
  audit: "permission.audit",
  other: "permission.other",
};

/** Satır içi onay kartı (PRD §6). */
export function PermissionCard({ request, onDecide }: Props) {
  const { t } = useTranslation();
  const detail = request.command ?? request.target ?? request.toolName;
  // Ayrık koşu da bellekteki alt ajan da ana oturumda sorar; kullanıcı kimin sorduğunu görmeli.
  const from = request.run?.title ?? request.agent;
  // `web_fetch`te hedef alan adıdır; oturum izni yalnız ona verilir, kart bunu açıkça söyler.
  // `web_search`te kart sorguyu gösterir; oturum izni bütün aramaları kapsar.
  const web = request.toolName === "web_fetch";
  const search = request.toolName === "web_search";
  const title = web ? "permission.web" : search ? "permission.webSearch" : TITLE_KEYS[request.kind];
  const hint =
    web && request.target
      ? t("permission.webDomain", { host: request.target })
      : search
        ? t("permission.webSearchScope")
        : undefined;
  return (
    <div
      className={`flex flex-col gap-3 rounded-[12px] border bg-card2 px-4 py-3 ${
        request.dangerous ? "border-red" : "border-accLine"
      }`}
    >
      <div className="flex items-center gap-2 text-[13px]">
        <Icon
          name={request.dangerous ? "permFull" : "permAsk"}
          size={15}
          className={request.dangerous ? "text-red" : "text-accTx"}
        />
        <span className="font-medium text-tx">{t(title)}</span>
        <span className="text-tx3">· {request.toolName}</span>
        {from ? (
          <span className="min-w-0 truncate text-tx3" title={from}>
            · {t("permission.fromAgent", { title: from })}
          </span>
        ) : null}
        {request.dangerous ? (
          <span className="rounded-[5px] bg-chip px-[6px] text-[11px] text-red">
            {t("permission.dangerous")}
          </span>
        ) : null}
      </div>
      <pre className="overflow-x-auto rounded-[8px] border border-line bg-bg px-3 py-2 font-mono text-[12px] leading-[1.6] text-tx">
        {detail}
      </pre>
      {hint ? <p className="text-[12px] text-tx3">{hint}</p> : null}
      <div className="flex items-center gap-2">
        <Button variant="primary" onClick={() => onDecide("allow")}>
          <Icon name="check" size={13} stroke={2.2} /> {t("permission.allow")}
        </Button>
        <Button
          variant="secondary"
          onClick={() => onDecide("allow-session")}
          disabled={request.dangerous}
        >
          {t("permission.allowSession")}
        </Button>
        <span className="flex-1" />
        <Button variant="danger" onClick={() => onDecide("deny")}>
          {t("permission.deny")}
        </Button>
      </div>
    </div>
  );
}
