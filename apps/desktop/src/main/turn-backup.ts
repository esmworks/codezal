import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  changedFromHead,
  changedSince,
  existsInSnapshot,
  repoLocation,
  restoreFromSnapshot,
  snapshotTree,
  unstageMissing,
  untrackedFiles,
} from "./git.js";
import { log } from "./log.js";

/**
 * Tur bazlı tam geri alma. Tur başında çalışma ağacının git kaydı alınır (`git stash create`;
 * stash listesine eklenmez), tur bitince **o turda değişen dosyalar mühürlenir**. "Geri al" yalnız
 * istenen turun mühürlü dosya kümesini geri alır; sonraki turların çalışmasına dokunmaz. Terminal
 * komutlarının (`bash`) yaptığı değişiklikler de kapsanır; tur öncesi var olan kullanıcı
 * değişiklikleri korunur. Git deposu olmayan projelerde kayıt alınmaz ve çağıran dosya yedeklerine
 * düşer.
 *
 * Neden mühürleme `run_end`'de: geri alma isteği turun **kullanıcı sırasıyla** (`userOrdinal`)
 * gelir ve o sıra ancak tur bitince kesinleşir. `run_start` anında yeni kullanıcı mesajı henüz
 * Pi'nin `session.messages` listesine girmez (mesaj ajan döngüsünün ilk adımında eklenir), orada
 * sayılsa her tur bir eksik numaralanır ve "Geri al" bir önceki turu hedeflerdi. Bu yüzden kayıt
 * önce "açık" doğar, `run_end` onu kapanış sırasıyla mühürler.
 */
interface TurnSnapshot {
  /** `git stash create` commit'i; tur öncesi çalışma ağacı temizse null (referans HEAD). */
  ref: string | null;
  /** Tur öncesi izlenmeyen dosyalar; turda oluşanlar silinirken bunlar korunur. */
  untrackedBefore: string[];
  /**
   * Mühürlendiği andaki kullanıcı mesajı sayısı: bu turun kapsadığı **son** sıra. Tur sırasında
   * teslim edilen yönlendirmeler sayıyı birden fazla artırabilir, bu yüzden kapsam aralıktır:
   * `from`'dan `to`'ya kadar olan bütün sıralar bu tura aittir. Açıkken null.
   */
  to: number | null;
  /** Bu turun kapsamadığı son sıra: önceki mühürlü kaydın `to` değeri (ilk turda 0). */
  from: number;
  /** Mühürlenince: turda değişen izlenen dosyalar. */
  changed: string[];
  /** Mühürlenince: turda oluşan izlenmeyen dosyalar. */
  untrackedCreated: string[];
  /**
   * Oturum deponun alt klasöründeyse kök ve önek (`alt/`); kökteyse null. Klasör dışındaki
   * değişiklikler geri alınmaz (tur kaydı ve bash yedeği oturum klasörüyle sınırlı), yalnız
   * `outside` ile kullanıcıya bildirilir.
   */
  scope: { top: string; prefix: string; untrackedBefore: string[] } | null;
  /** Mühürlenince: turda oturum klasörü dışında değişen ya da oluşan dosyalar (köke göre yol). */
  outside: string[];
}

/** Oturum başına tutulan tur kaydı sayısı; eskiler düşer (geri alma zaten yakın turlar için). */
export const MAX_TURN_SNAPSHOTS = 50;

interface SessionTurns {
  entries: TurnSnapshot[];
  /** Mühürlenmiş son sıra; sıradaki kaydın `from` değeri buradan gelir. */
  sealed: number;
}

const snapshots = new Map<string, SessionTurns>();

/**
 * Oturum başına işlem kuyruğu: `begin` ve `seal` sırayla koşar. `run_start`/`run_end` dinleyicileri
 * ikisini de beklemeden başlatır; `begin` git komutlarını bitirmeden tur biterse `seal` açık kayıt
 * bulamayıp boş dönüyor, geç eklenen açık kayıt da **sonraki** tura karışıyordu (o turun
 * mührünü alıp iki turu tek kayıtta topluyordu). Kuyrukla `seal` daima kendi turunun `begin`'ini
 * bekler; sonraki turun `begin`'i de önceki mühür bitince açılır.
 */
const queues = new Map<string, Promise<void>>();

function enqueue(sessionId: string, task: () => Promise<void>): Promise<void> {
  const prev = queues.get(sessionId) ?? Promise.resolve();
  // Önceki adım düşse de kuyruk sürer (adımlar hatalarını kendileri günlüğe yazar).
  const next = prev.catch(() => undefined).then(task);
  queues.set(sessionId, next);
  void next
    .catch(() => undefined)
    .finally(() => {
      if (queues.get(sessionId) === next) queues.delete(sessionId);
    });
  return next;
}

/** Oturum silinince kaydı bırak (bellekte kalmasın). */
export function forgetTurnSnapshot(sessionId: string): void {
  snapshots.delete(sessionId);
  queues.delete(sessionId);
}

/**
 * Geri sarma: `userOrdinal`den **sonraki** bütün turların kaydı düşer.
 *
 * Geri sar, dalı o noktaya keser; engine'in kullanıcı mesajı sayısı da düşer. Kayıtlar
 * temizlenmezse `sealed` eski (büyük) değerde kalır ve yeni turun kapsamı `(sealed, to]` boş
 * çıkar: "Geri al" isteği, atılmış eski turun kaydına düşer — silinmiş turun dosyalarını geri
 * getirir ve yeni turun değişikliklerini yerinde bırakırdı (tam ters sonuç).
 */
export function rewindTurnSnapshots(sessionId: string, userOrdinal: number): void {
  const state = snapshots.get(sessionId);
  if (!state) return;
  state.entries = state.entries.filter((entry) => entry.to !== null && entry.to < userOrdinal);
  state.sealed = userOrdinal - 1;
}

function stateOf(sessionId: string): SessionTurns {
  const existing = snapshots.get(sessionId);
  if (existing) return existing;
  const fresh: SessionTurns = { entries: [], sealed: 0 };
  snapshots.set(sessionId, fresh);
  return fresh;
}

/** Tur farkını ölçer: kayıt varsa ona göre, ağaç temizken alınan kayıtta HEAD'e göre. */
async function changedPaths(cwd: string, ref: string | null): Promise<string[]> {
  return ref ? changedSince(cwd, ref) : changedFromHead(cwd);
}

/** Önekin (oturum klasörü) dışında kalan köke göre yollar. */
function outsideOf(paths: string[], prefix: string): string[] {
  return paths.filter((path) => !path.startsWith(prefix));
}

/** Alt klasör oturumunda turun klasör dışında değiştirdiği izlenen ve oluşturduğu izlenmeyen dosyalar. */
async function outsideChanges(
  scope: { top: string; prefix: string; untrackedBefore: string[] },
  ref: string | null,
): Promise<string[]> {
  // Kökte çalışınca `--relative` etkisizdir: yollar köke göre ve tüm depoyu kapsar.
  const tracked = outsideOf(await changedPaths(scope.top, ref), scope.prefix);
  const before = new Set(scope.untrackedBefore);
  const created = outsideOf(await untrackedFiles(scope.top), scope.prefix).filter(
    (path) => !before.has(path),
  );
  return [...tracked, ...created];
}

/**
 * Tur başında çağrılır; git deposu değilse ya da komut düşerse kayıt tutulmaz. Aynı tur içinde
 * yeniden çağrılırsa (sürdürme turu yeni `run_start` açmaz) açık kayıt korunur: kaydın anlamı
 * "tur öncesi"dir, tur ortasında yenilenmesi geri almayı turun yarısına indirirdi.
 */
export function beginTurnSnapshot(sessionId: string, cwd: string): Promise<void> {
  // Durum çağrı anında bağlanır: kuyrukta beklerken oturum silinirse (`forgetTurnSnapshot`) geç
  // koşan adım silinmiş oturumun kaydını yeniden yaratmasın.
  const state = stateOf(sessionId);
  return enqueue(sessionId, () => openSnapshot(sessionId, cwd, state));
}

async function openSnapshot(sessionId: string, cwd: string, state: SessionTurns): Promise<void> {
  if (snapshots.get(sessionId) !== state) return;
  // Kuyruk sayesinde önceki turun mührü burada bitmiştir. Yine de birden fazla ya da sonda olmayan
  // açık kayıt kalmışsa (mühür düşmüş, `run_end` gelmemiş) bayattır: düşürülür, yeni tur kendi
  // kaydını açar. Tek ve son açık kayıt aynı turun sürdürmesidir, korunur.
  const open = state.entries.filter((entry) => entry.to === null);
  if (open.length > 0) {
    const last = state.entries[state.entries.length - 1];
    if (open.length === 1 && last === open[0]) return;
    state.entries = state.entries.filter((entry) => entry.to !== null);
  }
  try {
    const ref = await snapshotTree(cwd);
    const untrackedBefore = await untrackedFiles(cwd);
    const { top, prefix } = await repoLocation(cwd);
    const scope = prefix
      ? { top, prefix, untrackedBefore: outsideOf(await untrackedFiles(top), prefix) }
      : null;
    state.entries.push({
      ref,
      untrackedBefore,
      to: null,
      from: state.sealed,
      changed: [],
      untrackedCreated: [],
      scope,
      outside: [],
    });
    if (state.entries.length > MAX_TURN_SNAPSHOTS) {
      state.entries.splice(0, state.entries.length - MAX_TURN_SNAPSHOTS);
    }
  } catch (error) {
    log.warn("turn-backup", `${sessionId}: tur kaydı alınamadı (${String(error)})`);
  }
}

/**
 * Tur bitince çağrılır: o turda değişen dosya kümesi dondurulur ve kayıt `ordinal` ile mühürlenir.
 * Böylece sonraki turlar kaydı kaydırsa da geri alma doğru dosyaları hedefler. `run_end` olmadan
 * (uygulama çöktü) kalan açık kayıt mühürsüz kalır ve geri almada atlanır.
 */
export function sealTurnSnapshot(sessionId: string, cwd: string, ordinal: number): Promise<void> {
  return enqueue(sessionId, () => sealSnapshot(sessionId, cwd, ordinal));
}

async function sealSnapshot(sessionId: string, cwd: string, ordinal: number): Promise<void> {
  const state = snapshots.get(sessionId);
  const entry = state?.entries.findLast((item) => item.to === null);
  if (!state || !entry) return;
  try {
    entry.changed = await changedPaths(cwd, entry.ref);
    const before = new Set(entry.untrackedBefore);
    entry.untrackedCreated = (await untrackedFiles(cwd)).filter((path) => !before.has(path));
    entry.outside = entry.scope ? await outsideChanges(entry.scope, entry.ref) : [];
    entry.to = ordinal;
    state.sealed = Math.max(state.sealed, ordinal);
  } catch (error) {
    // Ölçüm düşerse kayıt listeden **düşürülür**: mühürsüz bırakılsaydı `beginTurnSnapshot` yeni
    // kayıt açmayı reddeder ve sonraki başarılı mühürleme bu eski kaydı yeniden kullanıp ona daha
    // büyük bir sıra yazardı — tek kayıt birkaç turu kapsar, "Geri al" hepsini silerdi.
    state.entries = state.entries.filter((item) => item !== entry);
    log.warn("turn-backup", `${sessionId}: tur kaydı mühürlenemedi (${String(error)})`);
  }
}

/**
 * İstenen turun (kullanıcı sırası) dosyalarını tur öncesi hâline döndürür: turda değişen izlenen
 * dosyalar kayıt/HEAD hâline döner, turda oluşan dosyalar silinir. Tur kapsayan kayıt yoksa boş
 * döner (çağıran dosya bazlı yedeğe düşer).
 */
export async function undoTurn(
  sessionId: string,
  cwd: string,
  ordinal: number,
): Promise<{ restored: string[]; removed: string[]; outside: string[] }> {
  // Tur yeni bittiyse mühür hâlâ sürüyor olabilir; bitmesi beklenir, yoksa geri alma kaydı
  // bulamayıp dosya yedeklerine düşerdi.
  await queues.get(sessionId)?.catch(() => undefined);
  const state = snapshots.get(sessionId);
  // Kapsam aralığı: (from, to] aralığı `ordinal`i içeren mühürlü kayıt o turu temsil eder.
  const entry = state?.entries.find(
    (item) => item.to !== null && item.from < ordinal && ordinal <= item.to,
  );
  if (!entry) return { restored: [], removed: [], outside: [] };

  const restored: string[] = [];
  const removed: string[] = [];
  const ref = entry.ref ?? "HEAD";
  const target = join(cwd, "");
  for (const path of entry.changed) {
    try {
      if (await existsInSnapshot(cwd, ref, path)) {
        await restoreFromSnapshot(cwd, ref, path);
        restored.push(path);
      } else {
        // Turda oluşturulan izlenen dosya: kayıtta yok → çalışma ağacından ve index'ten sil.
        await unstageMissing(cwd, path);
        await rm(join(target, path), { force: true });
        removed.push(path);
      }
    } catch {
      // Tek dosya hatası (kilit, izin) diğerlerini durdurmasın.
    }
  }
  for (const path of entry.untrackedCreated) {
    try {
      await rm(join(target, path), { force: true });
      removed.push(path);
    } catch {
      // Silinemeyen dosya rapor edilmez; kullanıcı dosyayı elle kaldırabilir.
    }
  }
  // Kayıt listede kalır: aynı sıranın ikinci kez istenmesi (ya da başka bir sıranın aranması)
  // kapsam aralığından doğru kaydı bulmaya devam eder. Geri alma zaten aynı hedefe yazar.
  return { restored, removed, outside: entry.outside };
}
