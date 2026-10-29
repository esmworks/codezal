import type { McpConnector, McpToolPolicy } from "@codezal/contracts";
import type { TranslationKey } from "@codezal/i18n";
import type { TFunction } from "i18next";
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/Button";
import { Checkbox } from "../../components/Checkbox";
import { askConfirm } from "../../components/Confirm";
import { useCopy } from "../../components/CopyButton";
import { Icon } from "../../components/Icon";
import { Modal } from "../../components/Modal";
import { Toggle } from "../../components/Toggle";
import type { IconName } from "../../icons";
import {
  CATALOG_CATEGORIES,
  type CatalogAuth,
  type CatalogCategory,
  type CatalogEntry,
  CONNECTOR_CATALOG,
  OWN_CLIENT_REDIRECT_URI,
  sameUrl,
} from "../../lib/connectorCatalog";
import { CONNECTOR_LOGOS, logoInk, monogramOf } from "../../lib/connectorLogos";
import { matchesFold } from "../../lib/searchText";
import { parseEnvLines, splitArgs } from "../../lib/stdioForm";
import { activeTools, connectedToolCount, pendingTools, useMcp } from "../../stores/mcp";
import { type MenuItem, useMenu } from "../../stores/menu";
import { humanizeError, toast } from "../../stores/toast";
import {
  Card,
  Chip,
  EmptyState,
  IconButton,
  ListRow,
  Note,
  SearchBox,
  Section,
  SegmentedTabs,
  Tabs,
  Toolbar,
} from "../list";

// ---------- Servisler (uzak MCP bağlayıcıları) ----------

/**
 * Bağlı araçların toplamı bu sayıyı aşınca modele tek satırlık katalog gider, tam tanımlar
 * `tool_search` ile yüklenir (agent DIRECT_TOOL_LIMIT). Uyarı tek servisin araç sayısına değil
 * toplama bakar: 12'şer araçlı iki servis de erteleme eşiğini aşar.
 */
const DIRECT_TOOL_LIMIT = 20;

type Filter = "all" | CatalogCategory;

type PageTab = "connected" | "catalog";

/**
 * Durum rozeti yalnız istisnada görünür: her satırda yeşil "Bağlı" yazmak bilgi taşımıyor, asıl
 * dikkat isteyen satırları gölgeliyordu. Bağlı ve kapatılmış servis rozetsizdir.
 */
const STATUS_CHIP: Partial<Record<McpConnector["status"], { key: TranslationKey; dot: string }>> = {
  connecting: { key: "settings.connectors.statusConnecting", dot: "bg-amber" },
  disconnected: { key: "settings.connectors.statusDisconnected", dot: "bg-tx3" },
  "needs-login": { key: "settings.connectors.statusNeedsLogin", dot: "bg-amber" },
  error: { key: "settings.connectors.statusError", dot: "bg-red" },
};

/**
 * Katalog kartında yalnız varsayılandan farklı giriş biçimi yazılır. "Tarayıcıda giriş" her satırda
 * aynıydı; kullanıcıdan bir şey isteyen (anahtar, kendi istemci) ya da hiç istemeyen öne çıkar.
 */
const CATALOG_AUTH_BADGE: Partial<Record<CatalogAuth, { key: TranslationKey; icon: IconName }>> = {
  open: { key: "settings.connectors.authOpen", icon: "check" },
  token: { key: "settings.connectors.authToken", icon: "keys" },
  ownClient: { key: "settings.connectors.authOwnClient", icon: "user" },
};

const CATEGORY_KEYS: Record<CatalogCategory, TranslationKey> = {
  google: "settings.connectors.cat.google",
  productivity: "settings.connectors.cat.productivity",
  dev: "settings.connectors.cat.dev",
  docs: "settings.connectors.cat.docs",
  payments: "settings.connectors.cat.payments",
};

const CATEGORY_SHORT_KEYS: Record<CatalogCategory, TranslationKey> = {
  google: "settings.connectors.catShort.google",
  productivity: "settings.connectors.catShort.productivity",
  dev: "settings.connectors.catShort.dev",
  docs: "settings.connectors.catShort.docs",
  payments: "settings.connectors.catShort.payments",
};

const POLICIES: McpToolPolicy[] = ["auto", "ask", "off"];

const POLICY_KEYS: Record<McpToolPolicy, { label: TranslationKey; help: TranslationKey }> = {
  auto: {
    label: "settings.connectors.policy.auto",
    help: "settings.connectors.policy.autoHelp",
  },
  ask: { label: "settings.connectors.policy.ask", help: "settings.connectors.policy.askHelp" },
  off: { label: "settings.connectors.policy.off", help: "settings.connectors.policy.offHelp" },
};

const INPUT =
  "min-w-0 flex-1 rounded-[9px] border border-line2 bg-card px-[11px] py-[6px] text-[13px] text-tx outline-none placeholder:text-tx3";

/** Katalogdaki servisin kaydını adresten bulur; elle eklenenler için `undefined`. */
const catalogOf = (c: McpConnector) => CONNECTOR_CATALOG.find((e) => sameUrl(c.url, e.url));

const descKey = (entry: CatalogEntry) => `settings.connectorCatalog.${entry.id}` as TranslationKey;

const fail = (e: unknown) => toast.error(humanizeError(e));

/**
 * Marka logosu döşemesi. İnce iç çerçeve koyu logoyu (Notion, GitHub) koyu temada zeminden ayırır;
 * logosu olmayan servis marka renginde baş harf alır.
 */
function ServiceLogo({
  entry,
  name,
  size = 40,
}: {
  entry: CatalogEntry | undefined;
  name: string;
  size?: number;
}) {
  const logo = entry ? CONNECTOR_LOGOS[entry.id] : undefined;
  const box = {
    width: size,
    height: size,
    borderRadius: Math.max(4, Math.round(size / 4)),
  };
  const base = "flex shrink-0 items-center justify-center ring-1 ring-line ring-inset";
  if (logo) {
    const bg = logo.inverted ? "#ffffff" : logo.hex;
    const mark = Math.round(size * (logo.scale ?? 0.55));
    return (
      <span className={base} style={{ ...box, backgroundColor: bg }}>
        <svg
          width={mark}
          height={mark}
          viewBox="0 0 24 24"
          fill={logo.inverted ? logo.hex : logoInk(logo.hex)}
          aria-hidden="true"
        >
          <path d={logo.path} />
        </svg>
      </span>
    );
  }
  const bg = entry?.color ?? "#5B6470";
  const text = entry?.monogram ?? monogramOf(name);
  return (
    <span
      aria-hidden="true"
      className={`${base} font-semibold tracking-[-0.02em]`}
      style={{
        ...box,
        backgroundColor: bg,
        color: logoInk(bg),
        fontSize: Math.round(size * (text.length > 1 ? 0.36 : 0.46)),
      }}
    >
      {text}
    </span>
  );
}

function StatusChip({ c }: { c: McpConnector }) {
  const { t } = useTranslation();
  const loggingIn = useMcp((s) => s.loggingIn === c.id);
  if (loggingIn) return <Chip dot="bg-amber">{t("settings.connectors.loggingIn")}</Chip>;
  const chip = c.enabled ? STATUS_CHIP[c.status] : undefined;
  return chip ? <Chip dot={chip.dot}>{t(chip.key)}</Chip> : null;
}

function AccountLabel({ account }: { account: string }) {
  return (
    <span className="flex min-w-0 items-center gap-[5px] text-[12px] text-tx2" title={account}>
      <Icon name="user" size={12} className="shrink-0 text-tx3" />
      <span className="truncate">{account}</span>
    </span>
  );
}

/** Uygulama içi servis rozeti; MCP sunucusu olmadığını açıklar. */
function NativeChip() {
  const { t } = useTranslation();
  return (
    <Chip icon="sparkle" title={t("settings.connectors.nativeHelp")}>
      {t("settings.connectors.native")}
    </Chip>
  );
}

// ---------- Araç izinleri ----------

/** "4 araç" düğmesi: araç listesini ve izinlerini açar; kapatılan varsa "3/4 araç" yazar. */
function ToolsToggle({
  c,
  open,
  onToggle,
}: {
  c: McpConnector;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  if (c.status !== "connected" || c.tools.length === 0) return null;
  const active = activeTools(c).length;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      title={open ? t("settings.connectors.hideTools") : t("settings.connectors.showTools")}
      className="flex h-[28px] shrink-0 items-center gap-1 rounded-[8px] px-2 text-[12px] text-tx2 hover:bg-hov hover:text-tx"
    >
      {active === c.tools.length
        ? t("settings.connectors.toolCount", { count: c.tools.length })
        : t("settings.connectors.toolCountPartial", { active, count: c.tools.length })}
      <Icon
        name="chevronDown"
        size={12}
        className={`transition-transform ${open ? "rotate-180" : ""}`}
      />
    </button>
  );
}

function PolicySwitch({
  value,
  label,
  onChange,
}: {
  value: McpToolPolicy;
  label: string;
  onChange: (policy: McpToolPolicy) => void;
}) {
  const { t } = useTranslation();
  return (
    <fieldset
      aria-label={label}
      className="m-0 flex shrink-0 items-center rounded-[8px] border border-line2 bg-card p-[2px]"
    >
      {POLICIES.map((p) => (
        <button
          key={p}
          type="button"
          aria-pressed={value === p}
          title={t(POLICY_KEYS[p].help)}
          onClick={() => {
            if (value !== p) onChange(p);
          }}
          className={`h-[22px] rounded-[6px] px-[9px] text-[11.5px] transition-colors ${
            value === p
              ? "bg-sel font-medium text-tx shadow-[var(--selSh)]"
              : "text-tx3 hover:text-tx"
          }`}
        >
          {t(POLICY_KEYS[p].label)}
        </button>
      ))}
    </fieldset>
  );
}

/**
 * Servisin araçları ve izinleri. "Sor" varsayılandır ve oturumun izin moduna uyar; "Otomatik"
 * soruyu kaldırır, "Kapalı" aracı ajandan tümüyle çeker.
 */
function ToolPanel({ c }: { c: McpConnector }) {
  const { t } = useTranslation();
  const setToolPolicy = useMcp((s) => s.setToolPolicy);
  const openAt = useMenu((s) => s.openAt);
  const apply = (tools: string[], policy: McpToolPolicy) => {
    if (tools.length > 0) void setToolPolicy(c.id, tools, policy).catch(fail);
  };
  const all = c.tools.map((tool) => tool.name);
  const readOnly = c.tools.filter((tool) => tool.readOnly).map((tool) => tool.name);
  const bulk = (e: MouseEvent<HTMLButtonElement>) => {
    const items: MenuItem[] = [
      { label: t("settings.connectors.allAuto"), onSelect: () => apply(all, "auto") },
      { label: t("settings.connectors.allAsk"), onSelect: () => apply(all, "ask") },
      { label: t("settings.connectors.allOff"), onSelect: () => apply(all, "off") },
    ];
    if (readOnly.length > 0 && readOnly.length < all.length)
      items.push({
        label: t("settings.connectors.readOnlyAuto"),
        icon: "eye",
        onSelect: () => apply(readOnly, "auto"),
      });
    openAt(e.currentTarget, { items });
  };
  return (
    <div className="mt-3 overflow-hidden rounded-[10px] border border-line bg-bg2">
      <div className="flex items-center gap-3 border-b border-line px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-medium text-tx2">
            {t("settings.connectors.toolsTitle")}
          </div>
          <div className="text-[11.5px] leading-[1.4] text-tx3">
            {t("settings.connectors.toolsHint")}
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={bulk}>
          {t("settings.connectors.setAll")}
          <Icon name="chevronDown" size={12} />
        </Button>
      </div>
      {c.tools.map((tool, i) => (
        <div
          key={tool.name}
          className={`flex items-center gap-3 px-3 py-[7px] ${i === 0 ? "" : "border-t border-line"}`}
        >
          <div className={`min-w-0 flex-1 ${tool.policy === "off" ? "opacity-55" : ""}`}>
            <div className="flex items-center gap-2">
              <span className="truncate font-mono text-[12px] text-tx">{tool.name}</span>
              {tool.readOnly ? (
                <Chip icon="eye" title={t("settings.connectors.readOnlyHelp")}>
                  {t("settings.connectors.readOnly")}
                </Chip>
              ) : null}
            </div>
            {tool.description ? (
              <div className="truncate text-[12px] text-tx3" title={tool.description}>
                {tool.description}
              </div>
            ) : null}
          </div>
          <PolicySwitch
            value={tool.policy}
            label={tool.name}
            onChange={(policy) => apply([tool.name], policy)}
          />
        </div>
      ))}
    </div>
  );
}

/** Açıklama satırı: boş açıklama da görünür kalsın (silinmesi de bir değişikliktir). */
function DescriptionLine({ label, text, tone }: { label: string; text: string; tone: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex gap-2 text-[12px] leading-[1.45]">
      <span className="w-[52px] shrink-0 text-tx3">{label}</span>
      <span className={`min-w-0 flex-1 whitespace-pre-wrap break-words ${tone}`}>
        {text || t("settings.connectors.reviewNoDescription")}
      </span>
    </div>
  );
}

/**
 * Onay bekleyen araçlar (tool poisoning savunması): sunucu ilk onaydan sonra araç ekledi ya da
 * tanımını değiştirdi. Satırda kapalı panel arkasında kalmaz, açık görünür; değişen araçta önceki
 * ve yeni açıklama alt alta yazılır. Onaylanana kadar araç ajana verilmez.
 */
function ReviewPanel({ c }: { c: McpConnector }) {
  const { t } = useTranslation();
  const approveTools = useMcp((s) => s.approveTools);
  const pending = pendingTools(c);
  if (pending.length === 0) return null;
  const approve = (names: string[]) =>
    void approveTools(c.id, names)
      .then(() => toast.success(t("settings.connectors.approvedToast")))
      .catch(fail);
  return (
    <div className="mt-3 overflow-hidden rounded-[10px] border border-amber/30 bg-amber/[0.05]">
      <div className="flex items-center gap-3 border-b border-amber/20 px-3 py-2">
        <Icon name="alert" size={14} className="shrink-0 text-amber" />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-medium text-tx">
            {t("settings.connectors.reviewTitle")}
          </div>
          <div className="text-[11.5px] leading-[1.4] text-tx3">
            {t("settings.connectors.reviewHint")}
          </div>
        </div>
        {pending.length > 1 ? (
          <Button size="sm" onClick={() => approve(pending.map((tool) => tool.name))}>
            {t("settings.connectors.approveAll")}
          </Button>
        ) : null}
      </div>
      {pending.map((tool, i) => (
        <div
          key={tool.name}
          className={`flex items-start gap-3 px-3 py-[9px] ${i === 0 ? "" : "border-t border-amber/20"}`}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-mono text-[12px] text-tx">{tool.name}</span>
              <Chip dot="bg-amber">
                {tool.review === "new"
                  ? t("settings.connectors.reviewNew")
                  : t("settings.connectors.reviewChanged")}
              </Chip>
              {tool.schemaChanged ? <Chip>{t("settings.connectors.schemaChanged")}</Chip> : null}
            </div>
            {tool.review === "changed" ? (
              <DescriptionLine
                label={t("settings.connectors.reviewPrevious")}
                text={tool.previousDescription ?? ""}
                tone="text-tx3 line-through decoration-tx3/40"
              />
            ) : null}
            <DescriptionLine
              label={t("settings.connectors.reviewCurrent")}
              text={tool.description}
              tone="text-tx"
            />
          </div>
          <Button size="sm" variant="primary" onClick={() => approve([tool.name])}>
            {t("settings.connectors.approve")}
          </Button>
        </div>
      ))}
    </div>
  );
}

// ---------- Bağlı servisler ----------

/**
 * Satır eylemleri. Görünürde yalnız o an gereken eylem (Giriş yap, Yeniden bağlan) ve anahtar
 * kalır; çıkış, belgeler, adres ve kaldırma `⋯` menüsündedir. Eskiden her satırda dört denetim
 * vardı ve en sık kullanılan anahtar kalabalıkta kayboluyordu.
 */
function useConnectorActions(c: McpConnector) {
  const { t } = useTranslation();
  const openAt = useMenu((s) => s.openAt);
  const entry = catalogOf(c);
  const onLogin = async () => {
    try {
      await useMcp.getState().login(c.id);
      toast.success(t("settings.connectors.loginToast"));
    } catch (e) {
      fail(e);
    }
  };
  const onReconnect = () => void useMcp.getState().reconnect(c.id).catch(fail);
  const onRemove = () =>
    void askConfirm({
      title: t("settings.connectors.remove"),
      body: t("settings.connectors.confirmRemove", { name: c.name }),
      okLabel: t("settings.connectors.remove"),
      danger: true,
    }).then((ok) => {
      if (ok) void useMcp.getState().remove(c.id).catch(fail);
    });
  const openMenu = (e: MouseEvent<HTMLButtonElement>) => {
    const items: MenuItem[] = [];
    if (c.auth === "oauth" && c.status === "connected")
      items.push({
        label: t("settings.connectors.relogin"),
        icon: "user",
        onSelect: () => void onLogin(),
      });
    if (c.enabled && c.status !== "needs-login")
      items.push({
        label: t("settings.connectors.reconnect"),
        icon: "loop",
        onSelect: onReconnect,
      });
    if (c.auth === "oauth" && c.status !== "needs-login")
      items.push({
        label: t("settings.connectors.logout"),
        icon: "logout",
        onSelect: () => void useMcp.getState().logout(c.id).catch(fail),
      });
    if (entry)
      items.push({
        label: t("settings.connectors.docs"),
        icon: "docs",
        onSelect: () => void window.open(entry.docs, "_blank"),
      });
    const local = c.transport === "stdio";
    items.push({
      label: local ? t("settings.connectors.copyCommand") : t("settings.connectors.copyUrl"),
      icon: "copy",
      onSelect: () =>
        void navigator.clipboard
          .writeText(local ? (c.command ?? "") : c.url)
          .then(
            () =>
              toast.success(
                local ? t("settings.connectors.copiedCommand") : t("settings.connectors.copiedUrl"),
              ),
            fail,
          ),
    });
    items.push({
      label: t("settings.connectors.remove"),
      icon: "trash",
      danger: true,
      onSelect: onRemove,
    });
    openAt(e.currentTarget, { items });
  };
  const needsLogin = c.status === "needs-login" || (c.auth === "oauth" && c.status === "error");
  return { entry, onLogin, onReconnect, openMenu, needsLogin };
}

/** Satırın sağı: gereken tek eylem, araç sayısı, anahtar ve `⋯`. */
function ConnectorActions({
  c,
  actions,
  toolsOpen,
  onToggleTools,
}: {
  c: McpConnector;
  actions: ReturnType<typeof useConnectorActions>;
  toolsOpen: boolean;
  onToggleTools: () => void;
}) {
  const { t } = useTranslation();
  const setEnabled = useMcp((s) => s.setEnabled);
  const busy = useMcp((s) => s.loggingIn === c.id);
  let primary: ReactNode = null;
  if (c.enabled && actions.needsLogin)
    primary = (
      <Button size="sm" variant="primary" disabled={busy} onClick={() => void actions.onLogin()}>
        {t("settings.connectors.login")}
      </Button>
    );
  else if (c.enabled && c.status === "error")
    primary = (
      <Button size="sm" onClick={actions.onReconnect}>
        {t("settings.connectors.reconnect")}
      </Button>
    );
  return (
    <>
      {primary}
      <ToolsToggle c={c} open={toolsOpen} onToggle={onToggleTools} />
      <Toggle on={c.enabled} onChange={(v) => void setEnabled(c.id, v).catch(fail)} />
      <IconButton
        ghost
        name="more"
        title={t("settings.connectors.more")}
        onClick={actions.openMenu}
      />
    </>
  );
}

/**
 * Rozet satırı: hesap, kullanıcıdan bir şey isteyen kimlik biçimi ve uygulama içi servis. Adres
 * yalnız elle eklenen sunucuda yazar; katalogdakilerde `⋯ > Adresi kopyala` yeter.
 */
function connectorMeta(
  c: McpConnector,
  entry: CatalogEntry | undefined,
  t: TFunction,
): ReactNode[] | null {
  const parts: ReactNode[] = [];
  const change = c.toolChange;
  if (change) {
    // Ayrıntı (adlar) ipucunda: satır tek satır kalsın, sayılar yeter.
    const detail = [
      change.added.length > 0
        ? t("settings.connectors.toolsChangedAdded", { names: change.added.join(", ") })
        : "",
      change.removed.length > 0
        ? t("settings.connectors.toolsChangedRemoved", { names: change.removed.join(", ") })
        : "",
    ]
      .filter(Boolean)
      .join(" · ");
    parts.push(
      <Chip key="changed" dot="bg-amber" title={detail}>
        {t("settings.connectors.toolsChanged", {
          added: change.added.length,
          removed: change.removed.length,
        })}
      </Chip>,
    );
  }
  const pending = pendingTools(c).length;
  if (pending > 0)
    parts.push(
      <Chip key="review" icon="alert">
        {t("settings.connectors.pendingReview", { count: pending })}
      </Chip>,
    );
  if (c.account) parts.push(<AccountLabel key="account" account={c.account} />);
  if (c.ownClient)
    parts.push(
      <Chip key="own" icon="user">
        {t("settings.connectors.authOwnClient")}
      </Chip>,
    );
  if (c.auth === "bearer")
    parts.push(
      <Chip key="bearer" icon="keys">
        {t("settings.connectors.authBearer")}
      </Chip>,
    );
  if (entry?.native) parts.push(<NativeChip key="native" />);
  if (c.transport === "stdio") {
    parts.push(
      <Chip key="local" icon="code" title={t("settings.connectors.localHint")}>
        {t("settings.connectors.kindLocal")}
      </Chip>,
    );
    parts.push(
      <span key="cmd" className="truncate font-mono text-[11px] text-tx3" title={c.command ?? ""}>
        {c.command}
      </span>,
    );
  } else if (!entry)
    parts.push(
      <span key="url" className="truncate font-mono text-[11px] text-tx3">
        {c.url}
      </span>,
    );
  return parts.length > 0 ? parts : null;
}

/** Yerel komut düştüyse stderr'in son satırları: kullanıcı nedenini (eksik anahtar, sürüm) görsün. */
function StderrTail({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <div className="mt-2 overflow-hidden rounded-[10px] border border-line bg-bg2">
      <div className="border-b border-line px-3 py-[6px] text-[12px] font-medium text-tx2">
        {t("settings.connectors.stderrTitle")}
      </div>
      <pre className="max-h-[160px] overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-[11.5px] leading-[1.45] text-tx3">
        {text}
      </pre>
    </div>
  );
}

function ConnectorRow({ c, first }: { c: McpConnector; first: boolean }) {
  const { t } = useTranslation();
  const [showTools, setShowTools] = useState(false);
  const actions = useConnectorActions(c);
  const toolsOpen = showTools && c.status === "connected" && c.tools.length > 0;
  return (
    <ListRow
      first={first}
      dim={!c.enabled}
      logo={<ServiceLogo entry={actions.entry} name={c.name} />}
      title={
        <>
          <span className="truncate">{c.name}</span>
          <StatusChip c={c} />
        </>
      }
      desc={
        c.error ? (
          <span className="text-red" title={c.error}>
            {c.error}
          </span>
        ) : actions.entry ? (
          t(descKey(actions.entry))
        ) : null
      }
      meta={connectorMeta(c, actions.entry, t)}
      actions={
        <ConnectorActions
          c={c}
          actions={actions}
          toolsOpen={toolsOpen}
          onToggleTools={() => setShowTools((v) => !v)}
        />
      }
    >
      {toolsOpen ? (
        <div className="ml-[54px]">
          <ToolPanel c={c} />
        </div>
      ) : null}
      {pendingTools(c).length > 0 ? (
        <div className="ml-[54px]">
          <ReviewPanel c={c} />
        </div>
      ) : null}
      {c.stderr ? (
        <div className="ml-[54px]">
          <StderrTail text={c.stderr} />
        </div>
      ) : null}
    </ListRow>
  );
}

/** Aile kartındaki kısa satır; hesap ailede ortaksa başlıkta yazar, burada tekrarlanmaz. */
function GroupMemberRow({ c, showAccount }: { c: McpConnector; showAccount: boolean }) {
  const { t } = useTranslation();
  const [showTools, setShowTools] = useState(false);
  const actions = useConnectorActions(c);
  const toolsOpen = showTools && c.status === "connected" && c.tools.length > 0;
  const desc = c.error ? (
    <span className="text-red" title={c.error}>
      {c.error}
    </span>
  ) : showAccount && c.account ? (
    c.account
  ) : actions.entry ? (
    t(descKey(actions.entry))
  ) : null;
  return (
    <div className="py-[6px] pr-[18px] pl-[72px]">
      <div className={`flex items-center gap-3 ${c.enabled ? "" : "opacity-60"}`}>
        <ServiceLogo entry={actions.entry} name={c.name} size={28} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[13px] font-medium">
            <span className="truncate">{c.name}</span>
            <StatusChip c={c} />
          </div>
          {desc ? <div className="truncate text-[12px] text-tx3">{desc}</div> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ConnectorActions
            c={c}
            actions={actions}
            toolsOpen={toolsOpen}
            onToggleTools={() => setShowTools((v) => !v)}
          />
        </div>
      </div>
      {toolsOpen ? (
        <div className="ml-[40px]">
          <ToolPanel c={c} />
        </div>
      ) : null}
    </div>
  );
}

/** Aile kartının döşemesi: üyelerin logolarından 2x2 küçük mozaik (klasör simgesi gibi). */
function LogoMosaic({ members }: { members: McpConnector[] }) {
  return (
    <span className="grid h-[40px] w-[40px] shrink-0 grid-cols-2 gap-[2px] rounded-[10px] bg-chip p-[3px] ring-1 ring-line ring-inset">
      {members.slice(0, 4).map((m) => (
        <ServiceLogo key={m.id} entry={catalogOf(m)} name={m.name} size={16} />
      ))}
    </span>
  );
}

/**
 * Aynı OAuth istemcisini paylaşan aile (Google Workspace) tek kartta: istemci, hesap ve toplu
 * çıkış bir kez yazar, ürünler altında kısa satırlar olur. Altı ayrı satırda aynı iki rozet ve
 * altı "Çıkış yap" düğmesi tekrar ediyordu.
 */
function ConnectorGroup({
  name,
  members,
  first,
}: {
  name: string;
  members: McpConnector[];
  first: boolean;
}) {
  const { t } = useTranslation();
  const openAt = useMenu((s) => s.openAt);
  const accounts = [...new Set(members.flatMap((m) => (m.account ? [m.account] : [])))];
  const shared = accounts.length === 1 ? accounts[0] : undefined;
  const signedIn = members.filter((m) => m.auth === "oauth" && m.status !== "needs-login");
  const menu = (e: MouseEvent<HTMLButtonElement>) => {
    const items: MenuItem[] = [];
    if (signedIn.length > 0)
      items.push({
        label: t("settings.connectors.groupLogout"),
        icon: "logout",
        onSelect: () => {
          const { logout } = useMcp.getState();
          void Promise.all(signedIn.map((m) => logout(m.id))).catch(fail);
        },
      });
    items.push({
      label: t("settings.connectors.groupRemove"),
      icon: "trash",
      danger: true,
      onSelect: () =>
        void askConfirm({
          title: t("settings.connectors.groupRemove"),
          body: t("settings.connectors.confirmGroupRemove", { name, count: members.length }),
          okLabel: t("settings.connectors.remove"),
          danger: true,
        }).then(async (ok) => {
          if (!ok) return;
          const { remove } = useMcp.getState();
          // Sırayla: main her kaldırmada mağazayı yazar, eşzamanlı yazımlar birbirini ezmesin.
          for (const m of members) await remove(m.id).catch(fail);
        }),
    });
    openAt(e.currentTarget, { items });
  };
  return (
    <div className={first ? "" : "border-t border-line"}>
      <div className="flex items-center gap-[14px] px-[18px] pt-[13px] pb-[7px]">
        <LogoMosaic members={members} />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium">{name}</div>
          <div className="flex min-w-0 items-center gap-2 pt-[3px] text-[12px] text-tx3">
            {shared ? <AccountLabel account={shared} /> : null}
            <span className="shrink-0">
              {t("settings.connectors.groupServices", { count: members.length })} ·{" "}
              {t("settings.connectors.toolCount", { count: connectedToolCount(members) })}
            </span>
            {members.some((m) => m.ownClient) ? (
              <Chip icon="user">{t("settings.connectors.authOwnClient")}</Chip>
            ) : null}
            {members.every((m) => m.native !== null) ? <NativeChip /> : null}
          </div>
        </div>
        <IconButton ghost name="more" title={t("settings.connectors.more")} onClick={menu} />
      </div>
      <div className="pb-[7px]">
        {members.map((m) => (
          <GroupMemberRow key={m.id} c={m} showAccount={!shared} />
        ))}
      </div>
    </div>
  );
}

type Block =
  | { kind: "row"; c: McpConnector }
  | { kind: "group"; key: string; name: string; members: McpConnector[] };

/** Aynı `clientGroup`'tan en az iki servis varsa ilk üyenin yerinde tek kart olurlar. */
function toBlocks(connectors: McpConnector[], groupName: (c: McpConnector) => string): Block[] {
  const sizes = new Map<string, number>();
  for (const c of connectors)
    if (c.clientGroup) sizes.set(c.clientGroup, (sizes.get(c.clientGroup) ?? 0) + 1);
  const out: Block[] = [];
  const groups = new Map<string, Extract<Block, { kind: "group" }>>();
  for (const c of connectors) {
    const key = c.clientGroup;
    if (!key || (sizes.get(key) ?? 0) < 2) {
      out.push({ kind: "row", c });
      continue;
    }
    let group = groups.get(key);
    if (!group) {
      group = { kind: "group", key, name: groupName(c), members: [] };
      groups.set(key, group);
      out.push(group);
    }
    group.members.push(c);
  }
  return out;
}

/**
 * Dikkat isteyen servislerin özeti: giriş bekleyenler sırayla tarayıcıda açılır, bağlanamayanlar
 * yeniden denenir. Satırları tek tek taramadan sorunun nerede olduğu görünür.
 */
function AttentionBanner({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  const { t } = useTranslation();
  const connectors = useMcp((s) => s.connectors);
  const loggingIn = useMcp((s) => s.loggingIn);
  const [running, setRunning] = useState(false);
  const pending = connectors.filter(
    (c) => c.enabled && c.id !== loggingIn && (c.status === "needs-login" || c.status === "error"),
  );
  // Kısa listede tek sorunlu satır zaten gözde; şerit aynı düğmeyi ikinci kez göstermesin.
  if (pending.length === 0 || (pending.length === 1 && connectors.length <= 4)) return null;
  const logins = pending.filter(
    (c) => c.status === "needs-login" || (c.auth === "oauth" && c.status === "error"),
  );
  const errors = pending.length - logins.length;
  const loginAll = async () => {
    setRunning(true);
    try {
      for (const c of logins) {
        try {
          await useMcp.getState().login(c.id);
        } catch (e) {
          toast.error(`${c.name}: ${humanizeError(e)}`);
        }
      }
    } finally {
      setRunning(false);
    }
  };
  return (
    <div
      role="status"
      className="flex items-center gap-3 rounded-[12px] border border-amber/30 bg-amber/[0.06] px-[14px] py-[10px]"
    >
      <Icon name="alert" size={16} className="shrink-0 text-amber" />
      <div className="min-w-0 flex-1 leading-[1.4]">
        <div className="text-[13px] font-medium text-tx">
          {t("settings.connectors.attention", { count: pending.length })}
        </div>
        <div className="truncate text-[12px] text-tx3">{pending.map((c) => c.name).join(", ")}</div>
      </div>
      {errors > 0 ? (
        <Button size="sm" disabled={retrying} onClick={onRetry}>
          {t("settings.connectors.retry")}
        </Button>
      ) : null}
      {logins.length > 0 ? (
        <Button
          size="sm"
          variant="primary"
          disabled={running || loggingIn !== null}
          onClick={() => void loginAll()}
        >
          {logins.length === 1 ? t("settings.connectors.login") : t("settings.connectors.loginAll")}
        </Button>
      ) : null}
    </div>
  );
}

// ---------- Ekleme ----------

/**
 * Katalog girişini ekler; giriş gerekiyorsa tarayıcı akışını başlatır. `onAdded` eklenir eklenmez
 * çağrılır: form kapanır, giriş beklenirken satır "Tarayıcıda giriş bekleniyor…" gösterir.
 * `onView` bildirimdeki "Bağlı servislerde gör" eylemidir; kullanıcı katalogda kalıp arka arkaya
 * ekleyebilsin diye sekme kendiliğinden değişmez.
 */
async function addFromCatalog(
  entry: CatalogEntry,
  t: TFunction,
  extra: {
    token?: string | null;
    oauthClient?: { clientId: string; clientSecret: string };
    copyClientFrom?: string;
  } = {},
  hooks: { onAdded?: () => void; onView?: () => void } = {},
): Promise<void> {
  const { add, login } = useMcp.getState();
  const c = await add({
    name: entry.name,
    url: entry.url,
    token: extra.token ?? null,
    ...(extra.oauthClient ? { oauthClient: extra.oauthClient } : {}),
    ...(extra.copyClientFrom ? { copyClientFrom: extra.copyClientFrom } : {}),
    ...(entry.authorizeParams ? { authorizeParams: entry.authorizeParams } : {}),
    ...(entry.clientGroup ? { clientGroup: entry.clientGroup } : {}),
    ...(entry.native ? { native: entry.native } : {}),
  });
  hooks.onAdded?.();
  const onView = hooks.onView;
  toast.success(
    t("settings.connectors.addedToast"),
    onView ? { label: t("settings.connectors.viewConnected"), run: onView } : undefined,
  );
  if (c.status === "needs-login") {
    await login(c.id);
    toast.success(t("settings.connectors.loginToast"));
  } else if (c.status === "error" && c.error) toast.error(c.error);
}

function FormField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-[150px] shrink-0 text-[13px] text-tx2">{label}</span>
      {children}
    </div>
  );
}

type ServerKind = "http" | "stdio";

/**
 * Katalog dışı sunucu. Uzak sunucu: ad, adres ve isteğe bağlı API anahtarı. Yerel komut: komut,
 * argümanlar, ortam değişkenleri ve çalışma klasörü; süreç Codezal'ın kimlik ortamını almaz.
 */
/** `onAdded`: eklenen servis "Bağlı" sekmesinde görünsün (Hazır servisler'de kalınca kayboluyordu). */
function AddServerModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const { t } = useTranslation();
  const add = useMcp((s) => s.add);
  const addStdio = useMcp((s) => s.addStdio);
  const [kind, setKind] = useState<ServerKind>("http");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [envText, setEnvText] = useState("");
  const [cwd, setCwd] = useState("");
  const [busy, setBusy] = useState(false);
  const env = parseEnvLines(envText);
  const filled =
    name.trim().length > 0 &&
    (kind === "http" ? url.trim().length > 0 : command.trim().length > 0 && !env.invalid.length);
  const canSave = filled && !busy;

  const submit = async () => {
    if (!canSave) return;
    setBusy(true);
    try {
      const c =
        kind === "http"
          ? await add({ name, url, token: token.trim() ? token.trim() : null })
          : await addStdio({
              name,
              command: command.trim(),
              args: splitArgs(args),
              env: env.env,
              cwd: cwd.trim() ? cwd.trim() : null,
            });
      toast.success(t("settings.connectors.addedToast"));
      if (c.status === "error" && c.error) toast.error(c.error);
      onAdded();
      onClose();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const onEnter = (e: KeyboardEvent) => {
    if (e.key === "Enter") void submit();
  };
  const kinds = [
    { key: "http" as ServerKind, label: t("settings.connectors.kindRemote") },
    { key: "stdio" as ServerKind, label: t("settings.connectors.kindLocal") },
  ];

  return (
    <Modal
      title={
        kind === "http" ? t("settings.connectors.addTitle") : t("settings.connectors.addLocalTitle")
      }
      onClose={onClose}
      width={560}
      footer={
        <>
          <span className="flex-1 text-[12px] text-tx3">
            {kind === "http"
              ? t("settings.connectors.tokenHint")
              : t("settings.connectors.localHint")}
          </span>
          <Button size="sm" onClick={onClose} disabled={busy}>
            {t("settings.connectors.cancel")}
          </Button>
          <Button size="sm" variant="primary" disabled={!canSave} onClick={() => void submit()}>
            {busy ? t("settings.connectors.adding") : t("settings.connectors.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-[10px]">
        <div>
          <SegmentedTabs value={kind} items={kinds} onChange={setKind} />
        </div>
        <FormField label={t("settings.connectors.name")}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("settings.connectors.namePlaceholder")}
            className={INPUT}
          />
        </FormField>
        {kind === "http" ? (
          <>
            <FormField label={t("settings.connectors.url")}>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={t("settings.connectors.urlPlaceholder")}
                onKeyDown={onEnter}
                className={`${INPUT} font-mono text-[12px]`}
              />
            </FormField>
            <FormField label={t("settings.connectors.token")}>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={t("settings.connectors.tokenPlaceholder")}
                onKeyDown={onEnter}
                className={`${INPUT} font-mono text-[12px]`}
              />
            </FormField>
          </>
        ) : (
          <>
            <FormField label={t("settings.connectors.command")}>
              <input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder={t("settings.connectors.commandPlaceholder")}
                className={`${INPUT} font-mono text-[12px]`}
              />
            </FormField>
            <FormField label={t("settings.connectors.args")}>
              <input
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder={t("settings.connectors.argsPlaceholder")}
                className={`${INPUT} font-mono text-[12px]`}
              />
            </FormField>
            <div className="flex items-start gap-3">
              <span className="w-[150px] shrink-0 pt-[6px] text-[13px] text-tx2">
                {t("settings.connectors.env")}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <textarea
                  value={envText}
                  onChange={(e) => setEnvText(e.target.value)}
                  placeholder={t("settings.connectors.envPlaceholder")}
                  rows={3}
                  spellCheck={false}
                  className={`${INPUT} resize-none font-mono text-[12px]`}
                />
                {env.invalid.length > 0 ? (
                  <span className="truncate text-[12px] text-red">
                    {t("settings.connectors.envInvalid", { line: env.invalid[0] ?? "" })}
                  </span>
                ) : null}
              </div>
            </div>
            <FormField label={t("settings.connectors.cwd")}>
              <input
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder={t("settings.connectors.cwdPlaceholder")}
                onKeyDown={onEnter}
                className={`${INPUT} font-mono text-[12px]`}
              />
            </FormField>
          </>
        )}
      </div>
    </Modal>
  );
}

/**
 * Kullanıcıdan bilgi isteyen katalog girişleri: `token` belirteç alanı, `ownClient` kendi OAuth
 * istemcisi. Aynı ailede (Google) kendi istemcisiyle eklenmiş servis varsa kimlik tekrar sorulmaz.
 */
function CatalogFormModal({
  entry,
  onClose,
  onView,
}: {
  entry: CatalogEntry;
  onClose: () => void;
  onView: () => void;
}) {
  const { t } = useTranslation();
  const connectors = useMcp((s) => s.connectors);
  const [token, setToken] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [useSibling, setUseSibling] = useState(true);
  const [busy, setBusy] = useState(false);
  const { copied, copy } = useCopy();
  const needsClient = entry.auth === "ownClient";
  const sibling = needsClient
    ? (connectors.find((c) => c.ownClient && c.clientGroup === entry.clientGroup) ?? null)
    : null;
  const copyClient = sibling !== null && useSibling;
  const canSubmit =
    !busy &&
    (entry.auth === "token"
      ? entry.tokenOptional === true || token.trim().length > 0
      : !needsClient ||
        copyClient ||
        (clientId.trim().length > 0 && clientSecret.trim().length > 0));

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await addFromCatalog(
        entry,
        t,
        {
          token: entry.auth === "token" && token.trim() ? token.trim() : null,
          ...(needsClient && copyClient && sibling ? { copyClientFrom: sibling.id } : {}),
          ...(needsClient && !copyClient
            ? { oauthClient: { clientId: clientId.trim(), clientSecret: clientSecret.trim() } }
            : {}),
        },
        { onAdded: onClose, onView },
      );
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const onEnter = (e: KeyboardEvent) => {
    if (e.key === "Enter") void submit();
  };

  return (
    <Modal
      title={t("settings.connectors.addTitleFor", { name: entry.name })}
      onClose={onClose}
      width={560}
      footer={
        <>
          <a
            href={entry.docs}
            target="_blank"
            rel="noreferrer"
            className="mr-auto text-[12px] text-tx3 hover:text-tx"
          >
            {t("settings.connectors.docs")}
          </a>
          <Button size="sm" onClick={onClose} disabled={busy}>
            {t("settings.connectors.cancel")}
          </Button>
          <Button size="sm" variant="primary" disabled={!canSubmit} onClick={() => void submit()}>
            {busy
              ? t("settings.connectors.adding")
              : needsClient
                ? t("settings.connectors.addAndLogin")
                : t("settings.connectors.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <ServiceLogo entry={entry} name={entry.name} size={36} />
          <div className="min-w-0 flex-1 text-[13px] leading-[1.45] text-tx3">
            {t(descKey(entry))}
          </div>
        </div>
        {entry.auth === "token" ? (
          <>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={t("settings.connectors.tokenLabel")}
              onKeyDown={onEnter}
              className={`${INPUT} font-mono text-[12px]`}
            />
            <span className="text-[12px] leading-[1.45] text-tx3">
              {entry.tokenOptional
                ? t("settings.connectors.tokenOptionalHint")
                : t("settings.connectors.tokenRequiredHint")}
            </span>
          </>
        ) : null}
        {needsClient && sibling ? (
          <Checkbox
            checked={useSibling}
            onChange={setUseSibling}
            className="text-[12px] text-tx2"
            label={t("settings.connectors.useExistingClient", { name: sibling.name })}
          />
        ) : null}
        {needsClient && !copyClient ? (
          <>
            <p className="text-[12px] leading-[1.45] text-tx3">
              {t("settings.connectors.ownClientHelp")}
            </p>
            <div className="flex items-center gap-2 text-[12px]">
              <span className="shrink-0 text-tx2">{t("settings.connectors.redirectUri")}</span>
              <span className="min-w-0 flex-1 break-all font-mono text-[11px] text-tx">
                {OWN_CLIENT_REDIRECT_URI}
              </span>
              <Button size="sm" onClick={() => copy(OWN_CLIENT_REDIRECT_URI)}>
                {copied ? t("common.copied") : t("common.copy")}
              </Button>
            </div>
            <input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder={t("settings.connectors.clientId")}
              className={`${INPUT} font-mono text-[12px]`}
            />
            <input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={t("settings.connectors.clientSecret")}
              onKeyDown={onEnter}
              className={`${INPUT} font-mono text-[12px]`}
            />
          </>
        ) : null}
      </div>
    </Modal>
  );
}

// ---------- Hazır servisler ----------

/**
 * Katalog kutucuğu. Bilgi istemeyen giriş (`oauth`, `open`, uygulamayla gelen Google istemcisi)
 * tek tıkla eklenir; `token` ve kendi istemcisi gereken Google girişleri formu açar. Eklenmiş
 * servis katalogdan düşmez, "Eklendi" yazar: liste sabit kalır, aranan servis de bulunur.
 */
function CatalogTile({
  entry,
  added,
  onForm,
  onView,
}: {
  entry: CatalogEntry;
  added: boolean;
  onForm: (entry: CatalogEntry) => void;
  onView: () => void;
}) {
  const { t } = useTranslation();
  const builtInGroups = useMcp((s) => s.builtInGroups);
  const [busy, setBusy] = useState(false);
  // Uygulamayla gelen istemci varsa kullanıcıdan kimlik istenmez; kutucuk normal OAuth gibi davranır.
  const builtIn = entry.clientGroup !== undefined && builtInGroups.includes(entry.clientGroup);
  const needsForm = entry.auth === "token" || (entry.auth === "ownClient" && !builtIn);
  const badge = CATALOG_AUTH_BADGE[builtIn ? "oauth" : entry.auth];
  const onAdd = async () => {
    if (needsForm) {
      onForm(entry);
      return;
    }
    setBusy(true);
    try {
      await addFromCatalog(entry, t, {}, { onView });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className={`flex items-start gap-3 rounded-[12px] border border-line bg-card2 p-3 transition-colors ${
        added ? "" : "hover:border-line2"
      }`}
    >
      <ServiceLogo entry={entry} name={entry.name} size={36} />
      <div className="min-w-0 flex-1">
        <div className="truncate pt-[1px] text-[13.5px] font-medium">{entry.name}</div>
        <div className="line-clamp-2 pt-[2px] text-[12px] leading-[1.4] text-tx3">
          {t(descKey(entry))}
        </div>
        {badge || entry.native ? (
          <div className="flex flex-wrap items-center gap-[6px] pt-[7px]">
            {badge ? (
              <Chip icon={badge.icon}>
                {entry.auth === "token" && entry.tokenOptional
                  ? t("settings.connectors.authTokenOptional")
                  : t(badge.key)}
              </Chip>
            ) : null}
            {entry.native ? <NativeChip /> : null}
          </div>
        ) : null}
      </div>
      {added ? (
        <Button size="sm" variant="ghost" disabled>
          <Icon name="check" size={12} />
          {t("settings.connectors.added")}
        </Button>
      ) : (
        <Button size="sm" disabled={busy} onClick={() => void onAdd()}>
          {busy ? t("settings.connectors.adding") : t("settings.connectors.save")}
        </Button>
      )}
    </div>
  );
}

// ---------- Sayfa ----------

/** Açık olup düşmüş servisleri yeniden dener; main tarafındaki debounce eşzamanlı tetikleri tekler. */
async function reconnectFailed() {
  await useMcp.getState().reconnectFailed();
}

/**
 * Servisler: ad ve adresle eklenen uzak MCP sunucuları (Claude'daki "Connectors" gibi).
 * Giriş isteyen sunucular tarayıcıda açılır; belirteçler main'de kalır, burada yalnızca durum var.
 * Yönetim ve keşif ayrı sekmelerde: bağlı liste (özellikle Google ailesi) uzayınca katalog ekranın
 * altına itiliyordu. Kategori sekmeleri ve arama yalnız kataloğu süzer.
 */
export function ConnectorsPage() {
  const { t } = useTranslation();
  const connectors = useMcp((s) => s.connectors);
  const loaded = useMcp((s) => s.loaded);
  const load = useMcp((s) => s.load);
  // Açılış sekmesi yükleme bitince bir kez seçilir: bağlı servis yoksa katalog. Sonra sabit kalır,
  // ilk servis eklenince kullanıcı katalogdan koparılmaz.
  const [tab, setTab] = useState<PageTab | null>(() =>
    loaded ? (connectors.length > 0 ? "connected" : "catalog") : null,
  );
  const [adding, setAdding] = useState(false);
  const [formEntry, setFormEntry] = useState<CatalogEntry | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  // Erteleme bağlı araçların toplamına bakar; tek servisin sayısı eşiği aşmasa da devreye girer.
  const toolCount = connectedToolCount(connectors);
  const current: PageTab = tab ?? "connected";

  useEffect(() => {
    // Ağ koptuğunda ya da bilgisayar uyuduğunda bağlantı düşer ve kendiliğinden dönmez; sayfa
    // açılınca hatalı ve açık servisler bir kez yeniden denenir.
    void load().then(reconnectFailed);
  }, [load]);

  useEffect(() => {
    if (loaded && tab === null) setTab(connectors.length > 0 ? "connected" : "catalog");
  }, [loaded, tab, connectors.length]);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await load();
      await reconnectFailed();
    } catch (e) {
      fail(e);
    } finally {
      setRefreshing(false);
    }
  };

  const addedIds = new Set(
    CONNECTOR_CATALOG.filter((e) => connectors.some((c) => sameUrl(c.url, e.url))).map((e) => e.id),
  );
  // Katlama `searchText`ten: iki dilde de aynı eşleşme (İ/ı, I/i).
  const needle = q.trim();
  const matches = (e: CatalogEntry) => !needle || matchesFold(`${e.name} ${t(descKey(e))}`, needle);
  const groups = CATALOG_CATEGORIES.filter((cat) => filter === "all" || cat === filter)
    .map((cat) => {
      const items = CONNECTOR_CATALOG.filter((e) => e.category === cat && matches(e));
      // Eklenebilir olanlar önde; eklenmişler kategorinin sonunda "Eklendi" yazar.
      const open = items.filter((e) => !addedIds.has(e.id));
      return {
        cat,
        items: [...open, ...items.filter((e) => addedIds.has(e.id))],
        done: !open.length,
      };
    })
    .filter((g) => g.items.length > 0)
    // Tümü eklenmiş kategori (ör. Google) keşfi örtmesin diye en sona iner; sort kararlıdır.
    .sort((a, b) => Number(a.done) - Number(b.done));

  const pageTabs = [
    {
      key: "connected" as PageTab,
      label: t("settings.connectors.listTitle"),
      count: connectors.length,
    },
    {
      key: "catalog" as PageTab,
      label: t("settings.connectors.catalogTitle"),
      count: CONNECTOR_CATALOG.length,
    },
  ];
  const filterTabs = [
    { key: "all" as Filter, label: t("settings.connectors.all"), count: CONNECTOR_CATALOG.length },
    ...CATALOG_CATEGORIES.map((cat) => ({
      key: cat as Filter,
      label: t(CATEGORY_SHORT_KEYS[cat]),
      count: CONNECTOR_CATALOG.filter((e) => e.category === cat).length,
    })),
  ];

  // Aile adı katalog kategorisinden gelir; üye elle eklenmiş olsa da aynı ailedeki girişten bulunur.
  const groupName = (c: McpConnector) => {
    const entry = catalogOf(c) ?? CONNECTOR_CATALOG.find((e) => e.clientGroup === c.clientGroup);
    return entry ? t(CATEGORY_KEYS[entry.category]) : (c.clientGroup ?? c.name);
  };
  const blocks = toBlocks(connectors, groupName);

  const showConnected = () => setTab("connected");
  const browseCatalog = () => {
    setTab("catalog");
    requestAnimationFrame(() => searchRef.current?.focus());
  };

  return (
    <>
      <Toolbar>
        <SegmentedTabs value={current} items={pageTabs} onChange={setTab} />
        <div className="flex-1" />
        {current === "connected" ? (
          <IconButton
            name="loop"
            title={t("settings.connectors.refresh")}
            onClick={() => void onRefresh()}
            disabled={refreshing || !loaded}
            spin={refreshing}
          />
        ) : null}
        <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
          <Icon name="plus" size={13} />
          {t("settings.connectors.add")}
        </Button>
      </Toolbar>

      {current === "connected" ? (
        <Section>
          <AttentionBanner onRetry={() => void onRefresh()} retrying={refreshing} />
          {!loaded ? (
            <Note>{t("common.loading")}</Note>
          ) : connectors.length === 0 ? (
            <EmptyState
              title={t("settings.connectors.emptyTitle")}
              desc={t("settings.connectors.emptyDesc")}
              action={t("settings.connectors.browseCatalog")}
              onAction={browseCatalog}
            />
          ) : (
            <Card>
              {blocks.map((b, i) =>
                b.kind === "group" ? (
                  <ConnectorGroup key={b.key} name={b.name} members={b.members} first={i === 0} />
                ) : (
                  <ConnectorRow key={b.c.id} c={b.c} first={i === 0} />
                ),
              )}
            </Card>
          )}
          {loaded && connectors.length > 0 ? (
            // Liste bitince keşfe dönüş yolu: katalog ayrı sekmeye geçince sayfa burada kesiliyordu.
            <div className="flex items-center gap-3 px-[2px] text-[12.5px] text-tx3">
              <span className="inline-flex min-w-0 flex-1 items-center gap-[5px]">
                {t("settings.connectors.toolSummary", { count: toolCount })}
                {toolCount > DIRECT_TOOL_LIMIT ? (
                  <span title={t("settings.connectors.manyTools")} className="hover:text-tx2">
                    <Icon name="info" size={13} />
                  </span>
                ) : null}
              </span>
              <Button size="sm" variant="ghost" onClick={browseCatalog}>
                {t("settings.connectors.browseCatalog")}
                <Icon name="chevronRight" size={12} />
              </Button>
            </div>
          ) : null}
        </Section>
      ) : (
        <div className="flex flex-col gap-[14px]">
          <div className="text-[13px] text-tx3">{t("settings.connectors.catalogHeader")}</div>
          <Toolbar>
            <Tabs value={filter} items={filterTabs} onChange={setFilter} />
            <SearchBox
              value={q}
              onChange={setQ}
              placeholder={t("settings.connectors.catalogSearch")}
              inputRef={searchRef}
            />
          </Toolbar>
          {groups.length === 0 ? <Note>{t("settings.connectors.catalogEmpty")}</Note> : null}
          {groups.map((g) => (
            <div key={g.cat} className="flex flex-col gap-2">
              <div className="px-[2px] text-[11px] font-medium uppercase tracking-[0.06em] text-tx3">
                {t(CATEGORY_KEYS[g.cat])}
              </div>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-2">
                {g.items.map((entry) => (
                  <CatalogTile
                    key={entry.id}
                    entry={entry}
                    added={addedIds.has(entry.id)}
                    onForm={setFormEntry}
                    onView={showConnected}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {adding ? <AddServerModal onClose={() => setAdding(false)} onAdded={showConnected} /> : null}
      {formEntry ? (
        <CatalogFormModal
          entry={formEntry}
          onClose={() => setFormEntry(null)}
          onView={showConnected}
        />
      ) : null}
    </>
  );
}
