import type { MemoryEntry, MemoryScope } from "@codezal/contracts";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/Button";
import { askConfirm } from "../../components/Confirm";
import { Icon } from "../../components/Icon";
import { addMemoryNote } from "../../components/MemoryList";
import type { IconName } from "../../icons";
import { shortAgo } from "../../lib/format";
import { useLocale } from "../../lib/i18n";
import { matchesFold } from "../../lib/searchText";
import { useNow } from "../../lib/useNow";
import { parseScopeKey, scopeKey, useMemory } from "../../stores/memory";
import { useCurrentProject } from "../../stores/projects";
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
  SegmentedTabs,
  Toolbar,
} from "../list";
import { Row } from "../rows";

// ---------- Bellek ----------

type Tab = "genel" | "proje";

const TYPE_ICONS: Record<MemoryEntry["type"], IconName> = {
  kullanici: "user",
  geribildirim: "thumbUp",
  proje: "folderClosed",
  kaynak: "globe",
};

function MemoryRow({
  entry,
  scope,
  first,
}: {
  entry: MemoryEntry;
  scope: MemoryScope;
  first: boolean;
}) {
  const { t } = useTranslation();
  const lang = useLocale();
  const now = useNow();
  const remove = useMemory((m) => m.remove);
  const [open, setOpen] = useState(false);
  const TYPE_LABEL: Record<MemoryEntry["type"], string> = {
    kullanici: t("memory.typeUser"),
    geribildirim: t("memory.typeFeedback"),
    proje: t("memory.typeProject"),
    kaynak: t("memory.typeSource"),
  };
  // Gövde açıklamayla aynıysa açılacak bir şey yok.
  const hasBody = Boolean(entry.body) && entry.body !== entry.description;
  return (
    <ListRow
      first={first}
      logo={<IconTile name={TYPE_ICONS[entry.type]} />}
      title={<span className="truncate">{entry.description || entry.name}</span>}
      desc={hasBody ? entry.body : undefined}
      meta={
        <>
          <Chip>{TYPE_LABEL[entry.type]}</Chip>
          <span className="truncate font-mono text-[11px] text-tx3">{entry.file}</span>
          <span className="shrink-0 text-[11px] text-tx3">
            {shortAgo(entry.updatedAt, lang, now)}
          </span>
        </>
      }
      actions={
        <>
          {hasBody ? (
            <IconButton
              name={open ? "chevronDown" : "chevronRight"}
              title={open ? t("settings.memory.collapse") : t("settings.memory.expand")}
              onClick={() => setOpen((v) => !v)}
            />
          ) : null}
          <IconButton
            name="trash"
            danger
            title={t("common.delete")}
            onClick={() => {
              void askConfirm({
                title: t("common.delete"),
                body: t("memory.confirmDelete", { name: entry.description || entry.name }),
                danger: true,
              }).then((ok) => {
                if (ok) void remove(scope, entry.name);
              });
            }}
          />
        </>
      }
    >
      {open && hasBody ? (
        <div className="mt-[10px] whitespace-pre-wrap rounded-[8px] bg-bg px-3 py-2 text-[12px] leading-[1.55] text-tx2">
          {entry.body}
        </div>
      ) : null}
    </ListRow>
  );
}

/** Bir kapsamın kayıt listesi: eşleşenler kart içinde, yoksa boş durum. */
function MemoryScopeList({
  scope,
  needle,
  empty,
}: {
  scope: MemoryScope;
  needle: string;
  empty: { title: string; desc: string };
}) {
  const { t } = useTranslation();
  const key = scopeKey(scope);
  const entries = useMemory((s) => s.byScope[key]);
  const load = useMemory((s) => s.load);

  // Çağıran her render'da yeni nesne verebilir; anahtar üzerinden yükle ki döngü oluşmasın.
  useEffect(() => {
    void load(parseScopeKey(key));
  }, [load, key]);

  if (!entries) return <Note>{t("common.loading")}</Note>;
  if (entries.length === 0)
    return (
      <EmptyState
        title={empty.title}
        desc={empty.desc}
        action={t("settings.memory.addNote")}
        onAction={() => void addMemoryNote(scope)}
      />
    );
  const visible = entries.filter(
    (e) => !needle || matchesFold(`${e.description} ${e.body} ${e.name}`, needle),
  );
  if (visible.length === 0) return <Note>{t("settings.memory.noMatch")}</Note>;
  return (
    <Card>
      {visible.map((e, i) => (
        <MemoryRow key={e.name} entry={e} scope={scope} first={i === 0} />
      ))}
    </Card>
  );
}

/** Harness tarzı dosya belleği: genel kapsam her oturumda, proje kapsamı seçili projede yüklenir. */
export function MemoryPage() {
  const { t } = useTranslation();
  const current = useCurrentProject();
  const openFolder = useMemory((m) => m.openFolder);
  const [tab, setTab] = useState<Tab>("genel");
  const [q, setQ] = useState("");
  // Katlama `searchText`ten: "İ"li metin yerel ayarsız küçültmede `i̇` olup eşleşmiyordu.
  const needle = q.trim();

  const genel = { kind: "genel" } as const;
  const proje = current ? ({ kind: "proje", cwd: current.path } as const) : null;
  const genelCount = useMemory((s) => s.byScope[scopeKey(genel)]?.length);
  const projeCount = useMemory((s) => (proje ? s.byScope[scopeKey(proje)]?.length : undefined));

  const tabs = [
    { key: "genel" as Tab, label: t("settings.memory.generalTitle"), count: genelCount ?? 0 },
    { key: "proje" as Tab, label: t("settings.memory.projectTitle"), count: projeCount ?? 0 },
  ];
  const actions = (scope: MemoryScope) => (
    <>
      <Button size="sm" onClick={() => void openFolder(scope)}>
        <Icon name="folderOpen" size={13} />
        {t("settings.memory.openFolder")}
      </Button>
      <Button size="sm" variant="primary" onClick={() => void addMemoryNote(scope)}>
        <Icon name="plus" size={13} />
        {t("settings.memory.addNote")}
      </Button>
    </>
  );

  return (
    <>
      <Toolbar>
        <SegmentedTabs value={tab} items={tabs} onChange={setTab} />
        <span className="flex-1" />
        <SearchBox value={q} onChange={setQ} placeholder={t("settings.memory.search")} />
      </Toolbar>

      {tab === "genel" ? (
        <Section>
          <SectionHead
            title={t("settings.memory.entriesTitle")}
            count={genelCount ?? 0}
            desc={t("settings.memory.generalHeader")}
            actions={actions(genel)}
          />
          <MemoryScopeList
            scope={genel}
            needle={needle}
            empty={{
              title: t("settings.memory.generalEmptyTitle"),
              desc: t("settings.memory.generalEmpty"),
            }}
          />
        </Section>
      ) : proje ? (
        <Section>
          <SectionHead
            title={t("settings.memory.entriesTitle")}
            count={projeCount ?? 0}
            desc={t("settings.memory.projectHeader", { name: current?.name ?? "" })}
            actions={actions(proje)}
          />
          <MemoryScopeList
            scope={proje}
            needle={needle}
            empty={{
              title: t("settings.memory.projectEmptyTitle"),
              desc: t("settings.memory.projectEmpty"),
            }}
          />
        </Section>
      ) : (
        <Section>
          <SectionHead title={t("settings.memory.entriesTitle")} count={0} />
          <EmptyState
            title={t("settings.memory.noProjectLabel")}
            desc={t("settings.memory.noProjectDesc")}
          />
        </Section>
      )}

      <Section>
        <SectionHead title={t("settings.memory.howTitle")} />
        <Card>
          <Row
            first
            label={t("settings.memory.fileMemoryLabel")}
            desc={t("settings.memory.fileMemoryDesc")}
          />
        </Card>
      </Section>
    </>
  );
}
