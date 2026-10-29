import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { copyWithToast } from "../components/CopyButton";
import { Icon } from "../components/Icon";
import { safeWebview } from "../lib/webview";
import { useMenu } from "../stores/menu";
import { usePanel } from "../stores/panel";

interface WebviewEl extends HTMLElement {
  src: string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  getURL(): string;
  openDevTools(): void;
}

function normalize(input: string): string {
  const v = input.trim();
  if (!v) return "about:blank";
  if (/^[a-z]+:\/\//i.test(v)) return v;
  if (/^localhost|^\d+\.\d+\.\d+\.\d+|^[\w-]+(\.[\w-]+)+/.test(v)) return `http://${v}`;
  return `https://www.google.com/search?q=${encodeURIComponent(v)}`;
}

/** Gömülü tarayıcı: webview + adres çubuğu (TODO 2). */
export function BrowserTab() {
  const { t } = useTranslation();
  const { browserUrl, setBrowserUrl } = usePanel();
  const openAt = useMenu((s) => s.openAt);
  const ref = useRef<WebviewEl>(null);
  const [input, setInput] = useState(browserUrl);
  const [loading, setLoading] = useState(false);
  const [nav, setNav] = useState({ back: false, forward: false });
  const [title, setTitle] = useState("");
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    const wv = ref.current;
    if (!wv) return;
    const onStart = () => {
      setLoading(true);
      setFailed(null);
    };
    const onStop = () => {
      setLoading(false);
      setNav({
        back: safeWebview(() => wv.canGoBack()) ?? false,
        forward: safeWebview(() => wv.canGoForward()) ?? false,
      });
      const url = safeWebview(() => wv.getURL()) ?? "";
      if (url && url !== "about:blank") {
        setInput(url);
        setBrowserUrl(url);
      }
    };
    const onTitle = (e: Event) => setTitle((e as unknown as { title: string }).title);
    const onFail = (e: Event) => {
      const d = e as unknown as { errorDescription?: string; errorCode?: number };
      if (d.errorCode === -3) return;
      setFailed(d.errorDescription ?? t("browser.loadFailed"));
      setLoading(false);
    };
    wv.addEventListener("did-start-loading", onStart);
    wv.addEventListener("did-stop-loading", onStop);
    wv.addEventListener("page-title-updated", onTitle);
    wv.addEventListener("did-fail-load", onFail);
    return () => {
      wv.removeEventListener("did-start-loading", onStart);
      wv.removeEventListener("did-stop-loading", onStop);
      wv.removeEventListener("page-title-updated", onTitle);
      wv.removeEventListener("did-fail-load", onFail);
    };
  }, [setBrowserUrl, t]);

  const go = (url: string) => {
    const wv = ref.current;
    const target = normalize(url);
    setInput(target);
    setBrowserUrl(target);
    if (wv) wv.src = target;
  };

  const menu = (e: React.MouseEvent) =>
    openAt(e.currentTarget as HTMLElement, {
      items: [
        {
          label: t("browser.devTools"),
          icon: "bug",
          onSelect: () => safeWebview(() => ref.current?.openDevTools()),
        },
        {
          label: t("browser.copyUrl"),
          icon: "copy",
          onSelect: () => copyWithToast(browserUrl),
        },
        { label: "localhost:3000", icon: "globe", onSelect: () => go("http://localhost:3000") },
        { label: "localhost:5173", icon: "globe", onSelect: () => go("http://localhost:5173") },
      ],
    });

  const btn =
    "flex h-6 w-6 items-center justify-center rounded-[6px] hover:bg-hov disabled:opacity-30";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-[11px] pb-[9px]">
        <button
          type="button"
          disabled={!nav.back}
          onClick={() => safeWebview(() => ref.current?.goBack())}
          className={`${btn} text-tx3`}
        >
          <Icon name="chevronLeft" size={14} stroke={1.9} />
        </button>
        <button
          type="button"
          disabled={!nav.forward}
          onClick={() => safeWebview(() => ref.current?.goForward())}
          className={`${btn} text-tx3`}
        >
          <Icon name="chevronRight" size={14} stroke={1.9} />
        </button>
        <button
          type="button"
          onClick={() => safeWebview(() => (loading ? ref.current?.stop() : ref.current?.reload()))}
          className={`${btn} text-tx3`}
          title={loading ? t("browser.stop") : t("browser.reload")}
        >
          <Icon name={loading ? "x" : "loop"} size={14} />
        </button>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) go(input);
          }}
          spellCheck={false}
          className="min-w-0 flex-1 rounded-[9px] border border-line2 bg-transparent px-[11px] py-[5px] font-mono text-[12px] text-tx2 outline-none focus:text-tx"
        />
        <button
          type="button"
          onClick={menu}
          className="px-1 text-[13px] tracking-[1px] text-tx3 hover:text-tx"
        >
          ···
        </button>
      </div>
      <div className="relative min-h-0 flex-1 border-t border-line">
        <webview
          ref={ref as React.RefObject<HTMLElement>}
          src={browserUrl}
          // @ts-expect-error webview özel öznitelik
          allowpopups="true"
          className="h-full w-full bg-white"
          style={{ display: "flex" }}
        />
        {failed ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-bg text-[13px] text-tx3">
            <Icon name="globe" size={22} />
            <span>{failed}</span>
            <button
              type="button"
              onClick={() => safeWebview(() => ref.current?.reload())}
              className="text-accTx hover:text-tx"
            >
              {t("browser.retry")}
            </button>
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-line px-[14px] py-[9px] text-[12px] text-tx3">
        <span
          className={`h-[7px] w-[7px] rounded-full ${loading ? "animate-pulse bg-amber" : "bg-green"}`}
        />
        <span className="min-w-0 flex-1 truncate">
          {loading ? t("common.loading") : title || t("browser.ready")}
        </span>
      </div>
    </div>
  );
}
