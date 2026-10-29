import type { BackgroundJob } from "@codezal/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../api";
import { Icon } from "../components/Icon";
import { useLocale } from "../lib/i18n";
import { backgroundJobs } from "../lib/jobs";
import { stopBackground } from "../stores/background";
import { useSessions } from "../stores/sessions";
import { DetailHeader, metaParts, PartLine } from "./jobParts";

const EMPTY: BackgroundJob[] = [];

/** Süren komutun çıktısı bu aralıkla yoklanır: çıktı olayla akmaz, yalnız sekme açıkken çekilir. */
const POLL_MS = 1000;

/** Alt kenara bu kadar yakın kaydırma "takipte" sayılır; yukarı kaydıran kullanıcı rahat okusun. */
const FOLLOW_SLACK = 24;

interface Output {
  job: BackgroundJob;
  output: string;
  truncated: boolean;
}

/**
 * Tek arka plan komutunun ayrıntısı: geri oklu başlık, durum ve süre satırı, balonda komut,
 * altında çıktı. Çıktı süren komutta her saniye yoklanır ve alt kenar takip edilir; kullanıcı
 * yukarı kaydırınca takip durur, "En alta git" ile geri döner. Komut tur başında yüzen karttan
 * düşse de çıktısı runner'da durduğu için ayrıntı göstermeye devam eder.
 */
export function BackgroundDetail({ sessionId, jobId }: { sessionId: string; jobId: string }) {
  const { t } = useTranslation();
  const lang = useLocale();
  // Canlı olaylar (`background_start`/`_end`) durumun kaynağıdır; düşen komutun durumu çıktıdan.
  const liveRow = useSessions((s) =>
    (s.runtime[sessionId]?.backgrounds ?? EMPTY).find((j) => j.id === jobId),
  );
  const [out, setOut] = useState<Output | null | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  const [follow, setFollow] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const fetched = out?.job.id === jobId ? out : undefined;
  const activeJob = liveRow ?? fetched?.job;
  const running = activeJob?.status === "running";

  // Çıktı: komut sürerken yoklanır, bitince son hâli bir kez daha çekilip durulur.
  const status = activeJob?.status;
  useEffect(() => {
    let alive = true;
    const pull = () =>
      invoke("background:output", { sessionId, jobId })
        .then((res) => {
          if (alive) setOut(res);
        })
        .catch(() => {});
    void pull();
    const timer = status === "running" ? setInterval(pull, POLL_MS) : undefined;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [sessionId, jobId, status]);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const text = fetched?.output ?? "";
  useLayoutEffect(() => {
    void text;
    const el = scrollRef.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [text, follow]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK);
  };

  // Başlık altındaki satır kartla aynıdır: "Komut  Çalışıyor  1 dk 12 sn".
  // Kartla aynı satır: başlık açıklamadan (yoksa komutun ilk satırından), durum sözcükleri ortak.
  const row = activeJob ? backgroundJobs([activeJob])[0] : undefined;
  const meta = row ? metaParts(row, now, lang, t) : [];
  if (running) meta.splice(1, 0, { text: t("background.live"), tone: "cz-shimmer" });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DetailHeader
        title={row?.label ?? t("panel.command")}
        onStop={running && activeJob ? () => stopBackground(sessionId, activeJob.id) : undefined}
      />
      {activeJob ? (
        <div className="flex shrink-0 flex-col gap-3 px-4 pt-1 pb-3">
          <PartLine parts={meta} />
          <div className="max-h-[132px] overflow-y-auto rounded-[12px] bg-card px-4 py-3 font-code text-[12.5px] leading-[1.55] break-words whitespace-pre-wrap text-tx">
            {activeJob.command}
          </div>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-auto px-4 pb-3">
          {out === null ? (
            <div className="py-6 text-center text-[13px] text-tx3">{t("background.gone")}</div>
          ) : fetched?.truncated ? (
            <div className="pb-2 text-[12px] text-tx3">{t("background.truncated")}</div>
          ) : null}
          {text ? (
            <pre className="font-code text-[12px] leading-[1.55] break-words whitespace-pre-wrap text-tx2">
              {text}
            </pre>
          ) : fetched ? (
            <div className="py-6 text-center text-[13px] text-tx3">{t("background.noOutput")}</div>
          ) : null}
        </div>
        {!follow && text ? (
          <button
            type="button"
            onClick={() => setFollow(true)}
            className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-[6px] rounded-full border border-line2 bg-card px-3 py-[5px] text-[12px] text-tx2 shadow-sm hover:text-tx"
          >
            <Icon name="down" size={12} />
            {t("background.follow")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
