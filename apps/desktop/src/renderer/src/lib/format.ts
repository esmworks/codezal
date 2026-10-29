import { dict, type Locale } from "@codezal/i18n";

export function sep(locale: Locale): string {
  return locale === "tr" ? "," : ".";
}

/** Kısa zaman etiketi: 2dk (dakika), 3sa (saat), 4g (gün). */
export function shortAgo(ts: number, locale: Locale, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const d = dict(locale);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return d.format.now;
  if (m < 60) return `${m}${d.format.min}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}${d.format.hour}`;
  const g = Math.floor(h / 24);
  if (g < 30) return `${g}${d.format.day}`;
  const mo = Math.floor(g / 30);
  return `${mo}${d.format.month}`;
}

/**
 * Yüzde: Türkçede işaret sayının önünde ("%6", "%12,5"), İngilizcede arkasında. `digits` ondalık
 * basamak; kota ve kırılım satırları tam sayı yazar.
 */
export function formatPercent(v: number, locale: Locale, digits = 0): string {
  const s = v.toFixed(digits).replace(".", sep(locale));
  return locale === "tr" ? `%${s}` : `${s}%`;
}

export function formatTokens(n: number, locale: Locale): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(".", sep(locale))}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(".", sep(locale))}K`;
  return String(n);
}

export function formatDuration(ms: number, locale: Locale): string {
  const d = dict(locale);
  if (ms < 1000) return `${ms} ${d.format.ms}`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1).replace(".", sep(locale))} ${d.format.sec}`;
  const m = Math.floor(s / 60);
  return `${m} ${d.format.durationMin} ${Math.round(s % 60)} ${d.format.sec}`;
}

/**
 * Tur süresi (ZCode'un "Worked for 6m 36s" satırı): tam saniyeye yuvarlanır, ondalık ve
 * milisaniye yazılmaz, en çok iki birim gösterilir. Trace panelindeki `formatDuration` ölçüm
 * hassasiyeti için ondalık yazar; burada okunan şey ölçüm değil turun ağırlığı.
 */
export function formatTurnDuration(ms: number, locale: Locale): string {
  const d = dict(locale);
  const total = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds} ${d.format.sec}`;
  if (minutes < 60)
    return seconds === 0
      ? `${minutes} ${d.format.durationMin}`
      : `${minutes} ${d.format.durationMin} ${seconds} ${d.format.sec}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0
    ? `${hours} ${d.format.hour}`
    : `${hours} ${d.format.hour} ${rest} ${d.format.durationMin}`;
}

/** Süren iş için sayaç: ondalık basamak yok, saniye başı sıçramaz görünsün ("16 sn", "1 dk 33 sn"). */
export function formatElapsed(ms: number, locale: Locale): string {
  const d = dict(locale);
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} ${d.format.sec}`;
  return `${Math.floor(s / 60)} ${d.format.durationMin} ${s % 60} ${d.format.sec}`;
}

export function greeting(locale: Locale, name?: string, date = new Date()): string {
  const d = dict(locale);
  const h = date.getHours();
  const part =
    h < 6
      ? d.format.goodNight
      : h < 12
        ? d.format.goodMorning
        : h < 18
          ? d.format.goodDay
          : d.format.goodEvening;
  return name ? `${part}, ${name}` : part;
}

/** Yolun son parçası; Windows yolları için ters bölü de ayraç sayılır. */
export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Varsayılan kökte açılan worktree'nin projesi: `<proje>/.worktrees/<ad>` → `<proje>`. Kenar
 * çubuğu worktree oturumlarını bu sayede projenin altında gösterir; worktree değilse null.
 */
export function worktreeParent(path: string): string | null {
  const m = /[\\/]\.worktrees[\\/][^\\/]+[\\/]?$/.exec(path);
  return m && m.index > 0 ? path.slice(0, m.index) : null;
}

/** 0,0123 → "$0,012"; 12,5 → "$12,50"; 0 → "$0,00" (ayraç dile göre). */
export function formatUsd(n: number, locale: Locale): string {
  // Üç basamak yalnız küçük tutarda anlamlı; sıfır "$0,000" yazılınca "$12,50"nin yanında tutarsızdı.
  const digits = n > 0 && n < 0.1 ? 3 : 2;
  return `$${n.toFixed(digits).replace(".", sep(locale))}`;
}
