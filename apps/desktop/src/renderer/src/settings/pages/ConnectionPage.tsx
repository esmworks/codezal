import type { ApiKeySlot, ProviderInfo } from "@codezal/contracts";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke, on } from "../../api";
import { Button } from "../../components/Button";
import { matchesFold } from "../../lib/searchText";
import { slotName, useModels } from "../../stores/models";
import { quotaOf, useQuota } from "../../stores/quota";
import { humanizeError, toast } from "../../stores/toast";
import {
  Card,
  Chip,
  GroupLabel,
  ListRow,
  Note,
  SearchBox,
  Section,
  SectionHead,
  SegmentedTabs,
  Toolbar,
} from "../list";
import { QuotaBadge, QuotaPanel } from "../QuotaBadge";
import { ButtonRow, Section as FormSection, InputRow, Row, SelectRow, ToggleRow } from "../rows";
import type { Patch, S } from "./common";

// ---------- Bağlantı ----------

/**
 * Öne çıkan sağlayıcılar, gösterim sırasıyla. Pi kataloğu kırka yakın sağlayıcı taşır; kullanıcı
 * çoğunlukla bunlardan birini arar. Kalanlar "Tümü" sekmesinde ve aramada.
 */
const FEATURED: readonly string[] = [
  "anthropic",
  "openai-codex",
  "openai",
  "google",
  "github-copilot",
  "opencode-go",
  "commandcode",
  "deepseek",
  "kimi-coding",
  "xai",
  "openrouter",
  "zai",
];

type Filter = "connected" | "featured" | "all";

const INPUT_CLASS =
  "min-w-0 flex-1 rounded-[9px] border border-line2 bg-card px-[11px] py-[6px] font-mono text-[12px] text-tx outline-none placeholder:text-tx3";

function timeOf(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Sağlayıcı logosu yok; ad baş harfiyle kare döşeme. */
function ProviderTile({ name, connected }: { name: string; connected: boolean }) {
  return (
    <span
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-line text-[15px] font-semibold ${
        connected ? "bg-sel text-tx" : "bg-chip text-tx2"
      }`}
    >
      {name.trim().charAt(0).toLocaleUpperCase("tr")}
    </span>
  );
}

/** Sağlayıcının anahtar listesi: durum, Kullan ve Sil. */
function KeyList({ p }: { p: ProviderInfo }) {
  const { t } = useTranslation();
  const { removeApiKey, activateApiKey } = useModels();
  const status = (k: ApiKeySlot) =>
    k.active
      ? t("settings.connection.keyActive")
      : k.cooldownUntil !== null
        ? t("settings.connection.keyLimitedUntil", { time: timeOf(k.cooldownUntil) })
        : t("settings.connection.keyBackup");
  const dot = (k: ApiKeySlot) =>
    k.active ? "bg-green" : k.cooldownUntil !== null ? "bg-amber" : "bg-tx3";
  return (
    <ul className="flex flex-col divide-y divide-line rounded-[9px] border border-line2 bg-card">
      {p.keys.map((k) => (
        <li key={k.id} className="flex items-center gap-2 px-[11px] py-[5px] text-[12px]">
          <span className={`h-2 w-2 shrink-0 rounded-full ${dot(k)}`} />
          <span className="text-tx">{slotName(k, p.keys)}</span>
          {k.kind === "command" && k.reference ? (
            <span
              className="max-w-[200px] truncate rounded-full border border-line2 bg-chip px-[7px] py-[1px] font-mono text-[10px] text-tx2"
              title={k.reference}
            >
              {k.reference}
            </span>
          ) : k.kind === "env" && k.reference ? (
            <span className="font-mono text-tx3" title={k.reference}>
              {k.reference}
            </span>
          ) : k.hint ? (
            <span className="font-mono text-tx3">····{k.hint}</span>
          ) : null}
          {k.envMissing ? (
            <span className="text-[11px] text-amber">{t("settings.connection.envMissing")}</span>
          ) : null}
          <span className="text-tx3">{status(k)}</span>
          <span className="flex-1" />
          {k.type === "api_key" && !k.active ? (
            <Button variant="ghost" size="sm" onClick={() => void activateApiKey(p.id, k.id)}>
              {t("settings.connection.use")}
            </Button>
          ) : null}
          {k.type === "api_key" ? (
            <Button variant="ghost" size="sm" onClick={() => void removeApiKey(p.id, k.id)}>
              {t("settings.connection.remove")}
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function ProviderRow({ p, first }: { p: ProviderInfo; first: boolean }) {
  const { t } = useTranslation();
  const { load, setApiKey, logout } = useModels();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [waitingCode, setWaitingCode] = useState(false);
  const quota = useQuota((s) => quotaOf(s.items, p.id));
  const quotaBusy = useQuota((s) => s.loading);
  const refreshQuota = useQuota((s) => s.refresh);
  const [quotaOpen, setQuotaOpen] = useState(false);

  const hasApiKey = p.authKinds.includes("api_key");
  const hasOAuth = p.authKinds.includes("oauth");

  // Satır açıklaması: bağlıysa anahtar özeti, değilse nasıl bağlanılacağı.
  const desc = (): string => {
    if (p.connected) {
      if (p.keys.length === 0) return t("settings.connection.viaOAuthConnected");
      const active = p.keys.find((k) => k.active);
      const parts: string[] = [t("settings.connection.keyCount", { count: p.keys.length })];
      if (active?.kind === "command") parts.push(t("settings.connection.kindCommand"));
      else if (active?.kind === "env") parts.push(t("settings.connection.kindEnv"));
      else if (active?.hint) parts.push(`····${active.hint}`);
      else if (active?.type === "oauth") parts.push(t("settings.connection.viaOAuthConnected"));
      return parts.join(" · ");
    }
    if (hasApiKey && hasOAuth) return t("settings.connection.authBoth");
    if (hasOAuth) return t("settings.connection.authOAuth");
    return t("settings.connection.authApiKey");
  };

  useEffect(() => {
    if (open) void invoke("models:keyHint", { provider: p.id }).then(setHint);
  }, [open, p.id]);

  useEffect(
    () =>
      on("oauth:progress", (ev) => {
        if (ev.provider !== p.id) return;
        if (ev.kind === "done") {
          setBusy(false);
          setWaitingCode(false);
          setMsg(t("settings.connection.connected"));
          void load();
        } else if (ev.kind === "error") {
          setBusy(false);
          setWaitingCode(false);
          setMsg(ev.text);
        } else if (ev.kind === "code")
          setMsg(t("settings.connection.deviceCode", { code: ev.text }));
        else if (ev.kind === "url") setWaitingCode(true);
        else if (ev.kind === "message") setMsg(ev.text);
      }),
    [p.id, load, t],
  );

  const saveKey = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await setApiKey(p.id, key.trim(), label.trim() || undefined);
      setKey("");
      setLabel("");
      // Referans çözülemediyse kayıt başarılı olur ama sağlayıcı bağlanmaz; mesaj gerçeği söylesin.
      const refreshed = useModels.getState().providers.find((x) => x.id === p.id);
      setMsg(
        refreshed?.connected
          ? t("settings.connection.connected")
          : t("settings.connection.savedNotConnected"),
      );
      // Anahtar yeni eklendiyse kota rozeti eski ("bağlı değil") durumda kalmasın.
      if (refreshed?.connected) void refreshQuota(p.id, true);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  // Tarayıcı girişi paneli açmadan başlar; ilerleme ve kod alanı panelde görünür.
  const oauth = async () => {
    setOpen(true);
    setBusy(true);
    setMsg(t("settings.connection.browserOpening"));
    try {
      await invoke("models:oauthLogin", { provider: p.id });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  const cancelOAuth = () =>
    void invoke("models:oauthCancel", { provider: p.id }).then(() => {
      setBusy(false);
      setWaitingCode(false);
      setMsg(null);
    });
  const doLogout = async () => {
    await logout(p.id);
    setMsg(null);
    setOpen(false);
  };

  const actions = p.connected ? (
    <Button variant="secondary" size="sm" onClick={() => setOpen(!open)}>
      {t("settings.connection.manage")}
    </Button>
  ) : (
    <>
      {hasOAuth ? (
        <Button
          variant={hasApiKey ? "secondary" : "primary"}
          size="sm"
          disabled={busy}
          onClick={() => void oauth()}
        >
          {busy ? t("settings.connection.waiting") : t("settings.connection.browserLogin")}
        </Button>
      ) : null}
      {hasApiKey ? (
        <Button variant="primary" size="sm" onClick={() => setOpen(!open)}>
          {t("settings.connection.connect")}
        </Button>
      ) : null}
    </>
  );

  return (
    <ListRow
      first={first}
      logo={<ProviderTile name={p.name} connected={p.connected} />}
      title={
        <>
          <span className="truncate">{p.name}</span>
          <Chip dot={p.connected ? "bg-green" : "bg-tx3"}>
            {p.connected
              ? t("settings.connection.statusConnected")
              : t("settings.connection.statusNotConnected")}
          </Chip>
          {p.connected ? (
            <span className="text-[12px] font-normal text-tx3">
              {t("settings.connection.modelCount", { count: p.modelCount })}
            </span>
          ) : null}
          {p.connected ? (
            <QuotaBadge quota={quota} open={quotaOpen} onToggle={() => setQuotaOpen(!quotaOpen)} />
          ) : null}
        </>
      }
      desc={desc()}
      actions={actions}
    >
      {open ? (
        <div className="mt-3 flex flex-col gap-2 rounded-[10px] border border-line bg-bg px-[14px] py-3">
          {p.keys.length > 0 ? <KeyList p={p} /> : null}
          {hasApiKey ? (
            <div className="flex items-center gap-2">
              {p.keys.length > 0 ? (
                <input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder={t("settings.connection.labelPlaceholder")}
                  className={`${INPUT_CLASS} max-w-[160px]`}
                />
              ) : null}
              <input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={hint ?? t("settings.connection.apiKeyPlaceholder")}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && key.trim()) void saveKey();
                }}
                className={INPUT_CLASS}
              />
              <Button
                variant="primary"
                size="sm"
                disabled={!key.trim() || busy}
                onClick={() => void saveKey()}
              >
                {p.keys.length > 0 ? t("settings.connection.addKey") : t("common.save")}
              </Button>
            </div>
          ) : null}
          {hasApiKey ? (
            <p className="text-[11px] text-tx3">{t("settings.connection.referenceNote")}</p>
          ) : null}
          {waitingCode ? (
            <div className="flex items-center gap-2">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={t("settings.connection.codePlaceholder")}
                className={INPUT_CLASS}
              />
              <Button
                variant="secondary"
                size="sm"
                disabled={!code.trim()}
                onClick={() =>
                  void invoke("models:oauthCode", { provider: p.id, code }).then(() => setCode(""))
                }
              >
                {t("settings.connection.submit")}
              </Button>
            </div>
          ) : null}
          <div className="flex items-center gap-2">
            {hasOAuth && p.connected ? (
              <Button
                variant="secondary"
                size="sm"
                className="shrink-0"
                disabled={busy}
                onClick={() => void oauth()}
              >
                {busy ? t("settings.connection.waiting") : t("settings.connection.browserLogin")}
              </Button>
            ) : null}
            {busy && hasOAuth ? (
              <Button variant="ghost" size="sm" className="shrink-0" onClick={cancelOAuth}>
                {t("common.cancel")}
              </Button>
            ) : null}
            {p.connected ? (
              <Button
                variant="danger"
                size="sm"
                className="shrink-0"
                onClick={() => void doLogout()}
              >
                {p.keys.length > 1
                  ? t("settings.connection.removeAll")
                  : t("settings.connection.logout")}
              </Button>
            ) : null}
            <span className="min-w-0 flex-1 text-right text-[12px] text-tx3">
              {t("settings.connection.keyStorageNote")}
            </span>
          </div>
          {msg ? <div className="text-[12px] text-tx2">{msg}</div> : null}
        </div>
      ) : null}
      {quotaOpen && p.connected ? (
        <QuotaPanel
          quota={quota}
          busy={quotaBusy}
          onRefresh={() => void refreshQuota(p.id, true)}
        />
      ) : null}
    </ListRow>
  );
}

/**
 * Brave Search API anahtarı. Değer main'e gider ve bir daha geri gelmez; satır yalnız "Bağlı"
 * durumunu bilir. Bağlıyken alan gizlenir, Kaldır ile yeni anahtar girilebilir.
 */
function BraveKeyRow() {
  const { t } = useTranslation();
  const [connected, setConnected] = useState<boolean | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void invoke("search:braveKey", undefined)
      .then((r) => setConnected(r.connected))
      .catch(() => setConnected(false));
  }, []);
  const run = async (action: () => Promise<{ connected: boolean }>) => {
    setBusy(true);
    try {
      setConnected((await action()).connected);
      setKey("");
    } catch (error) {
      toast.error(humanizeError(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Row
      label={t("settings.connection.braveKeyLabel")}
      desc={t("settings.connection.braveKeyDesc")}
    >
      {connected ? (
        <div className="flex shrink-0 items-center gap-2">
          <span className="flex items-center gap-[6px] text-[13px] text-tx2">
            <span className="h-2 w-2 rounded-full bg-green" />
            {t("settings.connection.braveKeyConnected")}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void run(() => invoke("search:clearBraveKey", undefined))}
          >
            {t("settings.connection.braveKeyRemove")}
          </Button>
        </div>
      ) : (
        <div className="flex w-[260px] shrink-0 items-center gap-2">
          <input
            type="password"
            value={key}
            placeholder={t("settings.connection.braveKeyPlaceholder")}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && key.trim())
                void run(() => invoke("search:setBraveKey", { apiKey: key }));
            }}
            spellCheck={false}
            autoComplete="off"
            className={INPUT_CLASS}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || connected === null || !key.trim()}
            onClick={() => void run(() => invoke("search:setBraveKey", { apiKey: key }))}
          >
            {t("settings.connection.braveKeySave")}
          </Button>
        </div>
      )}
    </Row>
  );
}

export function ConnectionPage({ s, patch }: { s: S; patch: Patch }) {
  const { t } = useTranslation();
  const { providers, loading, load, refresh, refreshing } = useModels();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Filter | null>(null);
  const loadQuota = useQuota((s) => s.load);
  const refreshQuota = useQuota((s) => s.refresh);
  useEffect(() => {
    void load();
  }, [load]);
  // Sayfa açılışında kota bir kez tazelenir; ana süreç 60 sn önbelleği tuttuğu için
  // sayfayı kısa aralıkla yeniden açmak ağa tekrar çıkmaz.
  useEffect(() => {
    void loadQuota();
    void refreshQuota();
  }, [loadQuota, refreshQuota]);

  const connected = providers.filter((p) => p.connected);
  const featured = FEATURED.flatMap((id) => providers.filter((p) => p.id === id));
  // Seçim yapılmadıysa bağlı sağlayıcı varsa onlar, yoksa öne çıkanlar açılır.
  const filter: Filter = picked ?? (connected.length > 0 ? "connected" : "featured");
  // Katlama `searchText`ten: Türkçe küçültme "OpenAI"yi `openaı` yapıp `openai`yi kaçırıyordu.
  const needle = q.trim();
  const byName = (a: ProviderInfo, b: ProviderInfo) => a.name.localeCompare(b.name);

  // Arama sekmeyi geçersiz kılar: tüm sağlayıcılarda arar, bağlı olanlar üstte.
  const searched = needle
    ? providers
        .filter((p) => matchesFold(p.name, needle))
        .sort((a, b) => Number(b.connected) - Number(a.connected) || byName(a, b))
    : null;

  const tabs = [
    {
      key: "connected" as Filter,
      label: t("settings.connection.tabConnected"),
      count: connected.length,
    },
    {
      key: "featured" as Filter,
      label: t("settings.connection.tabFeatured"),
      count: featured.length,
    },
    { key: "all" as Filter, label: t("settings.connection.tabAll"), count: providers.length },
  ];

  let body: ReactNode;
  if (loading && providers.length === 0) body = <Note>{t("common.loading")}</Note>;
  else if (searched) {
    body =
      searched.length === 0 ? (
        <Note>{t("settings.connection.noMatch")}</Note>
      ) : (
        <Card>
          {searched.map((p, i) => (
            <ProviderRow key={p.id} p={p} first={i === 0} />
          ))}
        </Card>
      );
  } else if (filter === "connected") {
    body =
      connected.length === 0 ? (
        <Note>{t("settings.connection.noneConnected")}</Note>
      ) : (
        <Card>
          {connected.sort(byName).map((p, i) => (
            <ProviderRow key={p.id} p={p} first={i === 0} />
          ))}
        </Card>
      );
  } else if (filter === "featured") {
    body = (
      <Card>
        {featured.map((p, i) => (
          <ProviderRow key={p.id} p={p} first={i === 0} />
        ))}
      </Card>
    );
  } else {
    const featuredIds = new Set(FEATURED);
    const rest = providers.filter((p) => !featuredIds.has(p.id)).sort(byName);
    body = (
      <Card>
        <GroupLabel label={t("settings.connection.tabFeatured")} first />
        {featured.map((p) => (
          <ProviderRow key={p.id} p={p} first={false} />
        ))}
        <GroupLabel label={t("settings.connection.groupOthers")} first={false} />
        {rest.map((p) => (
          <ProviderRow key={p.id} p={p} first={false} />
        ))}
      </Card>
    );
  }

  return (
    <>
      <Toolbar>
        <SegmentedTabs value={filter} items={tabs} onChange={setPicked} />
        <span className="flex-1" />
        <SearchBox
          value={q}
          onChange={setQ}
          placeholder={t("settings.connection.providerSearch")}
        />
      </Toolbar>

      <Section>
        <SectionHead
          title={t("settings.connection.providersTitle")}
          {...(searched ? { count: searched.length } : {})}
          desc={t("settings.connection.providersDesc")}
        />
        {body}
      </Section>

      <FormSection title={t("settings.connection.keysTitle")}>
        <SelectRow
          first
          label={t("settings.connection.cooldownLabel")}
          desc={t("settings.connection.cooldownDesc")}
          value={s.keyCooldownHours}
          options={["1", "3", "5", "24"].map((hours) => ({
            value: hours as S["keyCooldownHours"],
            label: t("settings.connection.cooldownOpt", { hours }),
          }))}
          onChange={(v) => patch({ keyCooldownHours: v })}
        />
        <ButtonRow
          label={t("settings.connection.authFileLabel")}
          desc={t("settings.connection.authFileDesc")}
          value={t("settings.connection.openAuthJson")}
          onClick={() => void invoke("settings:openFile", { which: "auth" })}
        />
      </FormSection>

      <FormSection title={t("settings.connection.catalogTitle")}>
        <ButtonRow
          first
          label={t("settings.connection.catalogLabel")}
          desc={t("settings.connection.catalogDesc")}
          value={
            refreshing
              ? t("settings.connection.catalogRefreshing")
              : t("settings.connection.catalogAction")
          }
          disabled={refreshing}
          onClick={() => void refresh()}
        />
        <ButtonRow
          label={t("settings.connection.manageModelsLabel")}
          desc={t("settings.connection.manageModelsDesc")}
          value={t("settings.connection.openModelsJson")}
          onClick={() => void invoke("settings:openFile", { which: "models" })}
          extra={
            <Button variant="ghost" size="sm" onClick={() => void load()}>
              {t("settings.connection.reload")}
            </Button>
          }
        />
      </FormSection>

      <FormSection title={t("settings.connection.networkTitle")}>
        <ToggleRow
          first
          label={t("settings.connection.proxyLabel")}
          desc={t("settings.connection.proxyDesc")}
          on={s.proxy}
          onChange={(v) => patch({ proxy: v })}
        />
        {s.proxy ? (
          <InputRow
            label={t("settings.connection.proxyUrlLabel")}
            value={s.proxyUrl}
            onChange={(v) => patch({ proxyUrl: v })}
            placeholder="http://127.0.0.1:7890"
            mono
          />
        ) : null}
        {s.proxy ? (
          <InputRow
            label={t("settings.connection.noProxyLabel")}
            desc={t("settings.connection.noProxyDesc")}
            value={s.noProxy}
            onChange={(v) => patch({ noProxy: v })}
            placeholder={t("settings.connection.noProxyPlaceholder")}
            mono
          />
        ) : null}
        <InputRow
          label={t("settings.connection.caCertLabel")}
          desc={t("settings.connection.caCertDesc")}
          value={s.caCertPath}
          onChange={(v) => patch({ caCertPath: v })}
          placeholder={t("settings.connection.caCertPlaceholder")}
          mono
        />
        <SelectRow
          label={t("settings.connection.timeoutLabel")}
          value={s.timeoutSec}
          options={["30", "60", "120", "300"].map((sec) => ({
            value: sec as S["timeoutSec"],
            label: t("settings.connection.timeoutOpt", { sec }),
          }))}
          onChange={(v) => patch({ timeoutSec: v })}
        />
      </FormSection>

      <FormSection title={t("settings.connection.webSearchTitle")}>
        <SelectRow
          first
          label={t("settings.connection.webSearchLabel")}
          desc={t("settings.connection.webSearchDesc")}
          value={s.webSearchProvider}
          options={[
            { value: "auto", label: t("settings.connection.webSearchAuto") },
            { value: "duckduckgo", label: t("settings.connection.webSearchDuckDuckGo") },
            { value: "searxng", label: t("settings.connection.webSearchSearxng") },
            { value: "brave", label: t("settings.connection.webSearchBrave") },
          ]}
          onChange={(v) => patch({ webSearchProvider: v })}
        />
        {s.webSearchProvider === "searxng" ? (
          <InputRow
            label={t("settings.connection.searxngUrlLabel")}
            desc={t("settings.connection.searxngUrlDesc")}
            value={s.searxngUrl}
            onChange={(v) => patch({ searxngUrl: v })}
            placeholder="https://searx.example.org"
            mono
          />
        ) : null}
        {s.webSearchProvider === "brave" ? <BraveKeyRow /> : null}
      </FormSection>
    </>
  );
}
