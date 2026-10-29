import type { AssistantProject } from "@codezal/contracts";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../../api";
import { Icon } from "../../components/Icon";
import type { IconName } from "../../icons";
import { FLOAT_PANEL_WIDTH } from "../../lib/floatPanel";
import { basename } from "../../lib/format";
import type { TaskOutput } from "../../lib/outputs";
import { type ProgressStep, visibleSteps } from "../../lib/progress";
import { QuotaBox } from "../../session/QuotaBox";

/** Kodlama ekranındaki Ortam bilgisi kutusuyla aynı biçim: katlanabilir yüzen kart. */
function Box({
  title,
  meta,
  action,
  defaultOpen = true,
  scroll = false,
  gap = "gap-1",
  children,
}: {
  title: string;
  meta?: string;
  action?: ReactNode;
  defaultOpen?: boolean;
  /** Uzun listeler için: gövde belli bir boyu geçince kutunun içinde kayar. */
  scroll?: boolean;
  /** Satırlar arası boşluk; kendi dolgusu olan (üzerine gelince vurgulanan) satırlarda sıfır. */
  gap?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    // shrink-0: sütun dolduğunda kutular ezilip içerikleri kırpılmasın, sütun kaysın.
    <div className="shrink-0 overflow-hidden rounded-[14px] border border-line2 bg-card">
      <div className="flex items-center gap-2 px-[14px] py-3">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="text-[14px] font-semibold">{title}</span>
          {meta ? <span className="text-[14px] text-tx3">{meta}</span> : null}
          <span className="flex-1" />
          <Icon
            name="chevronDown"
            size={13}
            stroke={2}
            className="text-tx3 transition-transform"
            style={{ transform: open ? undefined : "rotate(-90deg)" }}
          />
        </button>
        {action}
      </div>
      {open ? (
        // Dolgu dıştaki kutuda durur, kaydırma içeride: alt boşluk kaydırınca kaybolmaz,
        // son satır kartın kenarına yapışmaz.
        <div className="border-line border-t px-[14px] pt-2 pb-[10px]">
          <div className={scroll ? "max-h-[236px] overflow-y-auto" : ""}>
            <div className={`flex flex-col ${gap}`}>{children}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Bağlam kutusu katlıyken gösterilen okunan dosya sayısı; gerisi "Tümünü görüntüle" ile açılır. */
const CONTEXT_PREVIEW = 8;

/**
 * Asistan görev ekranının sağ üstündeki yüzen kutular: İlerleme, Çıktılar, Bağlam.
 * Sabit panel yerine sohbetin üstünde durur; Kodlama ekranındaki EnvBox ile aynı yerleşim.
 * Sütun değil katman: sohbet alanı altına kadar uzandığı için dikey kaydırma çubuğu pencere
 * kenarında kalır (bkz. `lib/floatPanel`).
 * İlerleme yalnızca ajan bir adım listesi oluşturduğunda gösterilir; görev çalışırken adım yoksa
 * kutu çıkmaz, liste tamamlanınca ya da tur bitince kutu tamamen kaybolur. Gösterilen satırlarda
 * açık adımlar önceliklidir: `slice(-4)` onları gizleyip "hepsi bitti" izlenimi veriyordu.
 * Proje bilgisi burada tekrar etmez, üstteki gezinti yolu projeye götürür.
 */
export function TaskBoxes({
  sessionId,
  steps,
  outputs,
  outputsDir,
  project,
  readFiles,
  active,
  openLeft,
  onOpenOutput,
  onAddContext,
}: {
  /** Kota kutusu oturumun seçili modelinin sağlayıcısını okur. */
  sessionId: string;
  steps: ProgressStep[];
  outputs: TaskOutput[];
  outputsDir: string;
  /** Yalnızca proje bağlamı (klasör, dosya, bağlantı) için; kart olarak gösterilmez. */
  project: AssistantProject | undefined;
  readFiles: string[];
  /** Tur sürüyor mu (izin sorusu beklerken de sürer); kutu tur sürerken çizilir. */
  active: boolean;
  /** Son turda kapatılmadan bırakılan adım sayısı; tur bitince kutu bunlarla görünür kalır. */
  openLeft: number;
  onOpenOutput: (path: string) => void;
  /** Bağlam kutusundaki "+": klasör/dosya/bağlantı menüsünü düğmeye tutunarak açar. */
  onAddContext: (anchor: HTMLElement) => void;
}) {
  const { t } = useTranslation();
  const done = steps.filter((s) => s.done).length;
  const allDone = steps.length > 0 && done === steps.length;
  const showProgress = steps.length > 0 && !allDone && (active || openLeft > 0);
  const shown = visibleSteps(steps);
  const [allContext, setAllContext] = useState(false);
  const shownFiles = allContext ? readFiles : readFiles.slice(0, CONTEXT_PREVIEW);
  const iconButton = (name: IconName, title: string, onClick: () => void) => (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="shrink-0 text-tx3 hover:text-tx"
    >
      <Icon name={name} size={14} />
    </button>
  );

  return (
    <div
      className="absolute inset-y-0 right-0 z-20 flex flex-col gap-[10px] overflow-y-auto pt-[12px] pr-[18px] pb-4"
      style={{ width: FLOAT_PANEL_WIDTH }}
    >
      {showProgress ? (
        <Box title={t("env.progressTitle")} meta={`${done}/${steps.length}`}>
          {!active && openLeft > 0 ? (
            <div className="pb-[2px] text-[14px] text-amber">
              {t("env.openStepsLeft", { count: openLeft })}
            </div>
          ) : null}
          {shown.shown.map((s) => (
            <div key={s.label} className="flex items-start gap-2 text-[14px]">
              <span
                className={`w-3 shrink-0 ${s.done ? "text-green" : s.active ? "text-tx" : "text-tx3"}`}
              >
                {s.done ? "✓" : s.active ? "›" : "·"}
              </span>
              <span className="min-w-0 truncate text-tx2">{s.label}</span>
            </div>
          ))}
          {shown.hidden > 0 ? (
            <div className="pl-5 text-[14px] text-tx3">
              {t("env.moreSteps", { count: shown.hidden })}
            </div>
          ) : null}
        </Box>
      ) : null}

      <Box
        title={t("schedule.outputsTitle")}
        meta={String(outputs.length)}
        // Uzun görevde çıktı sayısı büyür; sınırsız kutu Bağlam'ı ekrandan iter.
        scroll
        gap="gap-0"
        action={iconButton(
          "folderOpen",
          t("schedule.openOutputsFolder"),
          () => void invoke("files:openExternal", { path: outputsDir }),
        )}
      >
        {outputs.length === 0 ? (
          <div className="text-[14px] leading-[1.5] text-tx3">{t("schedule.outputsEmpty")}</div>
        ) : null}
        {outputs.map((o) => (
          <div
            key={o.path}
            className="group -mx-2 flex items-center gap-[9px] rounded-[7px] px-2 py-[2px] text-[14px] text-tx2 hover:bg-hov"
          >
            <button
              type="button"
              onClick={() => onOpenOutput(o.path)}
              className="flex min-w-0 flex-1 items-center gap-[9px] text-left hover:text-tx"
            >
              <Icon name="file" size={14} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate text-[14px]">{o.name}</span>
              {o.running ? (
                <span className="text-[14px] text-tx3">{t("viewer.writing")}</span>
              ) : null}
            </button>
            <span className="opacity-0 group-hover:opacity-100">
              {iconButton(
                "folder",
                t("files.reveal"),
                () => void invoke("files:reveal", { path: o.path }),
              )}
            </span>
          </div>
        ))}
      </Box>

      <Box
        title={t("asistan.context")}
        meta={String((project?.context.length ?? 0) + readFiles.length)}
        scroll
        action={
          <button
            type="button"
            title={t("asistan.addContext")}
            onClick={(e) => onAddContext(e.currentTarget)}
            className="shrink-0 text-tx3 hover:text-tx"
          >
            <Icon name="plus" size={14} stroke={2} />
          </button>
        }
      >
        {project?.context.map((c) => (
          <div
            key={`${c.kind}:${c.value}`}
            className="flex items-center gap-[9px] text-[14px] text-tx2"
          >
            <Icon
              name={c.kind === "folder" ? "folder" : c.kind === "file" ? "file" : "globe"}
              size={14}
              className="shrink-0"
            />
            <span className="min-w-0 flex-1 truncate">{c.label}</span>
          </div>
        ))}
        {shownFiles.map((f) => (
          <div
            key={f}
            title={`${t("schedule.readTitle")} · ${f}`}
            className="flex items-center gap-[9px] text-[14px] text-tx2"
          >
            <Icon name="eye" size={14} className="shrink-0 text-tx3" />
            <span className="min-w-0 flex-1 truncate text-[14px]">{basename(f)}</span>
          </div>
        ))}
        {readFiles.length > CONTEXT_PREVIEW ? (
          <button
            type="button"
            onClick={() => setAllContext(!allContext)}
            className="flex items-center gap-[9px] text-left text-[14px] text-tx3 hover:text-tx"
          >
            <Icon
              name="chevronDown"
              size={14}
              className="shrink-0 transition-transform"
              style={{ transform: allContext ? "rotate(180deg)" : undefined }}
            />
            <span>
              {allContext
                ? t("schedule.showLessContext")
                : t("schedule.showAllContext", { count: readFiles.length })}
            </span>
          </button>
        ) : null}
        {!project?.context.length && readFiles.length === 0 ? (
          <div className="text-[14px] leading-[1.5] text-tx3">{t("schedule.contextEmpty")}</div>
        ) : null}
      </Box>

      <QuotaBox sessionId={sessionId} active={active} />
    </div>
  );
}
