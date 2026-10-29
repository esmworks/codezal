import type { AppMode, SessionSummary } from "@codezal/contracts";
import type { TranslationKey } from "@codezal/i18n";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../api";
import { askConfirm } from "../components/Confirm";
import { ErrorText } from "../components/ErrorBar";
import { Icon } from "../components/Icon";
import { askText } from "../components/Prompt";
import { Resizer } from "../components/Resizer";
import { SlidePane } from "../components/SlidePane";
import type { IconName } from "../icons";
import { basename, shortAgo, worktreeParent } from "../lib/format";
import { useLocale } from "../lib/i18n";
import { type MarkMods, type MarkState, markClick, noMarks, pruneMarks } from "../lib/multiSelect";
import { applyReorder, dropAfter, dropIndex } from "../lib/reorder";
import { sessionToggleVisible, visibleSessions } from "../lib/sidebarLimit";
import { useNow } from "../lib/useNow";
import { useShortcutHint } from "../shortcuts";
import { useApp } from "../stores/app";
import { useAssistant } from "../stores/assistant";
import { type MenuEntry, useMenu } from "../stores/menu";
import { useCurrentProject, useProjects } from "../stores/projects";
import { useSessions } from "../stores/sessions";
import { useStartup } from "../stores/startup";
import { humanizeError, toast } from "../stores/toast";

const NAV: Array<{ labelKey: TranslationKey; icon: IconName; mode: AppMode }> = [
  { labelKey: "sidebar.navKodlama", icon: "code", mode: "kodlama" },
  { labelKey: "sidebar.navAsistan", icon: "sparkle", mode: "asistan" },
];

/**
 * Bölüm etiketi: Sabitlenenler ve her proje/klasör başlığı aynı biçimde (küçük, orta kalınlık,
 * soluk). Başlık satır değil etikettir; sohbet satırlarıyla aynı boy/renk/hizada durduğunda proje
 * adları sohbetlerle karışıyordu. Sohbet metni etiketin ~19px içinden başlar.
 */
const SECTION_LABEL =
  "flex min-h-6 w-full select-none items-center gap-1 rounded-[7px] pl-2 pr-[6px] text-left text-[12px] font-medium";

/** Sabitlenenler bölümünün katlama/göster durumları için anahtar; grup anahtarlarıyla çakışmaz. */
const PINNED_KEY = "__pinned";

/**
 * Kenar çubuğu grupları. Kodlama'da klasör (kod deposu); Asistan'da kişisel proje
 * (Kişisel finans, İngilizce eğitimi…) ve projeye bağlı olmayan görevler için "Oturumlar".
 */
type Group =
  | { kind: "folder"; key: string; name: string; path: string; items: SessionSummary[] }
  | { kind: "project"; key: string; name: string; projectId: string; items: SessionSummary[] }
  | { kind: "loose"; key: string; name: string; items: SessionSummary[] };

/**
 * Satırın çoklu seçimdeki durumu. Seçim Finder'daki gibi yalnızca satır vurgusuyla gösterilir:
 * Cmd/Ctrl tek satır ekler, Shift aralık seçer, sade tıklama seçimi bırakıp satırı açar.
 */
interface RowMarks {
  /** Bu satır seçili mi. */
  marked: boolean;
  /** Birden çok satır seçiliyken ortak bağlam menüsü; yoksa null. */
  bulkItems: MenuEntry[] | null;
  mark: (mods: MarkMods) => void;
  clear: () => void;
}

/** Değiştirici tuşla tıklama satırı açmak yerine seçer. */
const wantsMark = (e: React.MouseEvent) => e.metaKey || e.ctrlKey || e.shiftKey;
const clickMods = (e: React.MouseEvent): MarkMods => ({
  toggle: e.metaKey || e.ctrlKey,
  range: e.shiftKey,
});

function SessionRow({ s, active, sel }: { s: SessionSummary; active: boolean; sel: RowMarks }) {
  const { t } = useTranslation();
  const lang = useLocale();
  const now = useNow();
  const openSession = useApp((st) => st.openSession);
  const openAt = useMenu((st) => st.openAt);
  const { rename, regenerateTitle, remove, setPinned, setArchived, fork } = useSessions();
  // Nokta üç durumlu: ajan çalışırken pulse (koyu-açık gri), okunmamış son mesajda dolu, yoksa görünmez.
  const working = useSessions((st) => {
    const status = st.runtime[s.id]?.status;
    return status === "working" || status === "waiting";
  });
  const unread = useSessions((st) => st.unread[s.id] === true);

  const rowClick = (e: React.MouseEvent) => {
    if (wantsMark(e)) sel.mark(clickMods(e));
    else {
      sel.clear();
      openSession(s.id, s.mode);
    }
  };

  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Seçili satırlardan birine sağ tıklamak ortak menüyü açar; seçili olmayan satır seçimi bırakır.
    if (sel.bulkItems) {
      openAt(e.currentTarget as HTMLElement, { items: sel.bulkItems });
      return;
    }
    sel.clear();
    openAt(e.currentTarget as HTMLElement, {
      items: [
        {
          label: s.pinned ? t("sidebar.unpin") : t("sidebar.pin"),
          icon: "pin",
          onSelect: () => void setPinned(s.id, !s.pinned),
        },
        {
          label: t("sidebar.rename"),
          icon: "pen",
          onSelect: () => {
            void askText({ title: t("sidebar.rename"), initial: s.name }).then((name) => {
              if (name) void rename(s.id, name);
            });
          },
        },
        {
          label: t("sidebar.regenerateTitle"),
          icon: "sparkle",
          onSelect: () => {
            void regenerateTitle(s.id).catch((e: unknown) => toast.error(humanizeError(e)));
          },
        },
        {
          label: t("sidebar.fork"),
          icon: "copy",
          onSelect: () => void fork(s.id).then((newId) => openSession(newId, s.mode)),
        },
        {
          label: t("sidebar.export"),
          icon: "export",
          onSelect: () => void invoke("sessions:export", { id: s.id }),
        },
        {
          label: t("sidebar.archive"),
          icon: "folderClosed",
          onSelect: () => void setArchived(s.id, true),
        },
        {
          label: t("sidebar.deleteChat"),
          icon: "trash",
          danger: true,
          top: true,
          onSelect: () => {
            void askConfirm({
              title: t("sidebar.deleteChat"),
              body: t("sidebar.confirmDeleteChat", { name: s.name }),
              danger: true,
            }).then((ok) => {
              if (ok) void remove(s.id);
            });
          },
        },
      ],
    });
  };

  return (
    <div
      onClick={rowClick}
      onContextMenu={menu}
      className={`group flex cursor-pointer select-none items-center gap-[7px] rounded-[7px] py-[4px] pr-2 pl-4 text-[13px] hover:bg-selHov ${
        active || sel.marked ? "bg-sel text-tx shadow-sel" : "text-tx"
      }`}
    >
      <span
        aria-hidden
        className={`h-[6px] w-[6px] shrink-0 rounded-full ${
          working ? "animate-pulse bg-acc" : unread ? "bg-acc" : "bg-transparent"
        }`}
      />
      <span className="min-w-0 flex-1 truncate">{s.name}</span>
      {/* Proje grubunda listelenen worktree oturumu dal simgesiyle ayrılır; ipucu worktree adı. */}
      {worktreeParent(s.cwd) ? (
        <span title={basename(s.cwd)} className="shrink-0 text-tx3">
          <Icon name="branch" size={11} />
        </span>
      ) : null}
      {s.auditRunId ? (
        <span title={t("audit.title")} className="shrink-0 text-tx3">
          <Icon name="shield" size={11} />
        </span>
      ) : null}
      {/* Seçili satırın zemini koyu temada açılıyor; soluk zaman damgası orada sınırda kalıyordu. */}
      <span
        className={`shrink-0 text-[11px] group-hover:hidden ${active || sel.marked ? "text-tx2" : "text-tx3"}`}
      >
        {shortAgo(s.modifiedAt, lang, now)}
      </span>
      <button
        type="button"
        onClick={menu}
        className="hidden h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] text-[13px] tracking-[1px] text-tx3 hover:bg-chip hover:text-tx group-hover:flex"
      >
        ···
      </button>
    </div>
  );
}

/**
 * Grup içi sohbet listesi: varsayılanda yalnızca son N sohbeti gösterir, kalanı "göster"
 * satırıyla açılır. Açık sohbet dilimin dışında kalsa da listeye girer (bkz. visibleSessions).
 */
function LimitedSessions({
  items,
  expanded,
  activeSessionId,
  rowMarks,
  onToggle,
}: {
  items: SessionSummary[];
  expanded: boolean;
  activeSessionId: string | null;
  rowMarks: (key: string) => RowMarks;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const { visible, hidden } = visibleSessions(items, expanded, activeSessionId);
  return (
    <>
      {visible.map((s) => (
        <SessionRow
          key={s.id}
          s={s}
          active={s.id === activeSessionId}
          sel={rowMarks(`s:${s.id}`)}
        />
      ))}
      {sessionToggleVisible(expanded, items.length, hidden) ? (
        <button
          type="button"
          onClick={onToggle}
          // Sol dolgu satırın metin hizası: `pl-4` (1rem; kök 14px) + okunmadı noktası (6px) + aralık
          // (7px). rem'e bağlı yazılır ki satırın dolgusuyla birlikte değişsin.
          className="select-none rounded-[7px] py-[5px] pr-2 pl-[calc(1rem+13px)] text-left text-[12px] text-tx3 hover:text-tx"
        >
          {expanded ? t("sidebar.showLess") : t("sidebar.showMore", { count: hidden })}
        </button>
      ) : null}
    </>
  );
}

/**
 * Sabitlenenler bölümünün başlığı: proje başlıklarıyla aynı etiket (`SECTION_LABEL`). Tıklama katlar; ok kapalıyken hep, açıkken yalnız üzerine gelince
 * görünür. Sağda sayı yok: proje başlıklarında da yok (o köşe üzerine gelince çıkan "yeni"
 * düğmesinin), yalnız burada duran sayı başlıkları birbirinden farklı gösteriyordu.
 */
function PinnedHeader({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={`group ${SECTION_LABEL} text-tx3 hover:text-tx2`}
    >
      <span className="min-w-0 truncate">{t("sidebar.pinnedGroup")}</span>
      <Icon
        name={open ? "chevronDown" : "chevronRight"}
        size={11}
        stroke={2}
        className={open ? "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" : ""}
      />
    </button>
  );
}

function GroupRow({
  g,
  open,
  active,
  sel,
  drag,
  dragging,
  hint,
  canMoveUp,
  canMoveDown,
  onMove,
  onToggle,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  g: Group;
  open: boolean;
  active: boolean;
  sel: RowMarks;
  /** Sürüklenebilir mi: yalnız klasör ve proje satırları; "Oturumlar" sonda sabittir. */
  drag: boolean;
  /** Sürüklenen satır soluklaşır. */
  dragging: boolean;
  /** Bırakma çizgisinin yeri; null ise gösterilmez. */
  hint: "before" | "after" | null;
  canMoveUp: boolean;
  canMoveDown: boolean;
  /** Menüden taşıma: klavyeyle de sıralanabilsin diye sürüklemenin aynı yolunu kullanır. */
  onMove: (dir: -1 | 1) => void;
  onToggle: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  const { t } = useTranslation();
  const newTaskKey = useShortcutHint("new-task");
  const [hot, setHot] = useState(false);
  const { mode, goHome, openProject, setMode } = useApp();
  const select = useProjects((s) => s.select);
  const openAt = useMenu((s) => s.openAt);
  const { projects, saveProject, deleteProject } = useAssistant();
  const forgetFolder = useProjects((s) => s.forget);
  const archiveFolder = useSessions((s) => s.archiveCwd);

  /** Grup içinde yeni iş: klasörde yeni sohbet, projede yeni görev (proje ekranı), Oturumlar'da ana ekran. */
  const newItem = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (g.kind === "folder") {
      select({ path: g.path, name: g.name, isGit: false });
      goHome();
    } else if (g.kind === "project") openProject(g.projectId);
    else {
      setMode("asistan");
      goHome();
    }
  };

  // "Oturumlar" silinemediğinden seçime girmez.
  const markable = g.kind !== "loose";
  const marks = (e: React.MouseEvent) => markable && wantsMark(e);

  const rowClick = (e: React.MouseEvent) => {
    if (marks(e)) sel.mark(clickMods(e));
    else {
      sel.clear();
      onToggle();
    }
  };

  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Seçili satırlardan birine sağ tıklamak ortak menüyü açar; seçili olmayan satır seçimi bırakır.
    if (sel.bulkItems) {
      openAt(e.currentTarget as HTMLElement, { items: sel.bulkItems });
      return;
    }
    sel.clear();
    if (g.kind === "project") {
      const project = projects.find((p) => p.id === g.projectId);
      openAt(e.currentTarget as HTMLElement, {
        items: [
          { label: t("sidebar.newTask"), icon: "plus", onSelect: () => openProject(g.projectId) },
          {
            label: t("sidebar.openProject"),
            icon: "folder",
            onSelect: () => openProject(g.projectId),
          },
          {
            label: t("sidebar.moveUp"),
            icon: "chevronUp",
            disabled: !canMoveUp,
            onSelect: () => onMove(-1),
          },
          {
            label: t("sidebar.moveDown"),
            icon: "chevronDown",
            disabled: !canMoveDown,
            onSelect: () => onMove(1),
          },
          {
            label: t("sidebar.rename"),
            icon: "pen",
            onSelect: () => {
              void askText({ title: t("sidebar.projectName"), initial: g.name }).then((n) => {
                if (n && project) void saveProject({ ...project, name: n });
              });
            },
          },
          {
            label: open ? t("sidebar.groupClose") : t("sidebar.groupOpen"),
            icon: "chevronDown",
            onSelect: onToggle,
          },
          {
            label: t("sidebar.deleteProject"),
            icon: "trash",
            danger: true,
            top: true,
            onSelect: () => {
              void askConfirm({
                title: t("sidebar.deleteProject"),
                body: t("sidebar.confirmDeleteProject", { name: g.name }),
                danger: true,
              }).then((ok) => {
                if (ok) void deleteProject(g.projectId).then(() => setMode("asistan"));
              });
            },
          },
        ],
      });
      return;
    }
    if (g.kind === "loose") {
      openAt(e.currentTarget as HTMLElement, {
        items: [
          {
            label: t("sidebar.newChat"),
            icon: "plus",
            key: newTaskKey,
            onSelect: () => newItem(e),
          },
          {
            label: open ? t("sidebar.groupClose") : t("sidebar.groupOpen"),
            icon: "chevronDown",
            onSelect: onToggle,
          },
        ],
      });
      return;
    }
    openAt(e.currentTarget as HTMLElement, {
      items: [
        { label: t("sidebar.newChat"), icon: "plus", key: newTaskKey, onSelect: () => newItem(e) },
        {
          label: t("sidebar.moveUp"),
          icon: "chevronUp",
          disabled: !canMoveUp,
          onSelect: () => onMove(-1),
        },
        {
          label: t("sidebar.moveDown"),
          icon: "chevronDown",
          disabled: !canMoveDown,
          onSelect: () => onMove(1),
        },
        { label: t("sidebar.closeFolder"), icon: "chevronDown", onSelect: onToggle },
        {
          label: t("shortcuts.terminal.label"),
          icon: "terminal",
          onSelect: () => void invoke("project:openTerminal", { path: g.path }),
        },
        {
          label: t("sidebar.deleteFolder"),
          icon: "trash",
          danger: true,
          top: true,
          onSelect: () => {
            void askConfirm({
              title: t("sidebar.deleteFolder"),
              body: t("sidebar.confirmDeleteFolder", { name: g.name }),
              danger: true,
            }).then((ok) => {
              if (ok) void archiveFolder(g.path, mode).then(() => forgetFolder(g.path));
            });
          },
        },
      ],
    });
  };

  // Etkin proje (proje ekranı açık) ve seçili başlık koyu; gerisi soluk etiket.
  const tone =
    (g.kind === "project" && active) || sel.marked ? "text-tx" : "text-tx3 hover:text-tx2";
  return (
    <div
      onClick={rowClick}
      onContextMenu={menu}
      onMouseEnter={() => setHot(true)}
      onMouseLeave={() => setHot(false)}
      draggable={drag}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={`relative ${SECTION_LABEL} ${tone} ${
        drag ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
      } ${sel.marked ? "bg-sel shadow-sel" : ""} ${dragging ? "opacity-40" : ""}`}
    >
      {hint ? (
        // İnce çizgi: hedefin üstüne mi altına mı bırakılacağını gösterir, yerleşimi kaydırmaz.
        <span
          className={`pointer-events-none absolute inset-x-0 h-[2px] rounded-full bg-acc ${
            hint === "before" ? "top-[-2px]" : "bottom-[-2px]"
          }`}
        />
      ) : null}
      {g.kind === "project" ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (marks(e)) sel.mark(clickMods(e));
            else {
              sel.clear();
              openProject(g.projectId);
            }
          }}
          className="min-w-0 truncate text-left"
        >
          {g.name}
        </button>
      ) : (
        <span className="min-w-0 truncate">{g.name}</span>
      )}
      {/* Katlama oku adın hemen ardında: kapalıyken hep, açıkken yalnız üzerine gelince görünür. */}
      <Icon
        name={open ? "chevronDown" : "chevronRight"}
        size={11}
        stroke={2}
        className={`shrink-0 ${open && !hot ? "invisible" : ""}`}
      />
      <span className="flex-1" />
      <button
        type="button"
        onClick={newItem}
        title={g.kind === "project" ? t("sidebar.newTask") : t("sidebar.newChat")}
        className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] text-tx3 hover:bg-chip hover:text-tx ${hot ? "" : "invisible"}`}
      >
        <Icon name="plus" size={12} stroke={2} />
      </button>
      <button
        type="button"
        onClick={menu}
        className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] text-[13px] tracking-[1px] text-tx3 hover:bg-chip hover:text-tx ${hot ? "" : "invisible"}`}
      >
        ···
      </button>
    </div>
  );
}

export function Sidebar() {
  const { t } = useTranslation();
  const newTaskKey = useShortcutHint("new-task");
  const {
    mode,
    setMode,
    goHome,
    openProject,
    openScheduled,
    sidebarOpen,
    sidebarWidth,
    setSidebarWidth,
    activeSessionId,
    activeProjectId,
    screen,
  } = useApp();
  const list = useSessions((s) => s.list);
  const recent = useProjects((s) => s.recent);
  const currentPath = useCurrentProject()?.path ?? "";
  const pick = useProjects((s) => s.pick);
  const projects = useAssistant((s) => s.projects);
  const createProject = useAssistant((s) => s.createProject);
  const deleteProject = useAssistant((s) => s.deleteProject);
  const reorderProjects = useAssistant((s) => s.reorderProjects);
  const scheduledCount = useAssistant((s) => s.tasks.length);
  const reorderFolders = useProjects((s) => s.reorder);
  const forgetFolder = useProjects((s) => s.forget);
  const archiveFolder = useSessions((s) => s.archiveCwd);
  const removeSessions = useSessions((s) => s.removeMany);
  const startup = useStartup((s) => s.status);
  const startupError = useStartup((s) => s.error);
  const retryStartup = useStartup((s) => s.load);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const [marks, setMarks] = useState<MarkState>(noMarks);
  /** Sürüklenen satırın grup anahtarı; null ise sürükleme yok. */
  const [dragKey, setDragKey] = useState<string | null>(null);
  /** Bırakılacak satır ve tarafı; yoksa çizgi çizilmez. */
  const [dropHint, setDropHint] = useState<{ key: string; after: boolean } | null>(null);

  /**
   * Sabitlenen sohbetler proje/klasör gruplarından ayrı, listenin en üstündeki "Sabitlenenler"
   * bölümünde toplanır; hangi projeye ait olduklarından bağımsız hep görünür kalırlar.
   */
  const pinned = useMemo(
    () =>
      list
        .filter((s) => s.pinned && !s.archived && s.mode === mode)
        .sort((a, b) => b.modifiedAt - a.modifiedAt),
    [list, mode],
  );

  const groups = useMemo<Group[]>(() => {
    // Sabitlenenler ayrı bölümde listelendiğinden gruplarda kalan sıralama son kullanımdır.
    const sortItems = (g: Group) => g.items.sort((a, b) => b.modifiedAt - a.modifiedAt);
    if (mode === "asistan") {
      // Asistan projeleri kod klasörlerinden bağımsızdır; görevler projeId ile eşleşir.
      const byId = new Map<string, Group>();
      for (const p of projects)
        byId.set(p.id, { kind: "project", key: p.id, name: p.name, projectId: p.id, items: [] });
      const loose: Group = {
        kind: "loose",
        key: "__oturumlar",
        name: t("sidebar.looseGroup"),
        items: [],
      };
      for (const s of list) {
        if (s.mode !== "asistan" || s.archived || s.pinned) continue;
        const g = s.projectId ? byId.get(s.projectId) : undefined;
        (g ?? loose).items.push(s);
      }
      // Boş grup gizlenir (Kodlama'daki klasör kuralıyla aynı): altı boş etiket liste gibi
      // durmuyor. Açık proje ekranının projesi oturumsuz da olsa görünür kalır.
      const all = [...byId.values(), loose].filter(
        (g) =>
          g.items.length > 0 ||
          (g.kind === "project" && screen === "project" && g.projectId === activeProjectId),
      );
      for (const g of all) sortItems(g);
      return all;
    }
    const byCwd = new Map<string, Group>();
    for (const p of recent)
      byCwd.set(p.path, { kind: "folder", key: p.path, name: p.name, path: p.path, items: [] });
    for (const s of list) {
      if (s.mode !== mode || s.archived || s.pinned) continue;
      // Worktree oturumu kendi klasör grubunu açmaz, projesinin altında listelenir.
      const path = worktreeParent(s.cwd) ?? s.cwd;
      let g = byCwd.get(path);
      if (!g) {
        g = { kind: "folder", key: path, name: basename(path), path, items: [] };
        byCwd.set(path, g);
      }
      g.items.push(s);
    }
    // Her bölüm kendi projelerini gösterir: bir klasör ancak o kipte oturumu varsa listelenir.
    // Yeni seçilen proje henüz oturumsuz olabilir; seçili klasör her zaman kalır.
    const all = [...byCwd.values()].filter(
      (g) => g.items.length > 0 || (g.kind === "folder" && g.path === currentPath),
    );
    for (const g of all) sortItems(g);
    return all;
  }, [list, recent, mode, projects, currentPath, screen, activeProjectId, t]);

  /** Kayda yazılan tam sıra: sürüklenen liste görünenden küçükse gizli öğeler burada korunur. */
  const fullOrder = useMemo(
    () => (mode === "asistan" ? projects.map((p) => p.id) : recent.map((p) => p.path)),
    [mode, projects, recent],
  );

  /**
   * Sürüklemeyle sıralanabilir gruplar, görünen sırayla: "Oturumlar" sonda sabittir. Henüz
   * kayıtlı olmayan klasör (yolu silinmiş olabilir) sıralamaya girmez, yoksa indeks kayar.
   */
  const sortableKeys = useMemo(() => {
    const known = new Set(fullOrder);
    return groups
      .filter((g) => g.kind !== "loose")
      .map((g) => (g.kind === "project" ? g.projectId : g.path))
      .filter((key) => known.has(key));
  }, [groups, fullOrder]);

  const writeOrder = (next: string[]) => {
    if (next.every((key, i) => key === fullOrder[i])) return;
    if (mode === "asistan") void reorderProjects(next);
    else void reorderFolders(next);
  };

  /** Bırakma: hedef satırın önüne ya da arkasına taşır; aynı yere bırakma hiçbir şey yapmaz. */
  const dropGroup = (target: string, after: boolean) => {
    const from = dragKey;
    setDragKey(null);
    setDropHint(null);
    if (!from || from === target) return;
    const to = dropIndex(sortableKeys, from, target, after);
    if (to < 0) return;
    writeOrder(applyReorder(fullOrder, sortableKeys, from, to));
  };

  /** Menüden taşıma: sürüklemenin aynı yolunu kullanır, böylece iki yolda davranış ayrışmaz. */
  const moveGroup = (key: string, dir: -1 | 1) => {
    const index = sortableKeys.indexOf(key);
    const to = index + dir;
    if (index < 0 || to < 0 || to >= sortableKeys.length) return;
    writeOrder(applyReorder(fullOrder, sortableKeys, key, to));
  };

  // Seçilebilir satırlar, görünen sırayla: sabitlenenler ve grup başlıkları ("Oturumlar" hariç)
  // ile görünen sohbetler. Kapalı ya da "göster" ile açılmamış dilimdeki sohbet listede
  // olmadığından seçimi de düşer: görünmeyen satır silinmesin. Shift aralığı yalnızca aynı
  // türde satırları kapsar — iki sohbet arasındaki klasör başlığı aralığa girip yanlışlıkla
  // silinmesin.
  const rows = useMemo(() => {
    const all: string[] = [];
    const groupKeys: string[] = [];
    const sessionKeys: string[] = [];
    if (!closed[PINNED_KEY]) {
      const items = visibleSessions(pinned, showAll[PINNED_KEY] === true, activeSessionId).visible;
      for (const s of items) {
        all.push(`s:${s.id}`);
        sessionKeys.push(`s:${s.id}`);
      }
    }
    for (const g of groups) {
      if (g.kind !== "loose") {
        all.push(`g:${g.key}`);
        groupKeys.push(`g:${g.key}`);
      }
      if (!closed[g.key]) {
        const items = visibleSessions(g.items, showAll[g.key] === true, activeSessionId).visible;
        for (const s of items) {
          all.push(`s:${s.id}`);
          sessionKeys.push(`s:${s.id}`);
        }
      }
    }
    return { all, groupKeys, sessionKeys };
  }, [groups, closed, showAll, pinned, activeSessionId]);
  // Silinen ya da listeden düşen satırların seçimi kalmasın.
  useEffect(() => setMarks((m) => pruneMarks(m, rows.all)), [rows]);

  /**
   * Seçim yokken açık satır (vurgulu olan) seçimin başlangıcı sayılır: bir sohbete tıklayıp
   * başkasına Shift ile tıklamak ikisinin arasını, Cmd ile tıklamak ikisini seçer. Yalnızca aynı
   * türdeyse: açık sohbet, bir klasöre Cmd ile tıklanınca seçime karışmaz.
   */
  const markRow = (key: string, mods: MarkMods) => {
    const isSession = key.startsWith("s:");
    const order = mods.range ? (isSession ? rows.sessionKeys : rows.groupKeys) : rows.all;
    const activeKey = isSession
      ? activeSessionId && `s:${activeSessionId}`
      : screen === "project" && activeProjectId && `g:${activeProjectId}`;
    setMarks((m) => {
      const seeded =
        m.keys.length === 0 && activeKey && activeKey !== key && order.includes(activeKey)
          ? { keys: [activeKey], anchor: activeKey }
          : m;
      return markClick(seeded, order, key, mods);
    });
  };

  const markCount = marks.keys.length;
  const markedGroups = groups.filter((g) => marks.keys.includes(`g:${g.key}`));
  // Sabitlenenler gruplardan ayrı listelendiği için seçim hesabına onlar da katılır.
  const markedSessions = [...pinned, ...groups.flatMap((g) => g.items)].filter((s) =>
    marks.keys.includes(`s:${s.id}`),
  );

  // Seçim tek türdense menü ona göre konuşur; sohbet ve proje karışıksa "öğe" denir. Anahtarlar
  // değişken olarak taşınamıyor (t() sabit anahtar ister), bu yüzden metinler burada üretilir.
  const markLabels = (): { remove: string; confirm: string } => {
    const n = markCount;
    const onlyGroups = markedSessions.length === 0;
    if (markedGroups.length === 0)
      return {
        remove: t("sidebar.deleteSelectedChats", { n }),
        confirm: t("sidebar.confirmDeleteSelectedChats", { n }),
      };
    if (onlyGroups && markedGroups.every((g) => g.kind === "project"))
      return {
        remove: t("sidebar.deleteSelectedProjects", { n }),
        confirm: t("sidebar.confirmDeleteSelectedProjects", { n }),
      };
    if (onlyGroups && markedGroups.every((g) => g.kind === "folder"))
      return {
        remove: t("sidebar.deleteSelectedFolders", { n }),
        confirm: t("sidebar.confirmDeleteSelectedFolders", { n }),
      };
    return {
      remove: t("sidebar.deleteSelectedItems", { n }),
      confirm: t("sidebar.confirmDeleteSelectedItems", { n }),
    };
  };

  /**
   * Seçilenleri sil: sohbet tümden silinir, klasör listeden düşer ve oturumları arşive taşınır,
   * projede görevler Oturumlar altında kalır.
   */
  const removeMarked = async () => {
    const labels = markLabels();
    if (!(await askConfirm({ title: labels.remove, body: labels.confirm, danger: true }))) return;
    // Açık sohbet silinenler arasındaysa store silinmeyen komşuya ya da ana ekrana geçer.
    await removeSessions(markedSessions.map((s) => s.id));
    for (const g of markedGroups) {
      if (g.kind === "folder") {
        await archiveFolder(g.path, mode);
        await forgetFolder(g.path);
      } else if (g.kind === "project") await deleteProject(g.projectId);
    }
    setMarks(noMarks);
    // Açık proje silindiyse ekran boşa düşmesin.
    if (markedGroups.some((g) => g.kind === "project" && g.projectId === activeProjectId))
      setMode("asistan");
  };

  const bulkItems: MenuEntry[] =
    markCount > 1
      ? [
          { label: t("sidebar.selectedCount", { n: markCount }), isLabel: true },
          { label: t("sidebar.clearSelection"), icon: "x", onSelect: () => setMarks(noMarks) },
          {
            label: markLabels().remove,
            icon: "trash",
            danger: true,
            top: true,
            onSelect: () => void removeMarked(),
          },
        ]
      : [];

  /** Satırın seçim durumu ve işlemleri; JSX'te her satır için üretilir. */
  const rowMarks = (key: string): RowMarks => {
    const marked = marks.keys.includes(key);
    return {
      marked,
      bulkItems: marked && bulkItems.length > 0 ? bulkItems : null,
      mark: (mods) => markRow(key, mods),
      clear: () => setMarks((m) => (m.keys.length === 0 ? m : noMarks)),
    };
  };

  const newProject = async () => {
    const name = await askText({
      title: t("sidebar.newProject"),
      placeholder: t("sidebar.newProjectPlaceholder"),
      okLabel: t("sidebar.create"),
    });
    if (name) openProject(await createProject(name));
  };

  return (
    <SlidePane
      open={sidebarOpen}
      width={sidebarWidth}
      handle={
        <Resizer
          side="right"
          sign={1}
          value={sidebarWidth}
          min={200}
          max={420}
          onChange={setSidebarWidth}
        />
      }
    >
      <aside className="flex h-full flex-col border-r border-line bg-bg2">
        <div className="h-[34px] shrink-0 [-webkit-app-region:drag]" />
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Kip sekmeleri: iki kip aynı anda görünmez, bu yüzden tek parça bölmeli düğme. */}
          <div className="px-[10px] pt-[10px]">
            <div className="flex rounded-[9px] bg-chip p-[3px]">
              {NAV.map((n) => (
                <button
                  type="button"
                  key={n.mode}
                  aria-pressed={mode === n.mode}
                  onClick={() => setMode(n.mode)}
                  className={`flex min-w-0 flex-1 items-center justify-center gap-[7px] rounded-[7px] px-2 py-[5px] text-[13px] ${
                    mode === n.mode ? "bg-sel text-tx shadow-sel" : "text-tx2 hover:text-tx"
                  }`}
                >
                  <Icon name={n.icon} size={14} stroke={1.6} className="shrink-0" />
                  <span className="truncate">{t(n.labelKey)}</span>
                </button>
              ))}
            </div>
          </div>
          {/* Yeni düğmesi etkin kipin ana ekranını açar; ana ekrandayken seçili görünür. */}
          {/* Klasör/proje ekleme "Projeler" etiketinden buraya taşındı: etiket kalktı, her proje
              kendi bölüm etiketi oldu. */}
          {/* Üst gezinme satırları oturum satırlarıyla aynı ölçekte: liste başlığı gibi değil, liste
              öğesi gibi dururlar. */}
          <div className="flex flex-col gap-[2px] px-[10px] pt-[10px] pb-[6px]">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={goHome}
                className={`flex min-w-0 flex-1 items-center gap-[9px] rounded-[7px] px-[10px] py-[5px] text-[13px] text-tx ${
                  screen === "home" ? "bg-sel shadow-sel" : "hover:bg-selHov"
                }`}
              >
                <Icon name="plus" size={14} stroke={1.6} className="text-tx2" />
                {t("sidebar.new")}
                <span className="flex-1" />
                <span aria-hidden className="text-[11px] text-tx3">
                  {newTaskKey}
                </span>
              </button>
              <button
                type="button"
                onClick={() => (mode === "asistan" ? void newProject() : void pick())}
                title={mode === "asistan" ? t("sidebar.newProject") : t("sidebar.addFolder")}
                aria-label={mode === "asistan" ? t("sidebar.newProject") : t("sidebar.addFolder")}
                className="flex h-[29px] w-[29px] shrink-0 items-center justify-center rounded-[7px] text-tx2 hover:bg-selHov hover:text-tx"
              >
                <Icon name="folderPlus" size={14} stroke={1.6} />
              </button>
            </div>
            {/* Zamanlanmış görevler projeden bağımsızdır; Asistan kipinde kendi sayfası var. */}
            {mode === "asistan" ? (
              <button
                type="button"
                onClick={openScheduled}
                aria-current={screen === "scheduled" ? "page" : undefined}
                className={`flex w-full min-w-0 items-center gap-[9px] rounded-[7px] px-[10px] py-[5px] text-[13px] text-tx ${
                  screen === "scheduled" ? "bg-sel shadow-sel" : "hover:bg-selHov"
                }`}
              >
                <Icon name="clock" size={14} stroke={1.6} className="text-tx2" />
                {t("sidebar.navScheduled")}
                <span className="flex-1" />
                {scheduledCount > 0 ? (
                  <span className="text-[11px] text-tx3 tabular-nums">{scheduledCount}</span>
                ) : null}
              </button>
            ) : null}
          </div>
          <div
            className="min-h-0 flex-1 overflow-y-auto px-[10px] py-2"
            // Listenin boşluğuna tıklamak seçimi bırakır.
            onClick={(e) => {
              if (e.target === e.currentTarget) setMarks(noMarks);
            }}
          >
            {pinned.length > 0 ? (
              <div className="pb-3">
                <PinnedHeader
                  open={!closed[PINNED_KEY]}
                  onToggle={() => setClosed({ ...closed, [PINNED_KEY]: !closed[PINNED_KEY] })}
                />
                {!closed[PINNED_KEY] ? (
                  <div className="flex flex-col gap-[2px] pt-[2px]">
                    <LimitedSessions
                      items={pinned}
                      expanded={showAll[PINNED_KEY] === true}
                      activeSessionId={activeSessionId}
                      rowMarks={rowMarks}
                      onToggle={() =>
                        setShowAll({
                          ...showAll,
                          [PINNED_KEY]: !(showAll[PINNED_KEY] === true),
                        })
                      }
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
            {/* Açılış yüklemesi düştüyse boş liste "proje yok" demez: kısa hata + yeniden dene. */}
            {startup === "error" ? (
              <div className="flex flex-col gap-1 px-2 py-3" title={startupError ?? undefined}>
                <ErrorText text={t("sidebar.loadFailed")} />
                <button
                  type="button"
                  onClick={() => void retryStartup()}
                  className="self-start pl-[21px] text-[12px] text-tx3 transition-colors hover:text-tx"
                >
                  {t("common.retry")}
                </button>
              </div>
            ) : null}
            {/* Asistan'da gruplar boş olabilir (oturumsuz projeler gizli); orada kendi metni var.
                Boş durum metni yalnız liste gerçekten yüklendiyse çıkar. */}
            {startup === "ready" && mode !== "asistan" && groups.length === 0 ? (
              <div className="px-2 py-3 text-[12px] leading-[1.5] text-tx3">
                {t("sidebar.noProjects")}
              </div>
            ) : null}
            {startup === "ready" && mode === "asistan" && projects.length === 0 ? (
              <div className="px-2 pt-1 pb-3 text-[12px] leading-[1.5] text-tx3">
                {t("sidebar.noAssistantProjects")}
              </div>
            ) : null}
            {groups.map((g) => {
              const open = !closed[g.key];
              const active =
                g.kind === "project" && screen === "project" && activeProjectId === g.projectId;
              // Sürükleme yalnız klasör/proje satırlarında; anahtar sıralamanın kimliğidir.
              const key = g.kind === "project" ? g.projectId : g.kind === "folder" ? g.path : "";
              const drag = g.kind !== "loose";
              const index = sortableKeys.indexOf(key);
              return (
                // Grup altına 12px: başlık kendi grubuna yapışır, önceki gruptan ayrılır.
                <div key={g.key} className="pb-3">
                  <GroupRow
                    g={g}
                    open={open}
                    active={active}
                    sel={rowMarks(`g:${g.key}`)}
                    drag={drag}
                    dragging={drag && dragKey === key}
                    hint={dropHint?.key === key ? (dropHint.after ? "after" : "before") : null}
                    canMoveUp={drag && index > 0}
                    canMoveDown={drag && index >= 0 && index < sortableKeys.length - 1}
                    onMove={(dir) => moveGroup(key, dir)}
                    onToggle={() => setClosed({ ...closed, [g.key]: open })}
                    onDragStart={(e) => {
                      setDragKey(key);
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", key);
                    }}
                    onDragOver={(e) => {
                      // Bırakılamayan satır ("Oturumlar") ya da sürüklenenin kendisi hedef değil.
                      if (!drag || !dragKey || dragKey === key) {
                        setDropHint(null);
                        return;
                      }
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      const after = dropAfter(e.currentTarget.getBoundingClientRect(), e.clientY);
                      setDropHint((h) =>
                        h?.key === key && h.after === after ? h : { key, after },
                      );
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (!drag) return;
                      dropGroup(key, dropAfter(e.currentTarget.getBoundingClientRect(), e.clientY));
                    }}
                    onDragEnd={() => {
                      setDragKey(null);
                      setDropHint(null);
                    }}
                  />
                  {open ? (
                    <div className="flex flex-col gap-[2px] pt-[2px]">
                      <LimitedSessions
                        items={g.items}
                        expanded={showAll[g.key] === true}
                        activeSessionId={activeSessionId}
                        rowMarks={rowMarks}
                        onToggle={() =>
                          setShowAll({ ...showAll, [g.key]: !(showAll[g.key] === true) })
                        }
                      />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </aside>
    </SlidePane>
  );
}
