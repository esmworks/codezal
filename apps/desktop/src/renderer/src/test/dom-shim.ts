/**
 * Bileşen testleri için asgari tarayıcı ortamı (yalnızca `desktop-ui` projesinin setup dosyası).
 *
 * Depoda jsdom/happy-dom yok; renderer modülleri import anında `window.codezal` köprüsüne,
 * `matchMedia`ya ve `document.body`ye dokunuyor. Statik çizim (`react-dom/server`) gerçek DOM
 * istemediği için buradaki sahteler yalnızca "import patlamasın" işini görür.
 */
const g = globalThis as unknown as Record<string, unknown>;

const node = (): Record<string, unknown> => ({
  toggleAttribute: () => {},
  setAttribute: () => {},
  removeAttribute: () => {},
  getAttribute: () => null,
  hasAttribute: () => false,
  addEventListener: () => {},
  removeEventListener: () => {},
  appendChild: () => {},
  removeChild: () => {},
  contains: () => false,
  style: {},
  classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
});

g.window = {
  codezal: { invoke: async () => undefined, on: () => () => {}, pathForFile: () => "" },
  matchMedia: () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }),
  addEventListener: () => {},
  removeEventListener: () => {},
  getSelection: () => null,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 16),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
};

g.document = {
  body: node(),
  documentElement: node(),
  head: node(),
  createElement: node,
  addEventListener: () => {},
  removeEventListener: () => {},
  querySelector: () => null,
  querySelectorAll: () => [],
};

const store = new Map<string, string>();
g.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
};
