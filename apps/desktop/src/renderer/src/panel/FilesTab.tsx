import type { FileBadge, FileContent, FileNode } from "@codezal/contracts";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke, on } from "../api";
import { CodeView } from "../components/CodeView";
import { copyWithToast } from "../components/CopyButton";
import { FilePreview } from "../components/FilePreview";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { askText } from "../components/Prompt";
import { Resizer } from "../components/Resizer";
import { FileTypeIcon } from "../lib/fileIcons";
import { basename } from "../lib/format";
import { langForPath } from "../lib/highlight";
import { useMenu } from "../stores/menu";
import { useOpenFile, usePanel } from "../stores/panel";

/**
 * Ağaçta derinlik başına girinti. Satırın ilk yuvası (ok ya da dosya simgesi) 16px; 14px
 * girintide çocuğun simgesi ebeveynin adının başlangıcına hizalanır.
 */
const INDENT = 14;
/**
 * Ağaç, arama sonucu ve son kullanılan satırlarının ortak ölçüsü. `cursor-default select-none`:
 * ağaç satırı `div`; metnin üstünde tarayıcı I imlecini gösteriyor, çift tıkta ad seçiliyordu.
 */
const ROW =
  "flex h-[26px] w-full cursor-default select-none items-center gap-[6px] rounded-[6px] pr-2 text-left text-[13px]";
/**
 * Seçili satır zemini. `bg-sel` açık temada beyaz: panel de beyaz olduğu için seçim hiç
 * görünmüyordu. Çizgi tonu iki temada da üzerine gelmeden (`bg-hov`) belirgin.
 */
const SELECTED = "bg-line text-tx";

/** Proje köküne göre üst klasör yolu; kökteki dosya için boş. */
function parentOf(cwd: string, path: string): string {
  const rel = path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
  const cut = rel.lastIndexOf("/");
  return cut < 0 ? "" : rel.slice(0, cut);
}

/**
 * Git durumu: dosyada harf, klasörde nokta. Klasör yalnız "içinde değişiklik var" der; türü
 * dosyada okunur (VS Code'daki gibi). İzlenmeyen dosya eklenmiş sayılır.
 */
function GitBadge({ badge, dir }: { badge: FileBadge; dir: boolean }) {
  const tone =
    badge === "A" || badge === "?" ? "text-green" : badge === "D" ? "text-red" : "text-amber";
  return (
    <span className={`flex w-3 shrink-0 items-center justify-center ${tone}`}>
      {dir ? (
        <span className="h-[6px] w-[6px] rounded-full bg-current" />
      ) : (
        <span className="font-semibold text-[11px]">{badge === "?" ? "A" : badge}</span>
      )}
    </span>
  );
}

function Tree({
  root,
  dir,
  depth,
  onOpen,
  onMenu,
  version,
}: {
  root: string;
  dir: string;
  depth: number;
  onOpen: (path: string) => void;
  onMenu: (e: React.MouseEvent, node: FileNode) => void;
  version: number;
}) {
  const [nodes, setNodes] = useState<FileNode[]>([]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const openFile = useOpenFile(root);

  // biome-ignore lint/correctness/useExhaustiveDependencies: version git değişince yeniden listeler
  useEffect(() => {
    let alive = true;
    invoke("files:list", { root, dir })
      .then((n) => alive && setNodes(n))
      .catch(() => alive && setNodes([]));
    return () => {
      alive = false;
    };
  }, [root, dir, version]);

  return (
    <>
      {nodes.map((n) => {
        const isDir = n.kind === "dir";
        const isOpen = !!open[n.path];
        return (
          <div key={n.path}>
            <div
              onClick={() => (isDir ? setOpen({ ...open, [n.path]: !isOpen }) : onOpen(n.path))}
              onContextMenu={(e) => onMenu(e, n)}
              title={n.name}
              className={`${ROW} ${openFile === n.path ? SELECTED : "text-tx hover:bg-hov"}`}
              style={{ paddingLeft: 4 + depth * INDENT }}
            >
              {/* Klasörde yalnız ok var, dosyada tür simgesi aynı yuvaya oturur: kök seviyesindeki
                  dosyalar klasör oklarıyla aynı sütunda başlar, ağaçta boş sütun kalmaz. */}
              <span className="flex w-4 shrink-0 items-center justify-center">
                {isDir ? (
                  <Icon
                    name="chevronRight"
                    size={12}
                    stroke={2}
                    className="text-tx3 transition-transform duration-150"
                    style={{ transform: isOpen ? "rotate(90deg)" : undefined }}
                  />
                ) : (
                  <FileTypeIcon name={n.name} mono />
                )}
              </span>
              <span className="min-w-0 flex-1 truncate">{n.name}</span>
              {n.badge ? <GitBadge badge={n.badge} dir={isDir} /> : null}
            </div>
            {isDir && isOpen ? (
              <Tree
                root={root}
                dir={n.path}
                depth={depth + 1}
                onOpen={onOpen}
                onMenu={onMenu}
                version={version}
              />
            ) : null}
          </div>
        );
      })}
    </>
  );
}

/** Dosyalar sekmesi: ağaç, son kullanılanlar, salt okunur görüntüleyici, arama (TODO 2). */
export function FilesTab({ cwd }: { cwd: string }) {
  const { t } = useTranslation();
  const { treeWidth, setTreeWidth, setOpenFile, recentFiles } = usePanel();
  // Açık dosya proje köküne bağlı: proje değişince eski projenin dosyası görünmez.
  const openFile = useOpenFile(cwd);
  const openAt = useMenu((s) => s.openAt);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FileNode[]>([]);
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState(false);
  const [version, setVersion] = useState(0);
  // Markdown dosyaları önizleme olarak açılır; kaynak görünümü dosya başına geçici seçimdir.
  const [showSource, setShowSource] = useState(false);
  const isMarkdown = /\.(md|markdown|mdx)$/i.test(openFile ?? "");

  useEffect(() => on("git:changed", () => setVersion((v) => v + 1)), []);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    // Sorgu kimliği: yavaş bir sorgu sonrakinin sonucunu ezmesin (kullanıcı "config" yazarken
    // "conf" sonuçları görünmesin). Bayrak efekt kapsamında tutulur; zamanlayıcı iptal edilse de
    // uçuştaki istek sonucu yazmaz.
    let current = true;
    const t = setTimeout(() => {
      invoke("files:search", { root: cwd, query })
        .then((r) => {
          if (current) setResults(r);
        })
        .catch(() => {
          if (current) setResults([]);
        });
    }, 180);
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [query, cwd]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: version dosya değişince yeniden okur
  useEffect(() => {
    setShowSource(false);
    setError(false);
    if (!openFile) {
      setFile(null);
      return;
    }
    // İstek kimliği: hızlı dosya geçişinde geç dönen okuma, yeni dosyanın içeriğinin yerine
    // yazılıyordu (başlık B, içerik A).
    let current = true;
    invoke("files:read", { path: openFile })
      .then((f) => {
        if (!current) return;
        setFile(f);
        setError(false);
      })
      .catch(() => {
        if (!current) return;
        setFile(null);
        setError(true);
      });
    return () => {
      current = false;
    };
  }, [openFile, version]);

  const openPath = useCallback((path: string) => setOpenFile(cwd, path), [cwd, setOpenFile]);

  const newFile = async () => {
    const name = await askText({
      title: t("files.newFileTitle"),
      initial: "yeni.md",
    });
    if (!name) return;
    const path = `${cwd}/${name}`;
    await invoke("files:create", { path });
    setVersion((v) => v + 1);
    setOpenFile(cwd, path);
  };

  const fileMenu = (e: React.MouseEvent) => {
    if (!openFile) return;
    openAt(e.currentTarget as HTMLElement, {
      items: [
        {
          label: t("files.openExternal"),
          icon: "export",
          onSelect: () => void invoke("files:openExternal", { path: openFile }),
        },
        {
          label: t("files.reveal"),
          icon: "folder",
          onSelect: () => void invoke("files:reveal", { path: openFile }),
        },
        {
          label: t("files.copyPath"),
          icon: "copy",
          onSelect: () => copyWithToast(openFile),
        },
      ],
    });
  };

  // Ağaç ve arama satırlarının sağ tık menüsü; menü imlecin olduğu yerde açılır.
  const rowMenu = (e: React.MouseEvent, node: FileNode) => {
    e.preventDefault();
    const isFile = node.kind === "file";
    const rel = node.path.startsWith(`${cwd}/`) ? node.path.slice(cwd.length + 1) : node.path;
    openAt(
      { x: e.clientX, y: e.clientY },
      {
        items: [
          ...(isFile
            ? [
                {
                  label: t("files.open"),
                  icon: "file" as const,
                  onSelect: () => openPath(node.path),
                },
                {
                  label: t("files.openExternal"),
                  icon: "export" as const,
                  onSelect: () => void invoke("files:openExternal", { path: node.path }),
                },
              ]
            : []),
          {
            label: t("files.reveal"),
            icon: "folder",
            onSelect: () => void invoke("files:reveal", { path: node.path }),
          },
          {
            label: t("files.copyPath"),
            icon: "copy",
            top: true,
            onSelect: () => copyWithToast(node.path),
          },
          {
            label: t("files.copyRelativePath"),
            icon: "copy",
            onSelect: () => copyWithToast(rel),
          },
        ],
      },
    );
  };

  // Ayraç şart: `/Users/x/app` ön eki `/Users/x/app-old/...` dosyasını da bu projeye ait
  // sayıyor ve "son kullanılan" listesine yabancı dosya düşürüyordu.
  const recent = recentFiles.filter((f) => f.startsWith(`${cwd}/`));
  const openName = openFile ? basename(openFile) : "";
  const openDir = openFile ? parentOf(cwd, openFile) : "";
  const iconBtn =
    "flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] text-tx3 hover:bg-hov hover:text-tx disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-tx3";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-[6px] px-[10px] pb-[9px]">
        <button
          type="button"
          disabled={!openFile}
          onClick={() => setOpenFile(cwd, null)}
          className={iconBtn}
        >
          <Icon name="chevronLeft" size={14} stroke={1.9} />
        </button>
        {/* Yol kırıntısı: klasör soluk, dosya adı belirgin. Dar panelde önce klasör kısalır. */}
        <div className="flex min-w-0 flex-1 items-center gap-[7px] text-[12.5px]">
          {openFile ? (
            <>
              <FileTypeIcon name={openName} size={13} mono />
              <span className="flex min-w-0">
                {openDir ? (
                  <span className="min-w-0 shrink-[1000] truncate text-tx3">{openDir}/</span>
                ) : null}
                <span className="min-w-0 truncate text-tx">{openName}</span>
              </span>
            </>
          ) : (
            <span className="truncate text-tx2">{basename(cwd)}</span>
          )}
        </div>
        {isMarkdown ? (
          <button
            type="button"
            onClick={() => setShowSource((v) => !v)}
            title={showSource ? t("files.preview") : t("files.source")}
            className={`${iconBtn} ${showSource ? "bg-sel text-tx" : ""}`}
          >
            <Icon name={showSource ? "eye" : "code"} size={14} stroke={1.8} />
          </button>
        ) : null}
        <button type="button" onClick={fileMenu} disabled={!openFile} className={iconBtn}>
          <Icon name="menuLines" size={14} />
        </button>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 border-t border-line">
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          {openFile ? (
            error ? (
              <div className="p-[14px] text-[13px] text-tx3">{t("viewer.unreadable")}</div>
            ) : file ? (
              file.binary ? (
                <div className="flex min-h-0 flex-1 flex-col">
                  <FilePreview file={file} version={version} />
                </div>
              ) : isMarkdown && !showSource ? (
                <div className="max-w-[760px] px-5 py-[18px]">
                  <Markdown text={file.content} document />
                  {file.truncated ? (
                    <div className="pt-3 text-[12px] text-tx3">{t("files.truncated")}</div>
                  ) : null}
                </div>
              ) : (
                <div className="overflow-auto">
                  <CodeView code={file.content} lang={langForPath(openFile)} lineNumbers />
                  {file.truncated ? (
                    <div className="px-3 py-2 text-[12px] text-tx3">{t("files.truncated")}</div>
                  ) : null}
                </div>
              )
            ) : (
              <div className="p-[14px] text-[13px] text-tx3">{t("common.loading")}</div>
            )
          ) : (
            <div className="flex flex-col gap-5 px-3 py-[14px]">
              <button
                type="button"
                onClick={() => void newFile()}
                className="flex h-8 items-center gap-2 self-start rounded-[8px] border border-line px-3 text-[13px] text-tx2 hover:border-line2 hover:text-tx"
              >
                <Icon name="filePlus" size={14} />
                {t("files.newFile")}
              </button>
              <div className="flex flex-col">
                <div className="px-2 pb-[6px] font-medium text-[11px] text-tx3 uppercase tracking-[0.06em]">
                  {t("files.recent")}
                </div>
                {recent.length === 0 ? (
                  <div className="px-2 py-1 text-[12.5px] text-tx3">{t("files.noRecent")}</div>
                ) : null}
                {recent.map((f) => (
                  <button
                    type="button"
                    key={f}
                    onClick={() => openPath(f)}
                    className={`${ROW} pl-2 text-tx hover:bg-hov`}
                  >
                    <FileTypeIcon name={basename(f)} mono />
                    <span className="min-w-0 truncate">{basename(f)}</span>
                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-tx3">
                      {parentOf(cwd, f) || t("files.root")}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div
          className="relative flex shrink-0 flex-col border-l border-line"
          style={{ width: treeWidth }}
        >
          <Resizer
            side="left"
            sign={-1}
            value={treeWidth}
            min={120}
            max={420}
            onChange={setTreeWidth}
          />
          {/* Arama ağacın üstünde: dosya açıkken de erişilir, sonuçlar ağacın yerini alır.
              Sağ dolgu = liste dolgusu + kaydırma çubuğu yuvası; kutu satırlarla aynı hizada biter. */}
          <div className="shrink-0 pt-2 pr-4 pb-[6px] pl-[6px]">
            <label className="flex h-7 items-center gap-[7px] rounded-[7px] border border-line px-2 text-tx3 focus-within:border-line2">
              <Icon name="search" size={13} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && query) {
                    e.preventDefault();
                    e.stopPropagation();
                    setQuery("");
                  }
                }}
                placeholder={t("files.searchPlaceholder")}
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-[12.5px] text-tx outline-none placeholder:text-tx3"
              />
            </label>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-[6px] pb-2 [scrollbar-gutter:stable]">
            {query.trim() ? (
              <>
                {results.length === 0 ? (
                  <div className="px-2 py-1 text-[12.5px] text-tx3">{t("files.noResults")}</div>
                ) : null}
                {results.map((r) => (
                  <button
                    type="button"
                    key={r.path}
                    onClick={() => (r.kind === "file" ? openPath(r.path) : undefined)}
                    onContextMenu={(e) => rowMenu(e, r)}
                    title={r.path.replace(`${cwd}/`, "")}
                    className={`${ROW} pl-1 ${
                      openFile === r.path ? SELECTED : "text-tx hover:bg-hov"
                    }`}
                  >
                    <span className="flex w-4 shrink-0 items-center justify-center">
                      {r.kind === "dir" ? (
                        <Icon name="folderClosed" size={14} className="text-tx3" />
                      ) : (
                        <FileTypeIcon name={r.name} mono />
                      )}
                    </span>
                    <span className="min-w-0 truncate">{r.name}</span>
                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-tx3">
                      {parentOf(cwd, r.path)}
                    </span>
                  </button>
                ))}
              </>
            ) : (
              <Tree
                root={cwd}
                dir={cwd}
                depth={0}
                onOpen={openPath}
                onMenu={rowMenu}
                version={version}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
