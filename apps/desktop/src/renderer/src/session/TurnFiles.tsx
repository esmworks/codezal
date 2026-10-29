import type { ToolCallItem } from "@codezal/contracts";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../api";
import { askConfirm } from "../components/Confirm";
import { copyWithToast } from "../components/CopyButton";
import { FlipNumber } from "../components/FlipNumber";
import { Icon } from "../components/Icon";
import { FileTypeIcon } from "../lib/fileIcons";
import { docCards, docKind, shortPath, type TurnFile, turnFiles } from "../lib/turnFiles";
import { useMenu } from "../stores/menu";
import { usePaths } from "../stores/paths";
import { humanizeError, toast } from "../stores/toast";
import { DiffLines, TailText } from "./ToolCard";

export { shortPath };

/** Çıktıda gerçek diff satırı var mı (+++/--- başlıkları hariç). */
function hasDiff(output: string): boolean {
  return output.split("\n").some((l) => /^[+-](?![+-]{2})/.test(l));
}

function OpenButton({
  path,
  onOpen,
  always = false,
}: {
  path: string;
  onOpen: ((p: string) => void) | undefined;
  /** Belge kartında düğme hep görünür; liste satırında yalnız üzerine gelince. */
  always?: boolean;
}) {
  const { t } = useTranslation();
  const openAt = useMenu((s) => s.openAt);
  const menu = (e: React.MouseEvent) => {
    e.stopPropagation();
    openAt(e.currentTarget as HTMLElement, {
      items: [
        {
          label: t("files.reveal"),
          icon: "folder",
          onSelect: () => void invoke("files:reveal", { path }),
        },
        {
          label: t("turnFiles.openInApp"),
          icon: "export",
          onSelect: () => void invoke("files:openExternal", { path }),
        },
        {
          label: t("files.copyPath"),
          icon: "copyDoc",
          onSelect: () => copyWithToast(path),
        },
      ],
    });
  };
  return (
    <span
      className={`flex h-7 shrink-0 items-center overflow-hidden rounded-lg border border-line text-[14px] ${always ? "bg-bg" : "opacity-0 focus-within:opacity-100 group-hover:opacity-100"}`}
    >
      <button
        type="button"
        onClick={() => (onOpen ? onOpen(path) : void invoke("files:openExternal", { path }))}
        className="h-full px-2 hover:bg-hov"
      >
        {t("common.open")}
      </button>
      <button
        type="button"
        onClick={menu}
        className="h-full border-l border-line px-1.5 text-tx3 hover:bg-hov hover:text-tx"
      >
        <Icon name="chevronDown" size={11} stroke={2} />
      </button>
    </span>
  );
}

function ChangedRow({
  file,
  label,
  cwd,
  home,
  onOpen,
}: {
  file: TurnFile;
  label: string;
  cwd: string;
  home: string;
  onOpen: ((p: string) => void) | undefined;
}) {
  const { t } = useTranslation();
  const [review, setReview] = useState(false);
  const plansDir = usePaths((s) => s.plansDir);
  const deleted = file.kind === "delete";
  // Plan modunda yazılan plan (userData/plans): uzun yol yerine "Plan dosyası", projeye kaydedilebilir.
  // Ayraç karşılaştırması platformdan bağımsız: Windows'ta `plansDir` `\` taşır ve `/` ile
  // aranan ön ek hiç tutmazdı (plan satırı "Plan dosyası" ve "Projeye kaydet" olmadan çizilirdi).
  const isPlan =
    plansDir !== "" &&
    (file.path.startsWith(`${plansDir}/`) || file.path.startsWith(`${plansDir}\\`));
  // Etiket dosya adıyla bitiyorsa yalnızca klasör kısmı gösterilir; ad zaten solda.
  const dir = isPlan
    ? t("turnFiles.plan")
    : label.endsWith(`/${file.name}`)
      ? label.slice(0, -file.name.length - 1)
      : label;
  const saveToProject = async () => {
    try {
      const target = await invoke("plans:saveToProject", { path: file.path, cwd });
      toast.success(t("turnFiles.savedToProject", { path: shortPath(target, cwd, home) }));
    } catch (error) {
      toast.error(humanizeError(error));
    }
  };
  return (
    <div className="flex flex-col">
      <div className="group flex items-center gap-2 px-2 py-2">
        <FileTypeIcon name={file.name} size={15} />
        <span
          className={`shrink-0 text-[14px] font-medium ${deleted ? "text-tx3 line-through" : "text-tx"}`}
        >
          {file.name}
        </span>
        {dir && dir !== file.name ? (
          <TailText text={dir} className="text-[14px] text-tx3" />
        ) : (
          <span className="flex-1" />
        )}
        {deleted ? (
          <span className="shrink-0 text-[14px] text-red">{t("turnFiles.deleted")}</span>
        ) : file.add || file.del ? (
          // Dosya sayacı tur boyunca büyür (aynı dosya yeniden düzenlenir); rakamlar çevrilerek
          // tazelenir, satır kaymaz.
          <span className="shrink-0 text-[14px] tabular-nums">
            {file.add ? (
              <span className="text-green">
                +<FlipNumber value={file.add} />
              </span>
            ) : (
              ""
            )}
            {file.add && file.del ? " " : ""}
            {file.del ? (
              <span className="text-red">
                −<FlipNumber value={file.del} />
              </span>
            ) : (
              ""
            )}
          </span>
        ) : file.kind === "create" ? (
          <span className="shrink-0 text-[14px] text-green">{t("turnFiles.new")}</span>
        ) : null}
        {isPlan && !deleted ? (
          <button
            type="button"
            onClick={() => void saveToProject()}
            className="h-7 shrink-0 rounded-lg border border-line px-2 text-[14px] hover:bg-hov"
          >
            {t("turnFiles.saveToProject")}
          </button>
        ) : null}
        {hasDiff(file.output) ? (
          <button
            type="button"
            onClick={() => setReview((v) => !v)}
            className={`h-7 shrink-0 rounded-lg border border-line px-2 text-[14px] hover:bg-hov ${review ? "bg-sel" : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100"}`}
          >
            {t("turnFiles.review")}
          </button>
        ) : null}
        {deleted ? null : <OpenButton path={file.path} onOpen={onOpen} />}
      </div>
      {review ? (
        <div className="border-t border-line bg-bg">
          <DiffLines
            output={file.output}
            kind={file.kind}
            empty={t("tool.noOutput")}
            path={file.path}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * ZCode ve Claude'daki tur sonu belge kartı: simge, dosya adı, "Belge · MD" ve her zaman görünen
 * Aç düğmesi. Kartlar diskte hâlâ duran dosyalar için çizilir; yoklama bitene kadar hiçbir şey
 * çizilmez ki sonradan silinmiş dosyanın kartı bir an görünüp kaybolmasın.
 */
function DocCards({
  files,
  onOpen,
}: {
  files: TurnFile[];
  onOpen: ((path: string) => void) | undefined;
}) {
  const { t } = useTranslation();
  const key = files.map((f) => f.path).join("\0");
  const [exists, setExists] = useState<{ key: string; paths: Set<string> } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `files` yerine yol anahtarı bağımlılıktır
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const paths = files.map((f) => f.path);
    invoke("files:exists", { paths })
      .then((found) => {
        if (alive) setExists({ key, paths: new Set(paths.filter((_, i) => found[i])) });
      })
      // Yoklama başarısızsa kart gizlenmez: Aç zaten hatayı bildirir.
      .catch(() => {
        if (alive) setExists({ key, paths: new Set(paths) });
      });
    return () => {
      alive = false;
    };
  }, [key]);
  if (exists?.key !== key) return null;
  const shown = files.filter((f) => exists.paths.has(f.path));
  if (shown.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {shown.map((f) => {
        const kind = docKind(f.name);
        return (
          <div
            key={f.path}
            className="flex items-center gap-3 rounded-xl border border-line bg-card p-3 pr-4"
          >
            <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-bg">
              <FileTypeIcon name={f.name} size={24} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-[14px] font-medium text-tx" title={f.path}>
                {f.name}
              </span>
              <span className="truncate text-[12px] text-tx3">
                {kind ? `${t(kind.key)} · ${kind.ext}` : ""}
              </span>
            </span>
            <OpenButton path={f.path} onOpen={onOpen} always />
          </div>
        );
      })}
    </div>
  );
}

/**
 * Tur altı dosya özeti: bu turda oluşan belgeler kart olarak (`DocCards`), oluşturulan ve
 * değişen bütün dosyalar da tek katlanabilir "N dosya değişti" listesinde (ad, klasör, +/-,
 * İncele, Aç).
 */
export function TurnFiles({
  tools,
  text,
  cwd,
  home,
  onOpen,
  onUndo,
}: {
  tools: ToolCallItem[];
  /** Turun son mesajı: düzenlenen belge yalnız burada adı geçiyorsa kart olur. */
  text: string;
  cwd: string;
  home: string;
  onOpen?: ((path: string) => void) | undefined;
  /**
   * Verilirse "Geri al": turun dosya değişikliklerini (yazma araçları, terminal komutları, aynı
   * klasörde çalışan alt ajanlar) tur öncesi yedeğinden döndürür.
   */
  onUndo?:
    | (() => Promise<{
        restored: string[];
        removed: string[];
        skipped?: string[];
        partial?: boolean;
        outside?: string[];
      }>)
    | undefined;
}) {
  const { t } = useTranslation();
  const files = useMemo(() => turnFiles(tools, cwd), [tools, cwd]);
  const docs = useMemo(() => docCards(files, text), [files, text]);
  const { changed } = files;
  // Kapalı gelir: liste uzun olabiliyor; isteyen başlığa tıklayıp açar.
  const [open, setOpen] = useState(false);
  const [undoing, setUndoing] = useState(false);
  if (changed.length === 0) return null;
  const add = changed.reduce((n, f) => n + f.add, 0);
  const del = changed.reduce((n, f) => n + f.del, 0);
  const undo = async () => {
    if (!onUndo) return;
    const ok = await askConfirm({
      title: t("turnFiles.undo"),
      body: t("turnFiles.undoConfirm", { count: changed.length }),
      okLabel: t("turnFiles.undo"),
      danger: true,
    });
    if (!ok) return;
    setUndoing(true);
    try {
      const r = await onUndo();
      const count = r.restored.length + r.removed.length;
      toast.success(t("turnFiles.undone", { count }));
      // Yedeklenemeyen (boyut sınırı) dosyalar sessizce atlanmaz: kullanıcı "geri alındı"
      // mesajını görüp o dosyanın değişmiş hâlini farkında olmadan bırakmasın.
      if (r.skipped && r.skipped.length > 0) {
        toast.info(t("turnFiles.undoSkipped", { count: r.skipped.length }));
      }
      // Tur yedeği eksikse (büyük klasörde terminal komutu) kullanıcı her şeyin döndüğünü sanmasın.
      if (r.partial) toast.info(t("turnFiles.undoPartial"));
      // Alt klasör oturumunda klasör dışına yapılan değişiklikler kapsam dışı; sessiz kalmasın.
      if (r.outside && r.outside.length > 0) {
        toast.info(t("turnFiles.undoOutside", { count: r.outside.length }));
      }
    } catch (error) {
      toast.error(humanizeError(error));
    } finally {
      setUndoing(false);
    }
  };

  return (
    <>
      <DocCards files={docs} onOpen={onOpen} />
      <div className="overflow-hidden rounded-xl border border-line bg-card">
        {/* Başlık iki düğme: soldaki katlar, sağdaki geri alır; iç içe düğme olmasın diye kardeşler. */}
        {/* ZCode'un dosya özeti kartı: 40px başlık şeridi, solda ok, sağda +/− toplamı ve eylemler. */}
        <div className="flex h-10 items-center gap-2 pr-2 text-[14px]">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex h-full min-w-0 flex-1 items-center gap-2 px-2 text-left hover:bg-hov"
          >
            {/* Ok, satırlardakiyle aynı dil: sağa bakar, açılınca 90° döner. */}
            <Icon
              name="chevronRight"
              size={14}
              stroke={2}
              className={`shrink-0 text-tx3 transition-transform ${open ? "rotate-90" : ""}`}
            />
            <span className="min-w-0 truncate font-medium">
              {t("turnFiles.changedCount", { count: changed.length })}
            </span>
            {add || del ? (
              <span className="shrink-0 text-[14px] tabular-nums">
                <span className="text-green">
                  +<FlipNumber value={add} />
                </span>{" "}
                <span className="text-red">
                  −<FlipNumber value={del} />
                </span>
              </span>
            ) : null}
          </button>
          {onUndo ? (
            <button
              type="button"
              disabled={undoing}
              title={t("turnFiles.undoTitle")}
              onClick={() => void undo()}
              className="h-7 shrink-0 rounded-lg border border-line px-2 text-[14px] text-tx3 hover:bg-hov hover:text-tx disabled:opacity-50"
            >
              {t("turnFiles.undo")}
            </button>
          ) : null}
        </div>
        {open ? (
          <div className="flex flex-col divide-y divide-line border-t border-line">
            {changed.map((f) => (
              <ChangedRow
                key={f.path}
                file={f}
                label={shortPath(f.path, cwd, home)}
                cwd={cwd}
                home={home}
                onOpen={onOpen}
              />
            ))}
          </div>
        ) : null}
      </div>
    </>
  );
}
