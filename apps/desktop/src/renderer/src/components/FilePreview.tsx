import { type FileContent, localFileUrl, previewKindFor } from "@codezal/contracts";
import { useTranslation } from "react-i18next";
import { invoke } from "../api";
import { reportError } from "../stores/toast";
import { Markdown } from "./Markdown";

/**
 * İkili dosya önizlemesi: PDF gömülü görüntüleyicide, görseller <img> ile; ikisi de main'in
 * servis ettiği `codezal-file://` adresinden gelir. Word belgesi ve Excel kitabı main'in çıkardığı
 * okuma görünümüyle (Markdown; izli değişiklik ve yorumlar işaretli, Excel sayfaları tablo) çizilir: sayfa düzeni değil içerik
 * önizlemesidir, asıl görünüm için "Uygulamada aç" üstte kalır. Diğer ikili türler için boyut ve
 * "Uygulamada aç" düğmesi (Numbers vb. sistemde açılır).
 */
export function FilePreview({ file, version = 0 }: { file: FileContent; version?: number }) {
  const { t } = useTranslation();
  const kind = previewKindFor(file.path);
  // Sorgu eki: aynı yol yeniden yazılınca iframe/img önbelleği değil yeni içerik gelsin.
  const src = `${localFileUrl(file.path)}?v=${version}`;
  if (file.markdown !== undefined)
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto w-full max-w-[760px] px-8 py-7">
          <div className="mb-5 flex items-center gap-3 text-[12px] text-tx3">
            <span className="flex-1">
              {t(
                /\.(xlsx|xlsm|xltx|xltm)$/i.test(file.path)
                  ? "viewer.xlsxPreview"
                  : "viewer.docxPreview",
              )}
            </span>
            <button
              type="button"
              onClick={() =>
                void invoke("files:openExternal", { path: file.path }).catch(reportError)
              }
              className="rounded-[7px] border border-line px-[10px] py-[4px] text-tx hover:bg-hov"
            >
              {t("turnFiles.openInApp")}
            </button>
          </div>
          <Markdown text={file.markdown} document />
        </div>
      </div>
    );
  if (kind === "pdf") return <iframe title={file.path} src={src} className="h-full w-full" />;
  if (kind === "image")
    return (
      <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto p-4">
        <img src={src} alt={file.path} className="max-w-full rounded-[6px]" />
      </div>
    );
  return (
    <div className="flex flex-col items-start gap-3 p-6 text-[13px] text-tx3">
      <span>
        {t("files.binary", { size: Math.round(file.size / 1024) })} {t("viewer.noPreview")}
      </span>
      <button
        type="button"
        // Açılamayan dosya (ilişkili uygulama yok, dosya silinmiş) kullanıcıya söylenir.
        onClick={() => void invoke("files:openExternal", { path: file.path }).catch(reportError)}
        className="rounded-[7px] border border-line px-[10px] py-[4px] text-tx hover:bg-hov"
      >
        {t("turnFiles.openInApp")}
      </button>
    </div>
  );
}
