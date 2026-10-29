import type {
  AgentColor,
  AgentDraft,
  AgentInfo,
  AgentIsolation,
  ModelRef,
} from "@codezal/contracts";
import type { TranslationKey } from "@codezal/i18n";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/Button";
import { Checkbox } from "../../components/Checkbox";
import { askConfirm } from "../../components/Confirm";
import { Icon } from "../../components/Icon";
import { Modal } from "../../components/Modal";
import type { SelectOption } from "../../components/Select";
import { Select } from "../../components/Select";
import { Toggle } from "../../components/Toggle";
import { matchesFold } from "../../lib/searchText";
import { useAgentProfiles } from "../../stores/agentProfiles";
import { useModels } from "../../stores/models";
import { useCurrentProject } from "../../stores/projects";
import { humanizeError, toast } from "../../stores/toast";
import {
  Card,
  Chip,
  EmptyState,
  IconButton,
  IconTile,
  ListRow,
  Note,
  SearchBox,
  Section,
  SectionHead,
  Toolbar,
} from "../list";
import { Row } from "../rows";
import type { Patch, S } from "./common";

// ---------- Ajanlar: kullanıcı tanımlı alt ajanlar ----------

/**
 * Rozet renkleri. Palet tasarım token'larında olmadığı için satır içi stil ile verilir; renk
 * yalnızca listede ayırt edicilik için kullanılır, işlevsel bir anlamı yoktur.
 */
const COLOR_HEX: Record<AgentColor, string> = {
  red: "#e0726a",
  blue: "#6a9fe0",
  green: "#62b479",
  yellow: "#c9a86a",
  purple: "#a98ad6",
  orange: "#d98d5e",
  pink: "#d67fa8",
  cyan: "#5fb8c4",
};
const COLOR_KEYS = Object.keys(COLOR_HEX) as AgentColor[];

/**
 * Formda seçilebilen araçlar: alt oturumda gerçekten kayıtlı olan küme (motor `SUBAGENT_TOOLS`
 * ile aynı). Elle yazılmış dosyadaki başka araç adları formda korunur, sessizce silinmez.
 */
const TOOL_CHOICES = [
  "read",
  "grep",
  "find",
  "ls",
  "edit",
  "write",
  "bash",
  "web_search",
  "web_fetch",
] as const;

/** Gömülü ajanların arayüz adları; dosya adları (`general`, `explore`) modele gider. */
function builtInLabel(name: string, t: (key: TranslationKey) => string): string {
  if (name === "general") return t("settings.agents.builtInGeneral");
  if (name === "explore") return t("settings.agents.builtInExplore");
  return name;
}

function ColorDot({ color }: { color: AgentColor | null }) {
  if (!color) return null;
  return (
    <span
      aria-hidden
      className="h-[8px] w-[8px] shrink-0 rounded-full"
      style={{ background: COLOR_HEX[color] }}
    />
  );
}

/** Satır rozetleri: kapsam, model, araç kapsamı ve durum. */
/** Araç rozeti: satır adının yanında durur ("Tüm araçlar" / "{{count}} araç"). */
function ToolsBadge({ agent }: { agent: AgentInfo }) {
  const { t } = useTranslation();
  const tools = agent.tools ?? [];
  return (
    <Chip icon="list">
      {tools.length === 0
        ? t("settings.agents.toolsAll")
        : t("settings.agents.toolsCount", { count: tools.length })}
    </Chip>
  );
}

/**
 * Gömülü ajanın model seçicisi. Gömülü tanım kodda olduğu ve düzenlenemediği için modeli
 * yalnızca buradan değiştirilebilir; boş seçim ana oturumun modelini devralır.
 */
function ModelOverride({
  agent,
  onChange,
}: {
  agent: AgentInfo;
  onChange: (model: ModelRef | null) => void;
}) {
  const { t } = useTranslation();
  const catalog = useModels((s) => s.catalog);
  return (
    <Select
      size="sm"
      mono
      width={200}
      minMenuWidth={260}
      value={agent.model ? `${agent.model.provider}/${agent.model.id}` : ""}
      placeholder={t("settings.agents.inheritModel")}
      options={[
        { value: "", label: t("settings.agents.inheritModel") },
        ...catalog
          .filter((m) => m.available)
          .map((m) => ({ value: `${m.provider}/${m.id}`, label: `${m.provider}/${m.id}` })),
      ]}
      onChange={(value) => {
        if (!value) {
          onChange(null);
          return;
        }
        const [provider, ...rest] = value.split("/");
        onChange({ provider: provider ?? "", id: rest.join("/") });
      }}
    />
  );
}

/**
 * Satır alt bilgisi: kapsam rozeti, dosya ajanında model adı, kapalı işareti. Gömülü ve açık bir
 * ajanın gösterilecek ek bilgisi yoktur (model zaten satırdaki seçicide durur).
 */
function AgentMeta({ agent }: { agent: AgentInfo }) {
  const { t } = useTranslation();
  const fileAgent = agent.scope !== "built-in";
  const scope =
    agent.scope === "project" ? t("settings.agents.projectChip") : t("settings.agents.userChip");
  return (
    <span className="flex min-w-0 items-center gap-2">
      {fileAgent ? <Chip>{scope}</Chip> : null}
      {fileAgent && agent.model ? (
        <span className="truncate font-mono text-[11px] text-tx3">
          {agent.model.provider}/{agent.model.id}
        </span>
      ) : null}
      {agent.isolation === "worktree" ? <Chip>{t("settings.agents.worktreeChip")}</Chip> : null}
      {agent.background ? <Chip>{t("settings.agents.backgroundChip")}</Chip> : null}
      {agent.enabled ? null : (
        <Chip title={t("settings.agents.disabledChip")}>{t("settings.agents.disabledChip")}</Chip>
      )}
    </span>
  );
}

/** Tek ajan satırı; gömülü ajanlar salt okunur (yalnızca dosyası gösterilir ve kapatılamaz). */
function AgentRow({
  agent,
  first,
  onEdit,
  onDelete,
  onToggle,
  onReveal,
  onModelOverride,
}: {
  agent: AgentInfo;
  first: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: (enabled: boolean) => void;
  onReveal: () => void;
  onModelOverride: (model: ModelRef | null) => void;
}) {
  const { t } = useTranslation();
  const builtIn = agent.scope === "built-in";
  return (
    <ListRow
      first={first}
      dim={!agent.enabled}
      logo={<IconTile name="user" />}
      title={
        <>
          <ColorDot color={agent.color} />
          <span className="truncate">{builtIn ? builtInLabel(agent.name, t) : agent.name}</span>
          <ToolsBadge agent={agent} />
          {/* Gömülü ajanda ad okunur etikete ek olarak yazılır: model `subagent_type` alanında
              dosya adını ("general", "explore") bekler. */}
          {builtIn ? (
            <span className="truncate font-mono text-[12px] font-normal text-tx3">
              {agent.name}
            </span>
          ) : null}
        </>
      }
      desc={<span title={agent.description}>{agent.description}</span>}
      meta={<AgentMeta agent={agent} />}
      actions={
        builtIn ? (
          <ModelOverride agent={agent} onChange={onModelOverride} />
        ) : (
          <>
            <IconButton name="edit" title={t("settings.agents.edit")} onClick={onEdit} />
            <IconButton name="folder" title={t("settings.agents.openFolder")} onClick={onReveal} />
            <Toggle on={agent.enabled} onChange={onToggle} />
            <IconButton name="trash" danger title={t("common.delete")} onClick={onDelete} />
          </>
        )
      }
    />
  );
}

/** Form satırındaki metin kutusu; ayar satırlarının ölçüsüyle aynı. */
function TextField({
  value,
  onChange,
  placeholder,
  mono,
  width = 300,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  width?: number;
}) {
  return (
    <input
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
      style={{ width }}
      className={`shrink-0 rounded-[9px] border border-line2 bg-card px-[11px] py-[6px] text-[13px] text-tx outline-none placeholder:text-tx3 ${mono ? "font-mono text-[12px]" : ""}`}
    />
  );
}

/** Formdaki metin kutuları tek satırlık girişle aynı zemin ve çerçeveyi taşır. */
const TEXTAREA =
  "block w-full resize-y rounded-[9px] border border-line2 bg-card py-[8px] pl-[11px] text-tx outline-none placeholder:text-tx3";

/** Başlık ve açıklama üstte, geniş alan altta: `Row`'un yan yana düzeni metin kutusuna dar geliyor. */
function FieldRow({
  label,
  desc,
  children,
}: {
  label: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-t border-line px-[18px] pt-[14px] pb-[16px]">
      <div className="text-[14px] font-medium">{label}</div>
      <div className="pt-[2px] pb-[10px] text-[13px] leading-[1.45] text-tx3">{desc}</div>
      {children}
    </div>
  );
}

/**
 * Sürüklenerek büyüyen metin alanı; köşedeki düğme aynı değeri geniş bir pencerede açar. Uzun
 * sistem istemi dar kartta yazılamıyordu.
 */
function ExpandableText({
  value,
  onChange,
  placeholder,
  title,
  mono,
  minHeight,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  title: string;
  mono?: boolean;
  minHeight: number;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const large = useRef<HTMLTextAreaElement>(null);
  // Modal açılışta odağı karta alır; bu efekt ondan sonra çalışıp imleci metnin sonuna koyar.
  useEffect(() => {
    const el = large.current;
    if (!expanded || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [expanded]);
  const font = mono ? "font-mono text-[12.5px] leading-[1.6]" : "text-[13px] leading-[1.55]";
  return (
    <div className="relative">
      <textarea
        value={value}
        spellCheck={false}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{ minHeight }}
        className={`${TEXTAREA} pr-[40px] ${font}`}
      />
      <button
        type="button"
        onClick={() => setExpanded(true)}
        title={t("settings.agents.form.expand")}
        aria-label={t("settings.agents.form.expand")}
        className="absolute top-[5px] right-[5px] flex h-[26px] w-[26px] items-center justify-center rounded-[7px] text-tx3 hover:bg-hov hover:text-tx"
      >
        <Icon name="expand" size={13} />
      </button>
      {expanded ? (
        <Modal
          title={title}
          width={1040}
          onClose={() => setExpanded(false)}
          footer={
            <>
              <span className="flex-1" />
              <Button size="sm" variant="primary" onClick={() => setExpanded(false)}>
                {t("common.ok")}
              </Button>
            </>
          }
        >
          <textarea
            ref={large}
            value={value}
            spellCheck={false}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
            className={`block h-[68vh] w-full resize-none rounded-[10px] border border-line2 bg-card2 px-[16px] py-[14px] text-tx outline-none placeholder:text-tx3 ${font}`}
          />
        </Modal>
      ) : null}
    </div>
  );
}

interface FormState {
  name: string;
  description: string;
  scope: "user" | "project";
  color: AgentColor | null;
  model: string;
  thinking: string;
  toolsAll: boolean;
  tools: string[];
  injectAgentsMd: boolean;
  isolation: AgentIsolation;
  background: boolean;
  systemPrompt: string;
}

function emptyForm(scope: "user" | "project"): FormState {
  return {
    name: "",
    description: "",
    scope,
    color: null,
    model: "",
    thinking: "",
    toolsAll: true,
    tools: [],
    injectAgentsMd: true,
    isolation: "none",
    background: false,
    systemPrompt: "",
  };
}

function formOf(agent: AgentInfo): FormState {
  return {
    name: agent.name,
    description: agent.description,
    scope: agent.scope === "project" ? "project" : "user",
    color: agent.color,
    model: agent.model ? `${agent.model.provider}/${agent.model.id}` : "",
    thinking: agent.thinking ?? "",
    toolsAll: !agent.tools || agent.tools.length === 0,
    tools: agent.tools ?? [],
    injectAgentsMd: agent.injectAgentsMd,
    isolation: agent.isolation,
    background: agent.background,
    systemPrompt: agent.systemPrompt,
  };
}

/** Formdaki düşünme seviyesi metnini sözleşme tipine çevirir; boş "devral" demektir. */
function thinkingLevelOf(value: string): AgentDraft["thinking"] {
  return value === "low" || value === "high" || value === "max" ? value : null;
}

/** Tanımdaki seçenek listesinde olmayan araçlar: formda korunur, kullanıcıya gösterilir. */
function extraTools(agent: AgentInfo | null): string[] {
  if (!agent?.tools) return [];
  const known = new Set<string>(TOOL_CHOICES);
  return agent.tools.filter((t) => !known.has(t));
}

/**
 * Ajan düzenleyici. Kapsam yalnızca yeni ajanda seçilir: var olanın dosyası hangi klasörde
 * duruyorsa orada kalır (taşıma sessizce yapılmaz).
 */
function AgentForm({
  agent,
  projectName,
  saving,
  onSave,
  onCancel,
  onDelete,
}: {
  agent: AgentInfo | null;
  /** Açık projenin adı: proje kapsamı yalnızca proje açıkken seçilebilir. */
  projectName: string | null;
  saving: boolean;
  onSave: (draft: AgentDraft) => void;
  onCancel: () => void;
  onDelete: (() => void) | null;
}) {
  const { t } = useTranslation();
  // Yeni ajan varsayılanı kullanıcı kapsamıdır: proje klasörüne yazılan tanım commit'lenip
  // ekiple paylaşılır, bu bilinçli bir seçim olmalı (kapsam alanı formda duruyor).
  const [form, setForm] = useState<FormState>(() => (agent ? formOf(agent) : emptyForm("user")));
  const catalog = useModels((s) => s.catalog);
  const patch = (next: Partial<FormState>) => setForm((prev) => ({ ...prev, ...next }));
  const tools = [...TOOL_CHOICES, ...extraTools(agent)];

  const modelOptions: SelectOption<string>[] = [
    { value: "", label: t("settings.agents.modelInherit") },
    ...catalog
      .filter((m) => m.available)
      .map((m) => ({ value: `${m.provider}/${m.id}`, label: `${m.provider}/${m.id}` })),
  ];
  const thinkingOptions: SelectOption<string>[] = [
    { value: "", label: t("settings.agents.form.thinkingInherit") },
    { value: "low", label: "low" },
    { value: "high", label: "high" },
    { value: "max", label: "max" },
  ];

  const submit = () => {
    const [provider, ...rest] = form.model.split("/");
    const draft: AgentDraft = {
      scope: form.scope,
      name: form.name.trim(),
      description: form.description.trim(),
      systemPrompt: form.systemPrompt,
      color: form.color,
      model: form.model ? { provider: provider ?? "", id: rest.join("/") } : null,
      thinking: thinkingLevelOf(form.thinking),
      tools: form.toolsAll ? null : form.tools,
      disallowedTools: agent?.disallowedTools ?? [],
      injectAgentsMd: form.injectAgentsMd,
      isolation: form.isolation,
      background: form.background,
    };
    onSave(draft);
  };

  return (
    <>
      <Toolbar>
        <Button size="sm" onClick={onCancel}>
          <Icon name="chevronLeft" size={13} />
          {t("settings.agents.form.back")}
        </Button>
        <span className="text-[13px] text-tx3">
          {agent ? t("settings.agents.form.editTitle") : t("settings.agents.form.newTitle")}
        </span>
        <span className="flex-1" />
        {onDelete ? (
          <Button size="sm" variant="ghost" onClick={onDelete} disabled={saving}>
            <Icon name="trash" size={13} />
            {t("common.delete")}
          </Button>
        ) : null}
        <Button size="sm" variant="primary" onClick={submit} disabled={saving}>
          {saving ? t("settings.agents.form.saving") : t("settings.agents.form.save")}
        </Button>
      </Toolbar>

      <Section>
        <Card>
          <Row
            label={t("settings.agents.form.name")}
            desc={t("settings.agents.form.nameDesc")}
            first
          >
            <TextField
              mono
              value={form.name}
              placeholder={t("settings.agents.form.namePlaceholder")}
              onChange={(name) => patch({ name })}
            />
          </Row>
          <FieldRow
            label={t("settings.agents.form.description")}
            desc={t("settings.agents.form.descriptionDesc")}
          >
            {/* Açıklama kısa tutulur; genişletme yalnız sistem isteminde var. */}
            <textarea
              value={form.description}
              spellCheck={false}
              placeholder={t("settings.agents.form.descriptionPlaceholder")}
              onChange={(e) => patch({ description: e.target.value })}
              rows={3}
              className={`${TEXTAREA} pr-[11px] text-[13px] leading-[1.55]`}
            />
          </FieldRow>
          <FieldRow
            label={t("settings.agents.form.prompt")}
            desc={t("settings.agents.form.promptDesc")}
          >
            <ExpandableText
              mono
              value={form.systemPrompt}
              title={t("settings.agents.form.prompt")}
              placeholder={t("settings.agents.form.promptPlaceholder")}
              onChange={(systemPrompt) => patch({ systemPrompt })}
              minHeight={220}
            />
            {agent ? (
              <div className="pt-[8px] font-mono text-[11px] text-tx3">
                {t("settings.agents.form.pathHint", { path: agent.path })}
              </div>
            ) : null}
          </FieldRow>
          {agent === null ? (
            <Row label={t("settings.agents.form.scope")} desc={t("settings.agents.form.scopeDesc")}>
              <Select
                size="sm"
                value={form.scope}
                options={
                  // Proje kapsamı yalnızca açık proje varken seçilebilir: dosya o projeye yazılır.
                  projectName !== null
                    ? [
                        { value: "user", label: t("settings.agents.form.scopeUser") },
                        {
                          value: "project",
                          label: t("settings.agents.form.scopeProject", { name: projectName }),
                        },
                      ]
                    : [{ value: "user", label: t("settings.agents.form.scopeUser") }]
                }
                onChange={(scope) => patch({ scope })}
              />
            </Row>
          ) : null}
          <Row label={t("settings.agents.form.color")}>
            <div className="flex shrink-0 items-center gap-[6px]">
              {COLOR_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  title={key}
                  onClick={() => patch({ color: form.color === key ? null : key })}
                  className={`h-[20px] w-[20px] rounded-full border-2 ${
                    form.color === key ? "border-tx" : "border-transparent"
                  }`}
                  style={{ background: COLOR_HEX[key] }}
                />
              ))}
            </div>
          </Row>
          <Row label={t("settings.agents.form.model")} desc={t("settings.agents.form.modelDesc")}>
            <Select
              size="sm"
              mono
              width={260}
              minMenuWidth={280}
              value={form.model}
              options={modelOptions}
              onChange={(model) => patch({ model })}
            />
          </Row>
          <Row
            label={t("settings.agents.form.thinking")}
            desc={t("settings.agents.form.thinkingDesc")}
          >
            <Select
              size="sm"
              mono
              value={form.thinking}
              options={thinkingOptions}
              onChange={(thinking) => patch({ thinking })}
            />
          </Row>
          <Row label={t("settings.agents.form.tools")} desc={t("settings.agents.form.toolsDesc")}>
            <Select
              size="sm"
              value={form.toolsAll ? "all" : "custom"}
              options={[
                { value: "all", label: t("settings.agents.form.toolsAll") },
                { value: "custom", label: t("settings.agents.form.toolsCustom") },
              ]}
              onChange={(v) => patch({ toolsAll: v === "all" })}
            />
          </Row>
          {!form.toolsAll ? (
            <Row label={t("settings.agents.form.toolsCustom")}>
              <div className="flex w-[300px] shrink-0 flex-wrap justify-end gap-x-[12px] gap-y-[8px]">
                {tools.map((tool) => (
                  <Checkbox
                    key={tool}
                    checked={form.tools.includes(tool)}
                    onChange={(on) =>
                      patch({
                        tools: on
                          ? [...form.tools, tool]
                          : form.tools.filter((entry) => entry !== tool),
                      })
                    }
                    label={<span className="font-mono text-[12px]">{tool}</span>}
                  />
                ))}
              </div>
            </Row>
          ) : null}
          <Row label={t("settings.agents.form.inject")} desc={t("settings.agents.form.injectDesc")}>
            <Toggle
              on={form.injectAgentsMd}
              onChange={(injectAgentsMd) => patch({ injectAgentsMd })}
            />
          </Row>
          <Row
            label={t("settings.agents.form.isolation")}
            desc={t("settings.agents.form.isolationDesc")}
          >
            <Select
              size="sm"
              value={form.isolation}
              options={[
                { value: "none", label: t("settings.agents.form.isolationAuto") },
                { value: "worktree", label: t("settings.agents.form.isolationWorktree") },
              ]}
              onChange={(isolation) => patch({ isolation })}
            />
          </Row>
          <Row
            label={t("settings.agents.form.background")}
            desc={t("settings.agents.form.backgroundDesc")}
          >
            <Toggle on={form.background} onChange={(background) => patch({ background })} />
          </Row>
        </Card>
      </Section>
    </>
  );
}

/**
 * Ayarlar > Ajanlar. Tanımlar Markdown dosyalarıdır (üst veri + sistem istemi gövdesi); sayfa
 * bunları listeler ve düzenler, motor ise `agent` aracıyla modele sunar. Gömülü ajanlar kodda
 * durur: düzenlenemez, silinemez, kapatılamaz.
 */
/** Ajan koşularının genel ayarları: eşzamanlılık ve worktree koşularının izin modu. */
function RunSettings({ s, patch }: { s: S; patch: Patch }) {
  const { t } = useTranslation();
  const concurrency: SelectOption<string>[] = Array.from({ length: 8 }, (_, i) => ({
    value: String(i + 1),
    label: String(i + 1),
  }));
  const permissions: SelectOption<S["agentWorktreePermission"]>[] = [
    { value: "auto-edit", label: t("permissionMode.auto-edit") },
    { value: "ask", label: t("permissionMode.ask") },
    { value: "full", label: t("permissionMode.full") },
  ];
  return (
    <Section>
      <SectionHead title={t("settings.agents.runsTitle")} />
      <Card>
        <Row
          first
          label={t("settings.agents.concurrency")}
          desc={t("settings.agents.concurrencyDesc")}
        >
          <Select
            size="sm"
            value={String(s.agentConcurrency)}
            options={concurrency}
            onChange={(v) => patch({ agentConcurrency: Number(v) })}
          />
        </Row>
        <Row
          label={t("settings.agents.worktreePermission")}
          desc={t("settings.agents.worktreePermissionDesc")}
        >
          <Select
            size="sm"
            value={s.agentWorktreePermission}
            options={permissions}
            onChange={(agentWorktreePermission) => patch({ agentWorktreePermission })}
          />
        </Row>
      </Card>
    </Section>
  );
}

export function AgentsPage({ s, patch }: { s: S; patch: Patch }) {
  const { t } = useTranslation();
  const current = useCurrentProject();
  const cwd = current?.path ?? null;
  const {
    catalog,
    load,
    loading,
    busy,
    create,
    update,
    remove,
    setEnabled,
    setModelOverride,
    reveal,
  } = useAgentProfiles();
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<AgentInfo | "new" | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    void load(cwd);
  }, [load, cwd]);

  const agents = catalog?.agents ?? [];
  const diagnostics = catalog?.diagnostics ?? [];
  // Yerel ayardan bağımsız katlama: "UI" gibi kısaltmalar Türkçe küçültmede `ıı` oluyordu.
  const needle = q.trim();
  const match = (agent: AgentInfo) =>
    !needle || matchesFold(`${agent.name} ${agent.description}`, needle);
  const visible = agents.filter(match);
  const builtIn = visible.filter((a) => a.scope === "built-in");
  const mine = visible.filter((a) => a.scope === "user");
  const project = visible.filter((a) => a.scope === "project");

  const fail = (e: unknown) => toast.error(humanizeError(e));

  const save = async (draft: AgentDraft) => {
    const target = editing === "new" ? null : editing;
    try {
      if (target) await update(target.id, draft);
      else {
        await create(draft);
        toast.success(t("settings.agents.saved"));
      }
      setEditing(null);
    } catch (e) {
      fail(e);
    }
  };

  const confirmDelete = async (agent: AgentInfo) => {
    const ok = await askConfirm({
      title: t("settings.agents.deleteTitle"),
      body: t("settings.agents.deleteMessage", { name: agent.name }),
      okLabel: t("settings.agents.deleteOk"),
      danger: true,
    });
    if (!ok) return;
    try {
      await remove(agent.id);
      // Formdan silindiyse form kapanır: aksi hâlde silinmiş kaydın alanları açık kalır ve
      // "Kaydet" sunucuda bulunamayan bir kimlikle hata verir.
      setEditing(null);
    } catch (e) {
      fail(e);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      await load(cwd);
    } catch (e) {
      fail(e);
    } finally {
      setRefreshing(false);
    }
  };

  if (editing !== null) {
    return (
      <AgentForm
        agent={editing === "new" ? null : editing}
        projectName={cwd === null ? null : (current?.name ?? cwd)}
        saving={busy}
        onSave={(draft) => void save(draft)}
        onCancel={() => setEditing(null)}
        onDelete={editing === "new" ? null : () => void confirmDelete(editing)}
      />
    );
  }

  const list = (items: AgentInfo[], empty: React.ReactNode) =>
    items.length > 0 ? (
      <Card>
        {items.map((agent, i) => (
          <AgentRow
            key={agent.id}
            agent={agent}
            first={i === 0}
            onEdit={() => setEditing(agent)}
            onDelete={() => void confirmDelete(agent)}
            onToggle={(enabled) => void setEnabled(agent.id, enabled).catch(fail)}
            onReveal={() => void reveal(agent.path).catch(fail)}
            onModelOverride={(model) => void setModelOverride(agent.id, model).catch(fail)}
          />
        ))}
      </Card>
    ) : (
      empty
    );

  return (
    <>
      <Toolbar>
        <SearchBox value={q} onChange={setQ} placeholder={t("settings.agents.search")} />
        <span className="flex-1" />
        <IconButton
          name="loop"
          title={t("settings.agents.refresh")}
          onClick={() => void refresh()}
          disabled={refreshing || loading}
          spin={refreshing}
        />
        <Button size="sm" variant="primary" onClick={() => setEditing("new")}>
          <Icon name="plus" size={13} />
          {t("settings.agents.addNew")}
        </Button>
      </Toolbar>

      {diagnostics.length > 0 ? (
        <Section>
          <SectionHead title={t("settings.skills.warningsTitle")} count={diagnostics.length} />
          <Card>
            {diagnostics.map((d, i) => (
              <ListRow
                key={`${d.path}:${d.message}`}
                first={i === 0}
                logo={<IconTile name={d.level === "error" ? "bug" : "question"} />}
                title={
                  <span className={`truncate ${d.level === "error" ? "text-red" : ""}`}>
                    {d.message}
                  </span>
                }
                desc={<span className="font-mono">{d.path}</span>}
                actions={
                  <IconButton
                    name="folder"
                    title={t("settings.agents.openFolder")}
                    onClick={() => void reveal(d.path).catch(fail)}
                  />
                }
              />
            ))}
          </Card>
        </Section>
      ) : null}

      <Section>
        <SectionHead
          title={t("settings.agents.groupMine")}
          count={mine.length}
          desc={
            cwd
              ? t("settings.agents.headerCwd", { name: current?.name ?? "" })
              : t("settings.agents.headerNone")
          }
          actions={
            <Button size="sm" onClick={() => void reveal(catalog?.userDir ?? "").catch(fail)}>
              <Icon name="folderOpen" size={13} />
              {t("settings.agents.openFolder")}
            </Button>
          }
        />
        {loading && !catalog ? (
          <Note>{t("common.loading")}</Note>
        ) : (
          list(
            mine,
            <EmptyState
              title={t("settings.agents.emptyTitle")}
              desc={t("settings.agents.emptyDesc")}
              action={t("settings.agents.addNew")}
              onAction={() => setEditing("new")}
            />,
          )
        )}
      </Section>

      {catalog?.projectDir ? (
        <Section>
          <SectionHead
            title={t("settings.agents.groupProject")}
            count={project.length}
            actions={
              <Button size="sm" onClick={() => void reveal(catalog.projectDir ?? "").catch(fail)}>
                <Icon name="folderOpen" size={13} />
                {t("settings.agents.openFolder")}
              </Button>
            }
          />
          {list(project, <Note>{t("settings.agents.emptyProjectHint")}</Note>)}
        </Section>
      ) : null}

      <RunSettings s={s} patch={patch} />

      {/* Gömülü ajanlar en altta: düzenlenemezler, model seçicisi dışında eylemleri yok. */}
      <Section>
        <SectionHead
          title={t("settings.agents.groupBuiltIn")}
          count={builtIn.length}
          desc={t("settings.agents.groupBuiltInHint")}
        />
        {list(builtIn, <Note>{t("settings.agents.noMatch")}</Note>)}
      </Section>
    </>
  );
}
