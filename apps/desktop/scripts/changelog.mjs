// CHANGELOG.md ile sürüm başlıkları arasındaki bağı kuran ortak yardımcılar.
//
// `bump-version.mjs` "Unreleased" bölümünü sürüm başlığına kapatır; `release-notes.mjs` aynı
// bölümü uygulama içi güncelleme kartı için düz metne çevirir. İkisi de bu modülü kullanır ki
// başlık biçimi tek yerde tanımlı kalsın.

/** Sürüm başlığı: `## [1.2.3] - 2026-09-16` (tarih eski kayıtlarda olmayabilir). */
const VERSION_HEADING_RE =
  /^## \[(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\](?: - (\d{4}-\d{2}-\d{2}))?[ \t]*$/;
const UNRELEASED_HEADING = "## [Unreleased]";

/**
 * "Unreleased" bölümünü `## [<sürüm>] - <tarih>` başlığına kapatır ve üstüne yeni boş bir
 * "Unreleased" bölümü açar. Bölümde hiç madde yoksa `empty: true` döner (çağıran uyarır).
 */
export function closeUnreleased(changelog, version, date) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.trim() === UNRELEASED_HEADING);
  if (start === -1) {
    throw new Error(`CHANGELOG.md içinde "${UNRELEASED_HEADING}" başlığı bulunamadı.`);
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## [")) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start + 1, end);
  const empty = !body.some((line) => /^[ \t]*- /.test(line));
  const next = [UNRELEASED_HEADING, "", "### Added", "", `## [${version}] - ${date}`, ...body];
  return { text: [...lines.slice(0, start), ...next, ...lines.slice(end)].join("\n"), empty };
}

/**
 * `## [<sürüm>]` bölümünün gövdesini döndürür; bölüm yoksa `null`, gövde boşsa `""`.
 * Gövde bir sonraki `## ` başlığına kadardır.
 */
export function sectionFor(changelog, version) {
  const lines = changelog.split("\n");
  // Kapanış köşeli parantezi şart: ön ek karşılaştırmasında `1.0.6` sürümü `1.0.60` bölümünü
  // bulup yanlış sürüm notlarını paketliyordu.
  const start = lines.findIndex(
    (line) => line.startsWith(`## [${version}]`) || line.startsWith(`## [${version} `),
  );
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## [")) {
      end = i;
      break;
    }
  }
  return lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
}

/** Güncelleme kartı düz metin gösterir: `### Başlık` kalın satıra iner. */
export function plainifyNotes(markdown) {
  return markdown
    .replace(/^#### (.+?)[ \t]*$/gm, "**$1**")
    .replace(/^### (.+?)[ \t]*$/gm, "**$1**");
}

/** Sürüm başlığı satırı mı; `matchVersion` verilirse o sürümün başlığı mı. */
export function isVersionHeading(line, matchVersion) {
  const match = VERSION_HEADING_RE.exec(line);
  if (!match) return false;
  return matchVersion === undefined || match[1] === matchVersion;
}
