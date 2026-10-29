import type { MemoryEntry, MemoryScope } from "@codezal/contracts";
import { localeOf } from "@codezal/i18n";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { shortAgo } from "../lib/format";
import { i18n } from "../lib/i18n";
import { useNow } from "../lib/useNow";
import { parseScopeKey, scopeKey, useMemory } from "../stores/memory";
import { askConfirm } from "./Confirm";
import { Icon } from "./Icon";
import { askText } from "./Prompt";

/**
 * Bir bellek kapsamının kayıtları: tür rozeti, açıklama, açılınca gövde, silme.
 * Ajanın yazdığı dosyalar da aynı listede görünür (memory:changed ile yenilenir).
 */
export function MemoryList({ scope, empty }: { scope: MemoryScope; empty: string }) {
  const { t, i18n } = useTranslation();
  const lang = localeOf(i18n.language);
  const now = useNow();
  const TYPE_LABEL: Record<MemoryEntry["type"], string> = {
    kullanici: t("memory.typeUser"),
    geribildirim: t("memory.typeFeedback"),
    proje: t("memory.typeProject"),
    kaynak: t("memory.typeSource"),
  };
  const key = scopeKey(scope);
  const entries = useMemory((s) => s.byScope[key]);
  const { load, remove } = useMemory();
  const [open, setOpen] = useState<string | null>(null);

  // Çağıran her render'da yeni nesne verebilir; anahtar üzerinden yükle ki döngü oluşmasın.
  useEffect(() => {
    void load(parseScopeKey(key));
  }, [load, key]);

  if (!entries || entries.length === 0) return <div className="text-[13px] text-tx3">{empty}</div>;
  return (
    <div className="flex flex-col gap-[6px]">
      {entries.map((e) => {
        const isOpen = open === e.name;
        return (
          <div key={e.name} className="group flex flex-col gap-1 text-[13px] leading-[1.5]">
            <div className="flex items-start gap-2">
              <button
                type="button"
                onClick={() => setOpen(isOpen ? null : e.name)}
                title={`${e.file} · ${shortAgo(e.updatedAt, lang, now)}`}
                className="min-w-0 flex-1 text-left text-tx2 hover:text-tx"
              >
                <span className="mr-[6px] rounded-[5px] border border-line bg-chip px-[5px] py-[1px] text-[11px] text-tx3">
                  {TYPE_LABEL[e.type]}
                </span>
                {e.description || e.name}
              </button>
              <button
                type="button"
                onClick={() => {
                  void askConfirm({
                    title: t("common.delete"),
                    body: t("memory.confirmDelete", { name: e.description || e.name }),
                    danger: true,
                  }).then((ok) => {
                    if (ok) void remove(scope, e.name);
                  });
                }}
                title={t("common.delete")}
                className="invisible mt-[3px] text-tx3 hover:text-red group-hover:visible"
              >
                <Icon name="x" size={11} stroke={2} />
              </button>
            </div>
            {isOpen && e.body && e.body !== e.description ? (
              <div className="whitespace-pre-wrap rounded-[8px] bg-bg px-3 py-2 text-[12px] leading-[1.55] text-tx2">
                {e.body}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** "Not ekle" akışı: tek satır sorar, kullanıcı türünde kaydeder. */
export function addMemoryNote(scope: MemoryScope): Promise<void> {
  return askText({
    title: i18n.t("memory.noteTitle"),
    placeholder: i18n.t("memory.notePlaceholder"),
    okLabel: i18n.t("memory.noteOk"),
  }).then((m) => {
    if (m) return useMemory.getState().save(scope, { description: m, type: "kullanici", body: m });
  });
}
