import {
  SESSION_SEARCH_MAX,
  SESSION_SEARCH_MIN,
  type SessionSearchHit,
  type SessionSummary,
} from "@codezal/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../api";
import { Icon } from "../components/Icon";
import { basename, shortAgo } from "../lib/format";
import { useLocale } from "../lib/i18n";
import { matchesFold } from "../lib/searchText";
import { useNow } from "../lib/useNow";
import { useApp } from "../stores/app";
import { useFind } from "../stores/find";
import { useSessions } from "../stores/sessions";

/** İçerik araması yazmayı bekler: her tuş vuruşunda main'e gidilmesin. */
const CONTENT_DEBOUNCE_MS = 200;
/** Başlık eşleşmelerinden gösterilecek en çok satır. */
const TITLE_LIMIT = 12;

/** Kenar çubuğunda görünen oturum: arşiv, yan sohbet ve ajan koşusu oturumları aranmaz. */
function searchable(s: SessionSummary): boolean {
  return !s.archived && !s.sideOf && !s.parentSessionId;
}

interface ContentState {
  query: string;
  hits: SessionSearchHit[];
  truncated: boolean;
  loading: boolean;
}

const EMPTY: ContentState = { query: "", hits: [], truncated: false, loading: false };

/**
 * ⌘K arama paleti. Önce oturum adı ve proje adı eşleşmeleri, altında konuşma içeriği
 * eşleşmeleri (main'de tam metin arama, `sessions:search`). Başlıkta bulunan oturum içerik
 * listesinde tekrar edilmez.
 */
export function SearchPalette() {
  const { t } = useTranslation();
  const lang = useLocale();
  const now = useNow();
  const { setSearchOpen, openSession } = useApp();
  const list = useSessions((s) => s.list);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const [content, setContent] = useState<ContentState>(EMPTY);
  // Yanıt sırası tuş vuruşu sırasıyla aynı olmayabilir: yalnız son isteğin yanıtı yazılır.
  const request = useRef(0);

  const titles = useMemo(() => {
    const needle = q.trim();
    return (
      list
        .filter(searchable)
        // Katlama yerel ayardan bağımsız (`searchText.ts`): `toLocaleLowerCase("tr")` "IPC"yi `ıpc`
        // yaptığı için `ipc` araması sonuç vermiyordu.
        .filter((s) => !needle || matchesFold(`${s.name} ${basename(s.cwd)}`, needle))
        .slice(0, TITLE_LIMIT)
    );
  }, [list, q]);

  useEffect(() => {
    const query = q.trim();
    const id = ++request.current;
    if (query.length < SESSION_SEARCH_MIN || query.length > SESSION_SEARCH_MAX) {
      setContent(EMPTY);
      return;
    }
    setContent((c) => ({ ...c, loading: true }));
    const timer = setTimeout(() => {
      // Liste zaten yeniden eskiye sıralı: main bu sırayla tarar, sınır dolunca eskiler kalır.
      const ids = useSessions
        .getState()
        .list.filter(searchable)
        .map((s) => s.id);
      invoke("sessions:search", { query, ids }).then(
        (res) => {
          if (request.current === id) setContent({ query, ...res, loading: false });
        },
        () => {
          // Arama yardımcı bir yüzey: hata toast'a dönüşmesin, liste boş kalsın.
          if (request.current === id) setContent(EMPTY);
        },
      );
    }, CONTENT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q]);

  const hits = useMemo(() => {
    if (content.query !== q.trim()) return [];
    const shown = new Set(titles.map((s) => s.id));
    const byId = new Map(list.map((s) => [s.id, s]));
    return content.hits.flatMap((hit) => {
      const session = byId.get(hit.id);
      return session && !shown.has(hit.id) ? [{ hit, session }] : [];
    });
  }, [content, titles, list, q]);

  const total = titles.length + hits.length;

  // biome-ignore lint/correctness/useExhaustiveDependencies: sorgu değişince seçimi başa al
  useEffect(() => setIdx(0), [q]);

  const pick = (session: SessionSummary) => {
    openSession(session.id, session.mode);
    setSearchOpen(false);
  };

  /**
   * İçerik isabeti: oturum açılır ve sohbet içi bulma aynı sorguyla isabetli mesaja atlar. İstek
   * oturum açılmadan bırakılır; transkript bağlanınca (ya da oturum zaten açıksa hemen) tüketir.
   */
  const pickHit = (hit: SessionSearchHit, session: SessionSummary) => {
    useFind.getState().request(session.id, content.query, {
      role: hit.role,
      at: hit.at,
      ordinal: hit.ordinal,
    });
    pick(session);
  };

  const pickAt = (i: number) => {
    if (i < titles.length) {
      const s = titles[i];
      if (s) pick(s);
      return;
    }
    const row = hits[i - titles.length];
    if (row) pickHit(row.hit, row.session);
  };

  const rowClass = (i: number) =>
    `flex w-full items-center gap-3 rounded-[8px] px-3 py-2 text-left ${i === idx ? "bg-chip" : "hover:bg-hov"}`;
  const sectionClass = "px-3 pt-2 pb-1 text-[12px] text-tx3";
  const searching = content.loading && q.trim().length >= SESSION_SEARCH_MIN;

  return (
    <div
      className="fixed inset-0 z-[120] flex items-start justify-center bg-[var(--scrim)] pt-[14vh]"
      onClick={() => setSearchOpen(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("common.search")}
        className="w-[560px] max-w-[92vw] overflow-hidden rounded-[14px] border border-line2 bg-card shadow-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <Icon name="search" size={15} className="text-tx3" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                // Paleti kapatan Esc oturum ekranına ulaşıp turu durdurmasın.
                e.preventDefault();
                setSearchOpen(false);
              }
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIdx((i) => Math.min(total - 1, i + 1));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setIdx((i) => Math.max(0, i - 1));
              }
              if (e.key === "Enter" && !e.nativeEvent.isComposing) pickAt(idx);
            }}
            placeholder={t("shell.searchPlaceholder")}
            className="flex-1 bg-transparent text-[14px] text-tx outline-none placeholder:text-tx3"
          />
          <span className="font-mono text-[12px] text-tx3">⎋</span>
        </div>
        <div className="max-h-[50vh] overflow-y-auto p-[6px]">
          {total === 0 && !searching ? (
            <div className="px-3 py-4 text-[13px] text-tx3">{t("shell.noResults")}</div>
          ) : null}
          {titles.length > 0 && hits.length > 0 ? (
            <div className={sectionClass}>{t("shell.searchSessions")}</div>
          ) : null}
          {titles.map((s, i) => (
            <button
              type="button"
              key={s.id}
              onMouseEnter={() => setIdx(i)}
              onClick={() => pick(s)}
              className={rowClass(i)}
            >
              <Icon
                name={s.mode === "asistan" ? "sparkle" : "code"}
                size={14}
                className="shrink-0 text-tx3"
              />
              <span className="min-w-0 flex-1 truncate text-[13px]">{s.name}</span>
              <span className="truncate font-mono text-[12px] text-tx3">{basename(s.cwd)}</span>
              <span className="font-mono text-[12px] text-tx3">
                {shortAgo(s.modifiedAt, lang, now)}
              </span>
            </button>
          ))}
          {hits.length > 0 ? <div className={sectionClass}>{t("shell.searchContent")}</div> : null}
          {hits.map(({ hit, session }, j) => {
            const i = titles.length + j;
            return (
              <button
                type="button"
                key={`c-${hit.id}`}
                onMouseEnter={() => setIdx(i)}
                onClick={() => pickHit(hit, session)}
                className={`${rowClass(i)} items-start`}
              >
                <Icon
                  name={session.mode === "asistan" ? "sparkle" : "code"}
                  size={14}
                  className="mt-[3px] shrink-0 text-tx3"
                />
                <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13px]">{session.name}</span>
                    <span className="shrink-0 text-[12px] text-tx3">
                      {t("shell.searchMatches", { count: hit.count })}
                    </span>
                    <span className="shrink-0 font-mono text-[12px] text-tx3">
                      {shortAgo(session.modifiedAt, lang, now)}
                    </span>
                  </span>
                  <span className="line-clamp-2 text-[12px] leading-[1.5] text-tx2">
                    {hit.role === "user" ? (
                      <span className="text-tx3">{`${t("shell.searchYou")}: `}</span>
                    ) : null}
                    {hit.snippet.slice(0, hit.matchStart)}
                    <strong className="font-semibold text-tx">
                      {hit.snippet.slice(hit.matchStart, hit.matchEnd)}
                    </strong>
                    {hit.snippet.slice(hit.matchEnd)}
                  </span>
                </span>
              </button>
            );
          })}
          {searching ? (
            <div className="px-3 py-2 text-[12px] text-tx3">{t("shell.searchSearching")}</div>
          ) : content.truncated && hits.length > 0 ? (
            <div className="px-3 py-2 text-[12px] text-tx3">{t("shell.searchTruncated")}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
