import type {
  ContextUsage,
  ModelRef,
  PermissionMode,
  ThinkingLevel,
  Usage,
} from "@codezal/contracts";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import type { IconName } from "../icons";
import { useMenu } from "../stores/menu";
import { useModelPicker } from "../stores/modelPicker";
import { useModels } from "../stores/models";
import { useSessions } from "../stores/sessions";
import { ContextRing } from "./ContextRing";
import {
  PERMISSION_ICONS,
  PERMISSION_KEYS,
  permissionMenuItems,
  THINKING_KEYS,
  thinkingMenuItems,
} from "./chipMenus";

export { PERMISSION_ICONS };

interface ChipProps {
  icon?: IconName;
  label: string;
  mono?: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  small?: boolean | undefined;
  /** Bağlam çipleri (proje, dal, konum) gri durur; composer'ın kendi çipleri tam kontrastta. */
  muted?: boolean | undefined;
  /** Riskli seçim (tam erişim): çip uyarı renginde durur, model ve düşünme çipleriyle karışmaz. */
  warn?: boolean | undefined;
  title?: string;
  className?: string;
  dataAttr?: string;
}

export function Chip({
  icon,
  label,
  mono,
  onClick,
  small,
  muted,
  warn,
  title,
  className = "",
  dataAttr,
}: ChipProps) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      {...(dataAttr ? { [`data-${dataAttr}`]: "" } : {})}
      className={`flex min-w-0 items-center gap-[6px] rounded-[7px] px-[7px] py-[3px] hover:bg-hov ${
        warn ? "text-amber" : muted ? "text-tx2 hover:text-tx" : "text-tx"
      } ${small ? "text-[12px]" : "text-[13px]"} ${mono ? "font-mono" : ""} ${className}`}
    >
      {icon ? <Icon name={icon} size={small ? 13 : 14} /> : null}
      <span className="truncate">{label}</span>
      {!small ? (
        <Icon
          name="chevronDown"
          size={11}
          stroke={2}
          className={warn ? "" : muted ? "text-tx3" : "text-tx2"}
        />
      ) : null}
    </button>
  );
}

/**
 * Giriş ekranlarının çip çifti: seçim yalnızca genel tercihe yazılır, henüz oturum yok.
 */
export function HomeChips() {
  const { thinking, setThinking, setModel } = useModels();
  return (
    <>
      <ModelChip onChange={setModel} />
      <ThinkingChip value={thinking} onChange={setThinking} />
    </>
  );
}

/**
 * Oturum içi çip çifti: bağlam halkası + model + düşünme. Çipler oturumun kendi değerini gösterir
 * (açılışta main'den gelir); bilinmiyorsa genel tercih. Seçim hem oturuma hem genel tercihe yazılır.
 */
export function SessionChips({
  id,
  usage = null,
  stats = null,
}: {
  id: string;
  usage?: ContextUsage | null;
  stats?: Usage | null;
}) {
  const globalThinking = useModels((s) => s.thinking);
  const sessionModel = useSessions((s) => s.runtime[id]?.model ?? null);
  const sessionThinking = useSessions((s) => s.runtime[id]?.thinking ?? null);
  const setModel = useSessions((s) => s.setModel);
  const setThinking = useSessions((s) => s.setThinking);
  return (
    <>
      <ContextRing usage={usage} stats={stats} size={14} align="right" />
      <ModelChip small model={sessionModel} onChange={(m) => void setModel(id, m)} />
      <ThinkingChip
        small
        value={sessionThinking ?? globalThinking}
        onChange={(l) => {
          void setThinking(id, l);
        }}
      />
    </>
  );
}

/** İzin modu çipi ve menüsü. */
export function PermissionChip({
  value,
  onChange,
}: {
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
}) {
  const { t } = useTranslation();
  const openAt = useMenu((s) => s.openAt);
  return (
    <Chip
      icon={PERMISSION_ICONS[value]}
      label={t(PERMISSION_KEYS[value])}
      warn={value === "full"}
      onClick={(e) =>
        openAt(e.currentTarget, {
          minWidth: 260,
          items: permissionMenuItems(t, value, onChange),
        })
      }
    />
  );
}

/**
 * Oturum içi izin çipi: oturumun kendi modunu gösterir (açılışta main'den gelir), seçim canlı
 * oturuma ve genel tercihe yazılır. Asistan ve Kodlama composer'larının sol ucunda durur.
 */
export function SessionPermissionChip({ id }: { id: string }) {
  const sessionMode = useSessions((s) => s.runtime[id]?.permission ?? null);
  const fallback = useModels((s) => s.permission);
  const setPermission = useSessions((s) => s.setPermission);
  return (
    <PermissionChip value={sessionMode ?? fallback} onChange={(p) => void setPermission(id, p)} />
  );
}

/** Düşünme seviyesi çipi. */
export function ThinkingChip({
  value,
  onChange,
  small,
}: {
  value: ThinkingLevel;
  onChange: (level: ThinkingLevel) => void;
  small?: boolean | undefined;
}) {
  const { t } = useTranslation();
  const openAt = useMenu((s) => s.openAt);
  return (
    <Chip
      icon="brain"
      small={small}
      title={t("chips.thinkingTitle")}
      label={t(THINKING_KEYS[value])}
      onClick={(e) =>
        openAt(e.currentTarget, {
          items: thinkingMenuItems(t, value, onChange),
        })
      }
    />
  );
}

/** Model çipi: sağlayıcı → alt menüde modeller. `model` verilirse (oturum) o gösterilir, yoksa genel tercih. */
export function ModelChip({
  onChange,
  small,
  model: override = null,
}: {
  onChange: (ref: { provider: string; id: string }) => void;
  small?: boolean | undefined;
  model?: ModelRef | null;
}) {
  const { t } = useTranslation();
  const openPicker = useModelPicker((s) => s.openAt);
  const globalModel = useModels((s) => s.model);
  const model = override ?? globalModel;
  // Katalogdaki görünen ad; tam "sağlayıcı/kimlik" yalnızca ipucunda.
  const name = useModels((s) =>
    model
      ? s.catalog.find((c) => c.provider === model.provider && c.id === model.id)?.name
      : undefined,
  );
  const full = model ? `${model.provider}/${model.id}` : "";
  const label = model ? (name ?? model.id) : t("chips.selectModel");

  return (
    <Chip
      mono
      small={small}
      label={label}
      {...(full ? { title: full } : {})}
      dataAttr="model-chip"
      onClick={(e) => openPicker(e.currentTarget, onChange, model)}
    />
  );
}
