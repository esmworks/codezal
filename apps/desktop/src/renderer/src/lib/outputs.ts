import { type FileNode, isAbsolutePath, joinPath, type TranscriptItem } from "@codezal/contracts";
import { basename } from "./format";

export interface TaskOutput {
  path: string;
  name: string;
  /** Son yazımın başlangıcı; görüntüleyici bunu değişince yeniden okur. */
  at: number;
  running: boolean;
}

/**
 * Görevde üretilen çıktılar: asistanın yazdığı (`create`) her dosya. Model çıktı klasörü
 * yerine bağlam klasörüne de yazabildiğinden yol kısıtı yoktur; göreli yol cwd'ye göre çözülür.
 * Aynı dosya birden çok kez yazıldıysa son yazım kalır; reddedilen ve hatalı yazımlar sayılmaz.
 */
export function taskOutputs(transcript: TranscriptItem[], cwd: string): TaskOutput[] {
  const map = new Map<string, TaskOutput>();
  for (const item of transcript) {
    if (item.type !== "tool" || item.kind !== "create" || !item.target) continue;
    if (item.status === "error" || item.status === "denied" || item.status === "blocked") continue;
    const path = isAbsolutePath(item.target) ? item.target : joinPath(cwd, item.target);
    map.delete(path);
    map.set(path, {
      path,
      name: basename(path),
      at: item.startedAt,
      running: item.status === "running",
    });
  }
  return [...map.values()];
}

/**
 * Diskteki çıktı klasörüyle birleştirme: model PDF, tablo gibi dosyaları `write` yerine terminal
 * komutuyla (pandoc, python) üretebilir; bunlar transkriptte görünmez. Görev başlangıcından
 * sonra değişen dosyalar listeye eklenir; transkriptten gelen kayıt (yazılıyor durumu) korunur.
 *
 * Pencerenin üst ucu şart: çıktı klasörü projenin bütün görevlerince paylaşılır, yalnızca alt uca
 * bakmak eski bir görevin kutusunu sonraki görevlerin dosyalarıyla dolduruyordu. Süren görevde
 * üst uç yoktur (`until` verilmez), dosya o an üretiliyor olabilir.
 */
export function mergeDiskOutputs(
  outputs: TaskOutput[],
  nodes: FileNode[],
  since: number,
  until?: number,
): TaskOutput[] {
  const known = new Set(outputs.map((o) => o.path));
  const extra = nodes
    .filter(
      (n) =>
        n.kind === "file" &&
        !known.has(n.path) &&
        n.modifiedAt !== undefined &&
        n.modifiedAt >= since &&
        (until === undefined || n.modifiedAt <= until) &&
        !n.name.startsWith("."),
    )
    .map((n) => ({ path: n.path, name: n.name, at: n.modifiedAt ?? 0, running: false }));
  return [...outputs, ...extra].sort((a, b) => a.at - b.at);
}
