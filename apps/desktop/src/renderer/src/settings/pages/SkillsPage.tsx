import type { SkillInfo } from "@codezal/contracts";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../../api";
import { Button } from "../../components/Button";
import { askConfirm } from "../../components/Confirm";
import { Icon } from "../../components/Icon";
import { Toggle } from "../../components/Toggle";
import type { IconName } from "../../icons";
import { matchesFold } from "../../lib/searchText";
import { usePaths } from "../../stores/paths";
import { useCurrentProject } from "../../stores/projects";
import { useSkills } from "../../stores/skills";
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

// ---------- Beceriler ----------

function shortPath(path: string, home: string): string {
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

const SCOPE_ICONS: Record<SkillInfo["scope"], IconName> = {
  user: "user",
  project: "folderClosed",
  temporary: "clock",
};

function ScopeChip({ scope }: { scope: SkillInfo["scope"] }) {
  const { t } = useTranslation();
  const label =
    scope === "user"
      ? t("settings.skills.scopeUser")
      : scope === "project"
        ? t("settings.skills.scopeProject")
        : t("settings.skills.scopeTemporary");
  return <Chip icon={SCOPE_ICONS[scope]}>{label}</Chip>;
}

function SkillRow({ item, home, first }: { item: SkillInfo; home: string; first: boolean }) {
  const { t } = useTranslation();
  const { setEnabled, reveal } = useSkills();
  return (
    <ListRow
      first={first}
      dim={!item.enabled}
      logo={<IconTile name="sparkle" />}
      title={<span className="truncate font-mono text-[13px]">/skill:{item.name}</span>}
      desc={<span title={item.description}>{item.description}</span>}
      meta={
        <>
          <ScopeChip scope={item.scope} />
          {item.hidden ? (
            <Chip icon="terminal" title={t("settings.skills.commandOnlyTitle")}>
              {t("settings.skills.commandOnly")}
            </Chip>
          ) : null}
          <span className="truncate font-mono text-[11px] text-tx3">
            {shortPath(item.path, home)}
          </span>
        </>
      }
      actions={
        <>
          <IconButton
            ghost
            name="folder"
            title={t("settings.skills.showFile")}
            onClick={() => void reveal(item.path)}
          />
          <Toggle
            on={item.enabled}
            onChange={(v) =>
              void setEnabled(item.path, v).catch((e) => toast.error(humanizeError(e)))
            }
          />
        </>
      }
    />
  );
}

/** Proje becerileri önce, sonra ada göre. */
function sortSkills(items: SkillInfo[]): SkillInfo[] {
  return [...items].sort((a, b) =>
    a.scope === b.scope ? a.name.localeCompare(b.name, "tr") : a.scope === "project" ? -1 : 1,
  );
}

/**
 * Pi kaynak sistemi: SKILL.md becerileri ve kaynak klasörler. Açma/kapama Pi ayar dosyasına
 * yazılır; değişiklikler yeni oturumlarda geçerli olur.
 */
export function SkillsPage() {
  const { t } = useTranslation();
  const current = useCurrentProject();
  const cwd = current?.path ?? null;
  const { catalog, load, loading, addSource, removeSource, reveal } = useSkills();
  /** Kaynak kaldırma onaylıdır: klasör listeden düşer ve becerileri görünmez olur. */
  const removeSourceConfirmed = async (src: string) => {
    const ok = await askConfirm({
      title: t("settings.skills.removeSourceConfirmTitle"),
      body: t("settings.skills.removeSourceConfirmBody", { path: src }),
      okLabel: t("settings.skills.remove"),
      danger: true,
    });
    if (!ok) return;
    await removeSource(src).catch(fail);
  };
  const home = usePaths((p) => p.home);
  const loadPaths = usePaths((p) => p.load);
  const [q, setQ] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    void loadPaths();
  }, [loadPaths]);
  useEffect(() => {
    void load(cwd);
  }, [load, cwd]);

  const fail = (e: unknown) => toast.error(humanizeError(e));
  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await load(cwd);
    } catch (e) {
      fail(e);
    } finally {
      setRefreshing(false);
    }
  };
  const onAddSource = async () => {
    const dir = await invoke("settings:pickFolder", {
      title: t("settings.skills.pickFolderTitle"),
    });
    if (!dir) return;
    await addSource(dir).catch(fail);
  };
  const skills = catalog?.skills ?? [];
  const sources = catalog?.sources ?? [];
  const diagnostics = catalog?.diagnostics ?? [];
  // Katlama `searchText`ten: iki dilde de aynı eşleşme (İ/ı, I/i).
  const needle = q.trim();
  const match = (name: string, desc: string) => !needle || matchesFold(`${name} ${desc}`, needle);
  const visibleSkills = sortSkills(skills.filter((s) => match(s.name, s.description)));
  const enabledSkills = skills.filter((s) => s.enabled).length;

  const openFolderButton = (dir: string) => (
    <Button size="sm" onClick={() => void reveal(dir)}>
      <Icon name="folderOpen" size={13} />
      {t("settings.skills.openCodezalFolder")}
    </Button>
  );
  const refreshButton = (
    <IconButton
      name="loop"
      title={t("settings.skills.refresh")}
      onClick={() => void onRefresh()}
      disabled={refreshing || loading}
      spin={refreshing}
    />
  );
  const listOrEmpty = <T,>(
    items: T[],
    total: number,
    render: (item: T, i: number) => React.ReactNode,
    empty: React.ReactNode,
  ) => {
    if (loading && !catalog) return <Note>{t("common.loading")}</Note>;
    if (total === 0) return empty;
    if (items.length === 0) return <Note>{t("settings.skills.noMatch")}</Note>;
    return <Card>{items.map(render)}</Card>;
  };

  return (
    <>
      {/* Arama solda, sayfa eylemleri sağda tek şerit: eylemler bölüm başlığındayken açıklama
          iki satıra kırılıyor, arama da üstte tek başına boş bir satır kaplıyordu. */}
      <Toolbar>
        <SearchBox value={q} onChange={setQ} placeholder={t("settings.skills.search")} />
        <span className="flex-1" />
        {refreshButton}
        {openFolderButton(catalog?.ownSkillsDir ?? "")}
        <Button size="sm" variant="primary" onClick={() => void onAddSource()}>
          <Icon name="plus" size={13} />
          {t("settings.skills.addFolder")}
        </Button>
      </Toolbar>

      <Section>
        <SectionHead
          title={t("settings.skills.installedTitle")}
          count={skills.length}
          desc={
            <>
              {cwd
                ? t("settings.skills.headerCwd", { name: current?.name ?? "" })
                : t("settings.skills.headerNone")}
              {skills.length > 0
                ? ` · ${t("settings.skills.enabledCount", { on: enabledSkills, total: skills.length })}`
                : ""}
            </>
          }
        />
        {listOrEmpty(
          visibleSkills,
          skills.length,
          (item, i) => (
            <SkillRow key={item.path} item={item} home={home} first={i === 0} />
          ),
          <EmptyState
            title={t("settings.skills.emptySkillsTitle")}
            desc={t("settings.skills.emptySkillsDesc")}
            action={t("settings.skills.addFolder")}
            onAction={() => void onAddSource()}
          />,
        )}
      </Section>

      <Section>
        <SectionHead
          title={t("settings.skills.sourcesTitle")}
          count={sources.length}
          desc={t("settings.skills.sourcesHeader")}
        />
        {sources.length === 0 ? (
          <Note>{t("settings.skills.emptySources")}</Note>
        ) : (
          <Card>
            {sources.map((src, i) => (
              <ListRow
                key={src}
                first={i === 0}
                logo={<IconTile name="folderClosed" />}
                title={
                  <span className="truncate font-mono text-[13px]">{shortPath(src, home)}</span>
                }
                actions={
                  <>
                    <IconButton
                      ghost
                      name="folder"
                      title={t("settings.skills.show")}
                      onClick={() => void reveal(src)}
                    />
                    <IconButton
                      ghost
                      name="trash"
                      danger
                      title={t("settings.skills.remove")}
                      onClick={() => void removeSourceConfirmed(src)}
                    />
                  </>
                }
              />
            ))}
          </Card>
        )}
      </Section>

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
                desc={<span className="font-mono">{shortPath(d.path, home)}</span>}
                actions={
                  <IconButton
                    ghost
                    name="folder"
                    title={t("settings.skills.showFile")}
                    onClick={() => void reveal(d.path)}
                  />
                }
              />
            ))}
          </Card>
        </Section>
      ) : null}
    </>
  );
}
