import { Icon } from "../components/Icon";
import manifest from "./file-icons.manifest.json";

/**
 * Dosya türü simgeleri: VS Code "Material Icon Theme" (PKief, MIT) setinden alınmış,
 * yalnızca manifestte kullanılan SVG'ler `public/file-icons/` altında. Manifest derleme sırasında
 * üretilmiş statik JSON; çalışma anında bağımlılık yok. Eşleşme yoksa tek renkli simgeye düşer.
 * Dosya ağacında klasör simgesi yok (yalnız açılma oku), bu yüzden klasör eşlemesi okunmaz.
 */
interface Manifest {
  fileNames: Record<string, string>;
  fileExtensions: Record<string, string>;
  file?: string;
}
const M = manifest as Manifest;

const url = (name: string | undefined) => (name ? `./file-icons/${name}.svg` : undefined);

/** Dosya adı → simge adresi. Önce tam ad, sonra en uzun uzantı, sonra varsayılan. */
export function fileIconUrl(fileName: string): string | undefined {
  const lower = fileName.toLowerCase();
  let name = M.fileNames[lower];
  if (!name) {
    const parts = lower.split(".");
    for (let i = 1; i < parts.length; i++) {
      const hit = M.fileExtensions[parts.slice(i).join(".")];
      if (hit) {
        name = hit;
        break;
      }
    }
  }
  return url(name ?? M.file);
}

/**
 * `mono`: simge renkli yerine metin grisinde tek renk siluet çizilir (dosya ağacı). Renkli
 * simgeler alt alta dizilince ağaç alacalı görünüyordu; tür bilgisi şekilden okunur.
 */
export function FileTypeIcon({
  name,
  size = 14,
  mono = false,
}: {
  name: string;
  size?: number;
  mono?: boolean;
}) {
  const src = fileIconUrl(name);
  if (!src) return <Icon name="file" size={size} className="shrink-0 text-tx3" />;
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      draggable={false}
      width={size}
      height={size}
      className={mono ? "cz-file-icon-mono shrink-0" : "shrink-0"}
    />
  );
}
