import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentEventInput, AgentEventType } from "@codezal/contracts";

type Listener<E> = (event: E) => void;
type EventOf<T extends AgentEventType> = Extract<AgentEvent, { type: T }>;

/**
 * Ajan olay veriyolu (PRD §7.4). Pi olayları burada normalize edilmiş AgentEvent olarak yayınlanır;
 * IPC köprüsü, izin yöneticisi, kullanım sayacı gibi tüketiciler bağımsız abone olur.
 *
 * Zarf alanları (`seq`, `epoch`) yalnızca burada eklenir: üreticiler gövdeyi verir, sıra numarasının
 * tek bir sahibi olur. Renderer snapshot ile canlı akışı bu sıra üzerinden uzlaştırır.
 */
export class AgentEventBus {
  readonly #all = new Set<Listener<AgentEvent>>();
  readonly #byType = new Map<AgentEventType, Set<Listener<AgentEvent>>>();
  /** Oturum başına verilen son sıra numarası; sıfır "hiç olay yok" demektir. */
  readonly #seqBySession = new Map<string, number>();
  /**
   * Motorun bu çalışmasına ait opak kimlik. Uygulama yeniden başlarsa değişir; istemci bunu
   * görünce imlecinin bayatladığını anlar ve sıra karşılaştırmasına güvenmez.
   */
  readonly #epoch: string;

  constructor(epoch: string = randomUUID()) {
    this.#epoch = epoch;
  }

  get epoch(): string {
    return this.#epoch;
  }

  /** Bir oturumda en son verilen sıra numarası; snapshot'ın `lastSeq` alanıyla eşleşir. */
  seqOf(sessionId: string): number {
    return this.#seqBySession.get(sessionId) ?? 0;
  }

  /** Tüm olaylara abone ol. Dönen fonksiyon aboneliği kaldırır. */
  subscribe(listener: Listener<AgentEvent>): () => void {
    this.#all.add(listener);
    return () => {
      this.#all.delete(listener);
    };
  }

  /** Tek bir olay türüne abone ol. */
  on<T extends AgentEventType>(type: T, listener: Listener<EventOf<T>>): () => void {
    let set = this.#byType.get(type);
    if (!set) {
      set = new Set();
      this.#byType.set(type, set);
    }
    const wrapped = listener as Listener<AgentEvent>;
    set.add(wrapped);
    return () => {
      set.delete(wrapped);
    };
  }

  /**
   * Olay yayınla. Zarf alanları burada eklenir; çağıranlar gövdeyi `AgentEventInput` olarak verir.
   * Yayılan nesne her aboneye aynı `seq` ile gider, böylece tüketiciler sıra üzerinde anlaşır.
   */
  emit(input: AgentEventInput): void {
    const seq = this.seqOf(input.sessionId) + 1;
    this.#seqBySession.set(input.sessionId, seq);
    // Spread bir union üzerinde çalıştığı için TypeScript sonucu tek gövdeye düzleştirir; zarf
    // alanları eklendiğinden değer gerçekten AgentEvent'tir, dönüşüm bu yüzden güvenlidir.
    const event = { ...input, seq, epoch: this.#epoch } as AgentEvent;
    const targets = [...this.#all, ...(this.#byType.get(event.type) ?? [])];
    for (const listener of targets) {
      try {
        listener(event);
      } catch (error) {
        // Aboneler birbirini düşürmemeli; hata yüzeye loglanır.
        console.error("[AgentEventBus] abone hatası", event.type, error);
      }
    }
  }

  get listenerCount(): number {
    let n = this.#all.size;
    for (const set of this.#byType.values()) n += set.size;
    return n;
  }
}
