import { createContext, Fragment, type ReactNode, useContext, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { langForFence } from "../lib/highlight";
import { type Block, blocksText, type Inline, parseMarkdown } from "../lib/markdown";
import { usePathExists } from "../lib/pathExists";
import { Clamp } from "./Clamp";
import { CodeView } from "./CodeView";
import { CopyButton } from "./CopyButton";

/**
 * Sohbet yanıtı metni. Ayrıştırma `lib/markdown.ts`'te; burada yalnızca tasarımın ölçüleri
 * uygulanır. Ölçüler ZCode'un yanıt metninden: gövde 14px/1.75 (hafif geniş harf aralığı),
 * bloklar arası 16px, satır içi kod 12px çip, başlık 18/16/14px.
 */
/**
 * Satır içi koddaki dosya yolları: sağlayan ekran (transkript) metnin yol olup olmadığına karar
 * verir, mutlak yola çevirir ve tıklanınca açar. Sağlayıcı yoksa (belge önizlemesi) çip düz
 * metin kalır.
 */
export const OpenPathContext = createContext<
  | {
      isPath: (text: string) => boolean;
      resolve: (text: string) => string;
      open: (path: string) => void;
    }
  | undefined
>(undefined);

/**
 * Satır içi **kod** çipi: yalnız tıklanmayan kod böyle çizilir. Taban sınıfta **renk yok**: kodu
 * (`text-accTx`) ve bağlantıyı (`text-link`) ayıran tek şey renk; iki `text-*` sınıfı yan yana
 * gelirse hangisinin kazandığı CSS sırasına kalır. Ölçüler: **gerçek** monospace yığını
 * (`--font-code`), gövdeden küçük boy ve `tracking-normal` (miras alınan harf aralığı kodu
 * açmasın). Kenarlık yok, yalnız soluk zemin (`bg-line`): art arda gelen çerçeveli çipler
 * paragrafı bir düğme dizisine çeviriyordu, koyu temada ince açık kenarlar daha da parlıyordu.
 */
const CODE_CHIP =
  "rounded-[4px] bg-line px-1 py-px font-code text-[12px] tracking-normal box-decoration-clone";
const CODE_TX = "text-accTx";

/**
 * Kısa çip satır sonunda bölünmez: `Codezal-Setup-` bir satırda, `<sürüm>.exe` ötekinde kalınca
 * çip iki yarım kutuya dönüyordu. Uzun yol ve komutlar yine kırılır (kolonu taşırmasınlar);
 * kırıldıklarında `box-decoration-clone` her parçaya kendi dolgusunu ve köşesini verir.
 */
const CHIP_NOWRAP_MAX = 40;
function chipClass(text: string): string {
  return text.length <= CHIP_NOWRAP_MAX ? `${CODE_CHIP} whitespace-nowrap` : CODE_CHIP;
}

/**
 * Tıklanabilir metnin ortak görünümü (bağlantı ve dosya yolu): mavi metin, metnin renginden soluk
 * ince çizgi; üzerine gelince ikisi birlikte koyulaşır. Mavi burada kodun değil,
 * tıklanabilirliğin rengi (docs/DESIGN.md §3). Font ve boyut **gövdeden miras alınır**: mavi yazı
 * cümlenin içinde duruyor, kendi yazı tipiyle ayrı bir katman gibi görünmemeli.
 */
const LINK_TX =
  "text-link underline decoration-link/40 decoration-1 underline-offset-[3px] hover:text-linkHov hover:decoration-link";

/**
 * Yol çipi: tıklanınca dosya açılır. **Çip değil bağlantı gibi** çizilir (mavi, çerçevesiz,
 * zeminsiz): gri zeminde mavi yazı iki zıt işaret taşıyordu — kullanıcı el imlecini görüp
 * "mavi ama kutu" diye okuyordu. Kod ile bağlantı artık tek bakışta ayrılır: gri kutu = kod,
 * mavi yazı = tıklanır. Mavi yazı gövdeyle aynı font ve boyutta çizilir; kod çipinin monospace
 * yığını yalnız çipe aittir, tıklanabilir metne taşınmaz.
 *
 * Bağlantı yalnız dosya diskte varsa çizilir; varlık belli olana dek de düz kod kalır ki sahte
 * bir "aç" düğmesi bir kare bile görünmesin.
 */
function InlineCode({ text }: { text: string }) {
  const { t } = useTranslation();
  const paths = useContext(OpenPathContext);
  const path = paths?.isPath(text) ? paths.resolve(text) : undefined;
  const exists = usePathExists(path);
  if (!paths || !path || exists !== true)
    return <code className={`${chipClass(text)} ${CODE_TX}`}>{text}</code>;
  return (
    <button
      type="button"
      title={t("transcript.openPath")}
      onClick={() => paths.open(path)}
      className={`${LINK_TX} cursor-pointer`}
    >
      {text}
    </button>
  );
}

function renderInline(nodes: readonly Inline[], keyPrefix: string): ReactNode[] {
  return nodes.map((n, i) => renderInlineNode(n, `${keyPrefix}-${i}`));
}

function renderInlineNode(n: Inline, key: string): ReactNode {
  switch (n.kind) {
    case "text":
      return <Fragment key={key}>{n.text}</Fragment>;
    case "br":
      return <br key={key} />;
    case "code":
      return <InlineCode key={key} text={n.text} />;
    case "bold":
      return (
        <b key={key} className="font-medium">
          {renderInline(n.children, key)}
        </b>
      );
    case "em":
      return <i key={key}>{renderInline(n.children, key)}</i>;
    case "del":
      return (
        <s key={key} className="text-tx3">
          {renderInline(n.children, key)}
        </s>
      );
    // Word önizlemesindeki izli değişiklikler diff renkleriyle, yorumlar amber vurguyla çizilir;
    // yorum metni üzerine gelince görünür ve vurgunun ardında kısa bir etiket olarak durur.
    case "ins":
      return (
        <ins key={key} className="text-add decoration-add/50 underline-offset-[3px]">
          {renderInline(n.children, key)}
        </ins>
      );
    case "removed":
      return (
        <del key={key} className="text-del decoration-del/60">
          {renderInline(n.children, key)}
        </del>
      );
    case "comment":
      return (
        <Fragment key={key}>
          {n.children.length > 0 ? (
            <mark title={n.note} className="rounded-[3px] bg-amber/15 text-inherit">
              {renderInline(n.children, key)}
            </mark>
          ) : null}
          {n.note ? (
            <span className="ml-1 rounded-[4px] bg-amber/15 px-1 text-[12px] text-amber">
              {n.note}
            </span>
          ) : null}
        </Fragment>
      );
    case "link":
      // Ana süreç setWindowOpenHandler ile dış tarayıcıya yönlendirir. Görünüm yol çipiyle ortak
      // (`LINK_TX`): tıklanabilir her metin aynı mavi + soluk çizgiyle yazılır.
      return (
        <a key={key} href={n.href} target="_blank" rel="noreferrer" className={LINK_TX}>
          {renderInline(n.children, key)}
        </a>
      );
  }
}

/** Sohbet ölçeği: başlıklar gövdeye yakın kalır. */
const HEADING_CHAT: Record<1 | 2 | 3 | 4, string> = {
  1: "text-[18px] font-semibold leading-[1.4]",
  2: "text-[16px] font-semibold leading-[1.4]",
  3: "text-[14px] font-semibold leading-[1.5]",
  4: "text-[14px] font-semibold leading-[1.5]",
};

/** Belge ölçeği (dosya önizlemesi): başlık hiyerarşisi belirgin, üstte daha geniş boşluk. */
const HEADING_DOC: Record<1 | 2 | 3 | 4, string> = {
  1: "text-[22px] font-semibold leading-[1.3] tracking-[-0.01em]",
  2: "text-[18px] font-semibold leading-[1.35]",
  3: "text-[15px] font-semibold leading-[1.4]",
  4: "text-[14px] font-semibold leading-[1.5] text-tx2",
};
const HEADING_DOC_GAP: Record<1 | 2 | 3 | 4, string> = {
  1: "mt-3",
  2: "mt-3",
  3: "mt-2",
  4: "mt-1",
};

const ALIGN_CLASS = { left: "text-left", center: "text-center", right: "text-right" } as const;

/** Kod bloğu: çok uzun yapıştırılmış çıktılar 20 satır önizlemeyle katlanır. */
function CodeBlock({ text, lang }: { text: string; lang: string | null }) {
  return (
    <div className="rounded-xl border border-line bg-bg px-3 py-2">
      <Clamp
        text={text}
        lines={20}
        chars={2400}
        render={(code) => (
          <div className="overflow-x-auto">
            <CodeView code={code} lang={lang} />
          </div>
        )}
      />
    </div>
  );
}

/**
 * Düzyazının okuma genişliği: yalnız çok geniş kolonda (≥1536px alanda 1152px) devreye girer,
 * satır ~100 karakterde kırılır. Daha dar sınır (72ch) aynı metni fazla satıra bölüp dikey boşluğu
 * büyütüyordu; sık satır aralığıyla uzun satır rahat okunur. Kod, tablo ve kartlar tam genişlik.
 */
const PROSE = "max-w-[90ch]";

function renderBlock(b: Block, key: string, first: boolean, doc: boolean): ReactNode {
  switch (b.kind) {
    case "p":
      return (
        <div key={key} className={PROSE}>
          {renderInline(b.children, key)}
        </div>
      );
    case "h":
      return (
        <div
          key={key}
          className={`${PROSE} ${(doc ? HEADING_DOC : HEADING_CHAT)[b.level]} ${first ? "" : doc ? HEADING_DOC_GAP[b.level] : "mt-2"}`}
        >
          {renderInline(b.children, key)}
        </div>
      );
    case "code":
      return <CodeBlock key={key} text={b.text} lang={langForFence(b.lang)} />;
    case "list":
      return (
        <div key={key} className={`${PROSE} flex flex-col gap-1 pl-1`}>
          {b.items.map((it, j) => {
            const k = `${key}-${j}`;
            const marker =
              it.checked !== undefined
                ? it.checked
                  ? "☑"
                  : "☐"
                : b.ordered
                  ? `${b.start + j}.`
                  : "•";
            return (
              <div key={k} className="flex flex-col gap-1">
                <div className="flex gap-2">
                  <span
                    className={`shrink-0 text-tx3 ${b.ordered ? "min-w-[18px] text-right tabular-nums" : ""}`}
                  >
                    {marker}
                  </span>
                  <span className={`min-w-0 ${it.checked ? "text-tx3 line-through" : ""}`}>
                    {renderInline(it.content, k)}
                  </span>
                </div>
                {it.children.length ? (
                  <div className="flex flex-col gap-1 pl-[22px]">
                    {it.children.map((c, m) => renderBlock(c, `${k}-${m}`, false, doc))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      );
    case "table":
      return (
        <div key={key} className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full border-collapse text-[14px] leading-[1.5]">
            <thead>
              <tr>
                {b.head.map((c, j) => (
                  <th
                    key={`${key}-h${j}`}
                    className={`whitespace-nowrap border-b border-line px-3 py-2 font-normal text-tx3 ${ALIGN_CLASS[b.align[j] ?? "left"]}`}
                  >
                    {renderInline(c, `${key}-h${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={`${key}-r${ri}`} className="border-line border-b last:border-b-0">
                  {r.map((c, j) => (
                    <td
                      key={`${key}-r${ri}-${j}`}
                      className={`px-3 py-2 align-top ${ALIGN_CLASS[b.align[j] ?? "left"]}`}
                    >
                      {renderInline(c, `${key}-r${ri}-${j}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "quote":
      // Sohbette alıntı çoğunlukla yapıştırılacak bir taslaktır (tweet, e-posta, commit mesajı):
      // üzerine gelince sağ üstte kopyala düğmesi çıkar, panoya işaretsiz düz metin gider.
      // Belge önizlemesinde alıntı metnin parçasıdır, düğme çizilmez.
      return (
        <div
          key={key}
          className={`${PROSE} group/quote relative flex flex-col gap-2 border-l-2 border-line2 pl-3 text-tx2 ${doc ? "" : "pr-8"}`}
        >
          {b.children.map((c, j) => renderBlock(c, `${key}-${j}`, j === 0, doc))}
          {doc ? null : (
            <CopyButton
              text={blocksText(b.children)}
              size={13}
              className="absolute top-0 right-0 flex h-[22px] w-[22px] items-center justify-center rounded-[6px] text-tx3 opacity-0 hover:bg-hov hover:text-tx focus-visible:opacity-100 group-hover/quote:opacity-100"
            />
          )}
        </div>
      );
    case "hr":
      return <div key={key} className="h-px bg-line" />;
  }
}

/**
 * `document`: dosya önizlemesi gibi uzun metinlerde başlıklar belge ölçeğinde çizilir;
 * sohbette varsayılan kompakt ölçek kullanılır.
 */
export function Markdown({ text, document = false }: { text: string; document?: boolean }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    // Sohbet gövdesi: 1.5 satır aralığı, normal harf aralığı, 12px blok arası. Eskiden 1.75 +
    // `tracking-wide` + 16px idi; küçük yazıda satırlar seyrek duruyor, metin blok olarak
    // okunmuyordu (Claude masaüstünde oran ~1.4).
    <div className="flex flex-col gap-3 break-words text-[14px] leading-[1.5] text-tx">
      {blocks.map((b, i) => renderBlock(b, `b${i}`, i === 0, document))}
    </div>
  );
}
