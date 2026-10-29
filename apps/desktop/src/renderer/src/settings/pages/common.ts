import type { AppSettings } from "@codezal/contracts";
import { useSettings } from "../../stores/settings";
import { humanizeError, toast } from "../../stores/toast";

export type S = AppSettings;
export type Patch = (p: Partial<S>) => void;

export function useSettingsPatch(): [S | null, Patch] {
  const settings = useSettings((x) => x.settings);
  const patch = useSettings((x) => x.patch);
  // Yazım düşerse mağaza iyimser değeri geri alır; kullanıcıya da söylenir. Sessiz kalınsaydı
  // anahtar açık görünür, ayar dosyasına hiç yazılmamış olurdu.
  return [settings, (p) => void patch(p).catch((e: unknown) => toast.error(humanizeError(e)))];
}
