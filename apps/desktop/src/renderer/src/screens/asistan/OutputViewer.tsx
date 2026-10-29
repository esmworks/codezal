import { type FileContent, localFileUrl, previewKindFor } from "@codezal/contracts";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../../api";
import { CodeView } from "../../components/CodeView";
import { CopyButton } from "../../components/CopyButton";
import { FilePreview } from "../../components/FilePreview";
import { Icon } from "../../components/Icon";
import { Markdown } from "../../components/Markdown";
import { Resizer } from "../../components/Resizer";
import type { IconName } from "../../icons";
import { langForPath } from "../../lib/highlight";
import type { TaskOutput } from "../../lib/outputs";
import { padRight } from "../../lib/platform";
import { reportError } from "../../stores/toast";

const MIN = 360;
const MAX = 960;
/** Başlıktaki ikon düğmeleri; sürükleme alanının dışında kalır. */
const TOOL_BTN =
  "flex h-7 w-7 items-center justify-center rounded-[7px] [-webkit-app-region:no-drag] hover:bg-hov hover:text-tx";

/**
 * Görev çıktısı yan görüntüleyicisi: sağ panelin yerine açılır. Markdown ve HTML önizleme /
 * kaynak geçişi, Farklı kaydet, Finder'da göster, tam ekran ve kapat.
 */
export function OutputViewer({
  output,
  fullscreen,
  onToggleFullscreen,
  onClose,
}: {
  output: TaskOutput;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [width, setWidth] = useState(560);
  const [file, setFile] = useState<FileContent | null>(null);
  const [showSource, setShowSource] = useState(false);
  const isMarkdown = /\.(md|markdown|mdx)$/i.test(output.path);
  const kind = previewKindFor(output.path);
  const isHtml = kind === "html";
  const ext = output.name.split(".").pop()?.toUpperCase() ?? "";
  const title = output.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");

  // Dosya yolu ya da son yazım zamanı değişince yeniden okunur; yazım sürerken kısa aralıkla yenilenir.
  // biome-ignore lint/correctness/useExhaustiveDependencies: output.at aynı dosyanın yeniden yazımını yakalar
  useEffect(() => {
    let cancelled = false;
    const read = () =>
      invoke("files:read", { path: output.path })
        .then((f) => {
          if (!cancelled) setFile(f);
        })
        .catch(() => {
          if (!cancelled) setFile(null);
        });
    void read();
    // Önizlenen ikili (PDF, görsel) `codezal-file://` üzerinden ayrıca çekiliyor ve `files:read`
    // içeriğini vermiyor; yazım sürerken onu yoklamak aynı dosyayı boşuna ikinci kez okumaktı.
    // HTML de şemadan çizilir ama kaynak görünümü `files:read` içeriğini kullanır; yoklanır.
    const binaryPreview = kind === "pdf" || kind === "image";
    const timer =
      output.running && !binaryPreview ? setInterval(() => void read(), 1500) : undefined;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [output.path, output.at, output.running]);

  const tool = (name: IconName, label: string, onClick: () => void, active = false) => (
    <button
      type="button"
      title={label}
      onClick={onClick}
      className={`${TOOL_BTN} ${active ? "bg-sel text-tx" : "text-tx3"}`}
    >
      <Icon name={name} size={15} stroke={1.8} />
    </button>
  );

  return (
    <div
      className={`relative flex min-w-0 flex-col border-l border-line bg-bg ${fullscreen ? "flex-1" : "shrink-0"}`}
      style={fullscreen ? undefined : { width: Math.max(MIN, Math.min(width, MAX)) }}
    >
      {fullscreen ? null : (
        <Resizer side="left" sign={-1} value={width} min={MIN} max={MAX} onChange={setWidth} />
      )}
      <header
        className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-3 [-webkit-app-region:drag]"
        style={{ paddingRight: padRight(12) }}
      >
        {isMarkdown || isHtml ? (
          <div className="mr-1 flex items-center rounded-[8px] border border-line p-[2px] [-webkit-app-region:no-drag]">
            {tool("eye", t("viewer.preview"), () => setShowSource(false), !showSource)}
            {tool("code", t("viewer.source"), () => setShowSource(true), showSource)}
          </div>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium">
          {title}
          <span className="font-normal text-tx3"> · {ext}</span>
        </span>
        <div className="flex items-center gap-[2px] [-webkit-app-region:no-drag]">
          {file && !file.binary ? (
            <CopyButton
              text={file.content}
              size={15}
              stroke={1.8}
              className={`${TOOL_BTN} text-tx3`}
            />
          ) : null}
          <button
            type="button"
            // Kaydetme/açma hatası (izin, silinmiş dosya) sessizce kaybolmasın.
            onClick={() => void invoke("files:saveCopy", { path: output.path }).catch(reportError)}
            className="mx-1 flex h-7 items-center gap-[6px] rounded-[7px] border border-line px-[9px] text-[13px] text-tx hover:bg-hov"
          >
            <Icon name="down" size={14} stroke={1.8} />
            {t("viewer.saveCopy")}
          </button>
          {tool(
            "folder",
            t("files.reveal"),
            () => void invoke("files:reveal", { path: output.path }).catch(reportError),
          )}
          {tool(
            "export",
            t("turnFiles.openInApp"),
            () => void invoke("files:openExternal", { path: output.path }).catch(reportError),
          )}
          {tool(
            fullscreen ? "collapse" : "expand",
            fullscreen ? t("panel.collapse") : t("panel.expand"),
            onToggleFullscreen,
          )}
          {tool("x", t("common.close"), onClose)}
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {!file ? (
          <div className="p-6 text-[13px] text-tx3">
            {output.running ? t("viewer.writing") : t("viewer.unreadable")}
          </div>
        ) : file.binary ? (
          <FilePreview file={file} version={output.at} />
        ) : isHtml && !showSource ? (
          // Betik yok (`sandbox=""` + yanıttaki CSP); göreli görseller aynı şemadan yüklenir.
          // Çıktı çoğu kez arka plan vermiyor: koyu temada koyu yazı okunmasın diye beyaz zemin.
          <iframe
            title={output.name}
            sandbox=""
            src={`${localFileUrl(output.path)}?v=${output.at}`}
            className="h-full w-full flex-1 bg-white"
          />
        ) : isMarkdown && !showSource ? (
          <div className="mx-auto w-full max-w-[760px] px-8 py-7">
            <Markdown text={file.content} document />
            {file.truncated ? (
              <div className="pt-3 text-[12px] text-tx3">{t("files.truncated")}</div>
            ) : null}
          </div>
        ) : (
          <div className="overflow-auto">
            <CodeView code={file.content} lang={langForPath(output.path)} lineNumbers />
            {file.truncated ? (
              <div className="px-3 py-2 text-[12px] text-tx3">{t("files.truncated")}</div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
