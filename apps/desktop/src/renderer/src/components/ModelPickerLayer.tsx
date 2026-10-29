import type { CatalogModel } from "@codezal/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatTokens } from "../lib/format";
import { useLocale } from "../lib/i18n";
import { flatModels, initialSelection, modelGroups, providerEntries } from "../lib/modelPicker";
import { useApp } from "../stores/app";
import { useModelPicker } from "../stores/modelPicker";
import { useModels } from "../stores/models";
import { Icon } from "./Icon";

const LEFT_W = 200;
const WIDTH = 580;
const MAX_H = 480;

/** İmleci liste sınırında tutar; liste boşsa 0. */
const clamp = (n: number, len: number) => Math.max(0, Math.min(Math.max(len - 1, 0), n));

function Badge({ children, tone = "" }: { children: string; tone?: string }) {
  return (
    <span
      className={`shrink-0 rounded-[5px] border border-line px-[5px] py-[1px] font-mono text-[11px] text-tx3 ${tone}`}
    >
      {children}
    </span>
  );
}

/** Model satırı: sağ sütun ve arama sonucu aynı satırı çizer (rozetler + geçerli işareti). */
function ModelRow({
  model,
  index,
  active,
  current,
  hint,
  onHover,
  onPick,
}: {
  model: CatalogModel;
  index: number;
  active: boolean;
  current: boolean;
  /** "Son kullanılan" grubunda modelin sağlayıcısı; aynı kimlik iki sağlayıcıda olabilir. */
  hint?: string | undefined;
  onHover: () => void;
  onPick: () => void;
}) {
  const { t } = useTranslation();
  const lang = useLocale();
  return (
    <button
      type="button"
      data-idx={index}
      title={`${model.provider}/${model.id}`}
      onMouseEnter={onHover}
      onClick={onPick}
      className={`flex w-full items-center gap-[8px] rounded-[6px] px-[9px] py-[6px] text-left ${
        active ? "bg-chip" : ""
      }`}
    >
      {hint ? <span className="shrink-0 font-mono text-[11px] text-tx3">{hint}</span> : null}
      <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-tx">{model.id}</span>
      {model.reasoning ? <Badge>{t("modelPicker.thinking")}</Badge> : null}
      {model.vision ? <Badge>{t("modelPicker.vision")}</Badge> : null}
      {model.contextWindow > 0 ? <Badge>{formatTokens(model.contextWindow, lang)}</Badge> : null}
      <span className={`w-[14px] text-[13px] text-tx2 ${current ? "" : "invisible"}`}>✓</span>
    </button>
  );
}

/**
 * Model seçici: iki kademeli panel. Sol sütun "Son kullanılan" ve bağlı sağlayıcılar, sağ sütun
 * seçili sağlayıcının modelleri (rozetler ve geçerli işareti). Arama yazılınca tüm sağlayıcılarda
 * düz sonuç listesine döner. Klavye: ←/→ sütun, ↑/↓ satır, Enter seçer, Esc kapatır.
 */
export function ModelPickerLayer() {
  const { t } = useTranslation();
  const open = useModelPicker((s) => s.open);
  const close = useModelPicker((s) => s.close);
  const { model: globalModel, providers, catalog, recent } = useModels();
  const model = open?.current ?? globalModel;
  const [query, setQuery] = useState("");
  const [pane, setPane] = useState<"providers" | "models">("models");
  const [groupIdx, setGroupIdx] = useState(0);
  const [modelIdx, setModelIdx] = useState(0);
  const [flatIdx, setFlatIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const flatRef = useRef<HTMLDivElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  /** Son girdi klavyeden mi geldi: kaydırma yalnızca o zaman yapılır, fareyle üzerinden
   * geçerken satırlar imlecin altında kaymaz. */
  const keyboardNav = useRef(false);

  // Sol sütun kaynaklı seçim; "Son kullanılan" grubu en başta durur.
  const entries = useMemo(
    () => providerEntries(catalog, providers, recent),
    [catalog, providers, recent],
  );
  // Arama sonuçları: aynı veri, sağlayıcı başına gruplanmış düz liste.
  const groups = useMemo(
    () => modelGroups(catalog, providers, recent, query),
    [catalog, providers, recent, query],
  );
  const flat = useMemo(() => flatModels(groups), [groups]);
  const searching = query.trim().length > 0;
  const models = entries[groupIdx]?.models ?? [];
  const connectedCount = providers.filter((p) => p.connected).length;
  const providerName = useMemo(() => new Map(providers.map((p) => [p.id, p.name])), [providers]);
  const isCurrent = (m: CatalogModel) => m.provider === model?.provider && m.id === model?.id;

  // Açılınca sıfırla, arama satırına odaklan ve geçerli modelin sağlayıcısında konumlan.
  // biome-ignore lint/correctness/useExhaustiveDependencies: yalnızca açılışta
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setPane("models");
    const sel = initialSelection(providerEntries(catalog, providers, recent), model);
    setGroupIdx(sel.group);
    setModelIdx(sel.model);
    setFlatIdx(0);
    keyboardNav.current = true;
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [open]);

  // Sorgu değişince sonuç imleci başa döner (arama satırının onChange'i sıfırlar).

  useEffect(() => {
    if (!keyboardNav.current) return;
    groupRef.current
      ?.querySelector<HTMLElement>(`[data-gidx="${groupIdx}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [groupIdx]);

  // Sağlayıcı değişince sağ sütun başa döner; imleç de 0'a iner. Seçili grubun model dizisi
  // grup değişiminde yeniden üretildiği için bağımlılık dizinin kendisidir.
  useEffect(() => {
    if (models.length === 0) return;
    modelRef.current?.scrollTo({ top: 0 });
  }, [models]);

  useEffect(() => {
    if (!keyboardNav.current) return;
    modelRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${modelIdx}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [modelIdx]);

  useEffect(() => {
    if (!keyboardNav.current) return;
    flatRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${flatIdx}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [flatIdx]);

  if (!open) return null;
  const { rect, onChange } = open;
  const pick = (m: CatalogModel) => {
    onChange({ provider: m.provider, id: m.id });
    close();
  };
  const manage = () => {
    close();
    useApp.getState().setSettingsOpen(true, "baglanti");
  };
  /** Sol sütun seçimi: sağlayıcı değişince model imleci başa döner. */
  const selectGroup = (i: number, focus: "providers" | "models") => {
    if (i !== groupIdx) {
      setGroupIdx(i);
      setModelIdx(0);
    }
    setPane(focus);
  };
  const onKey = (e: React.KeyboardEvent) => {
    keyboardNav.current = true;
    if (e.key === "Escape") {
      // Seçiciyi kapatan Esc süren turu durdurmasın, Ayarlar'ı kapatmasın.
      e.preventDefault();
      close();
      return;
    }
    if (searching) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFlatIdx((c) => clamp(c + 1, flat.length));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFlatIdx((c) => clamp(c - 1, flat.length));
      } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
        const m = flat[flatIdx];
        if (m) pick(m);
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      if (pane === "providers") selectGroup(clamp(groupIdx + delta, entries.length), "providers");
      else setModelIdx((c) => clamp(c + delta, models.length));
      return;
    }
    // Yalnız ArrowRight panel değiştirir: Tab odak taşır. İkisi birlikte yakalandığında odak
    // panelden hiç çıkamıyor, alttaki "Modelleri yönet" düğmesine klavyeyle ulaşılamıyordu.
    if (e.key === "ArrowRight") {
      e.preventDefault();
      setPane("models");
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setPane("providers");
      return;
    }
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      if (pane === "providers") setPane("models");
      else {
        const m = models[modelIdx];
        if (m) pick(m);
      }
    }
  };

  // Yerleşim: altta yer varsa aşağı, yoksa yukarı açılır. Yükseklik içeriğe göre değişmez;
  // sağlayıcı değiştikçe ya da arama açıldıkça panel büyüyüp küçülmesin diye bir kez sabitlenir.
  const spaceBelow = window.innerHeight - rect.bottom - 8;
  const below = spaceBelow >= 320 || spaceBelow >= rect.top - 8;
  const panelH = Math.max(160, Math.min(MAX_H, below ? spaceBelow : rect.top - 8));
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - WIDTH - 8));
  const pos = below
    ? { top: rect.bottom + 4, left }
    : { bottom: window.innerHeight - rect.top + 4, left };

  let idx = -1;
  return (
    <>
      <div className="fixed inset-0 z-[140]" onMouseDown={close} />
      <div
        className="fixed z-[141] flex flex-col overflow-hidden rounded-[10px] border border-line2 bg-card shadow-panel"
        style={{ ...pos, width: WIDTH, height: panelH }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKey}
      >
        <div className="flex items-center gap-2 border-b border-line px-[12px] py-[8px]">
          <Icon name="search" size={13} className="shrink-0 text-tx3" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setFlatIdx(0);
            }}
            placeholder={t("modelPicker.searchPlaceholder")}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-tx outline-none placeholder:text-tx3"
          />
          <span className="shrink-0 font-mono text-[11px] text-tx3">
            {searching ? flat.length : models.length}
          </span>
        </div>
        <div className="flex min-h-0 flex-1">
          {connectedCount === 0 ? (
            <div className="flex-1 px-[14px] py-[16px] text-[13px] leading-[1.5] text-tx3">
              {t("modelPicker.noProviders")}
            </div>
          ) : searching ? (
            <div ref={flatRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto p-[5px]">
              {flat.length === 0 ? (
                <div className="px-[9px] py-[14px] text-[13px] text-tx3">
                  {t("modelPicker.noMatch")}
                </div>
              ) : null}
              {groups.map((g) => (
                <div key={g.key} className="flex flex-col gap-[1px]">
                  <div className="px-[9px] pt-[7px] pb-[3px] text-[11px] uppercase tracking-[0.06em] text-tx3">
                    {g.key === "recent" ? t("modelPicker.recent") : g.title}
                  </div>
                  {g.models.map((m) => {
                    idx += 1;
                    const i = idx;
                    return (
                      <ModelRow
                        key={`${g.key}:${m.provider}/${m.id}`}
                        model={m}
                        index={i}
                        active={i === flatIdx}
                        current={isCurrent(m)}
                        onHover={() => {
                          keyboardNav.current = false;
                          setFlatIdx(i);
                        }}
                        onPick={() => pick(m)}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          ) : (
            <>
              <div
                ref={groupRef}
                className="flex min-h-0 shrink-0 flex-col gap-[1px] overflow-y-auto border-r border-line p-[5px]"
                style={{ width: LEFT_W }}
              >
                {entries.map((g, i) => (
                  <button
                    type="button"
                    key={g.key}
                    data-gidx={i}
                    onMouseEnter={() => {
                      keyboardNav.current = false;
                      selectGroup(i, "providers");
                    }}
                    onClick={() => selectGroup(i, "models")}
                    className={`flex w-full items-center gap-[7px] rounded-[6px] px-[9px] py-[6px] text-left ${
                      i === groupIdx ? "bg-chip" : ""
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate text-[13px] text-tx">
                      {g.key === "recent" ? t("modelPicker.recent") : (g.title ?? g.key)}
                    </span>
                    {g.models.some(isCurrent) ? (
                      <span className="shrink-0 text-[12px] text-tx2">✓</span>
                    ) : null}
                    <span className="shrink-0 font-mono text-[11px] text-tx3">
                      {g.models.length}
                    </span>
                    <span
                      className={`shrink-0 text-[12px] ${i === groupIdx ? "text-tx2" : "text-tx3"}`}
                    >
                      ›
                    </span>
                  </button>
                ))}
              </div>
              <div
                ref={modelRef}
                className="flex min-h-0 min-w-0 flex-1 flex-col gap-[1px] overflow-y-auto p-[5px]"
              >
                {models.length === 0 ? (
                  <div className="px-[9px] py-[14px] text-[13px] leading-[1.5] text-tx3">
                    {t("modelPicker.emptyProvider")}
                  </div>
                ) : (
                  models.map((m, i) => (
                    <ModelRow
                      key={`${m.provider}/${m.id}`}
                      model={m}
                      index={i}
                      active={i === modelIdx}
                      current={isCurrent(m)}
                      hint={
                        entries[groupIdx]?.key === "recent"
                          ? (providerName.get(m.provider) ?? m.provider)
                          : undefined
                      }
                      onHover={() => {
                        keyboardNav.current = false;
                        setModelIdx(i);
                        setPane("models");
                      }}
                      onPick={() => pick(m)}
                    />
                  ))
                )}
              </div>
            </>
          )}
        </div>
        <button
          type="button"
          onClick={manage}
          className="flex items-center gap-2 border-t border-line px-[14px] py-[8px] text-left text-[13px] text-tx hover:bg-hov"
        >
          <Icon name="gear" size={13} className="text-tx2" />
          {t("settings.connection.manageModelsLabel")}
          <span className="flex-1" />
          <span className="font-mono text-[11px] text-tx3">
            {t("modelPicker.connectedCount", { count: connectedCount })}
          </span>
        </button>
      </div>
    </>
  );
}
