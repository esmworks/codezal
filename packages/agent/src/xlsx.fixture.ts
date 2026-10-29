import { buildZip } from "./docx.fixture.js";

/** Test .xlsx üreticisi: sayfa XML'i elle yazılır ki okuyucu ve düzenleyici uç durumlarla sınansın. */

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const CT = "application/vnd.openxmlformats-officedocument.spreadsheetml";
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

export interface FixtureSheet {
  name: string;
  /** `<worksheet>` içi: `<sheetData>…</sheetData><mergeCells>…` */
  body: string;
  state?: "hidden" | "veryHidden";
  /** Sayfanın ilişkileri: kimlik → [tür sonu, hedef (sayfaya göre)] */
  rels?: Record<string, [string, string]>;
}

export interface FixtureBook {
  sheets: FixtureSheet[];
  shared?: string[];
  /** `<numFmts>` ve `<cellXfs>` içi; verilmezse tek varsayılan stil. */
  numFmts?: string;
  cellXfs?: string;
  definedNames?: string;
  workbookPr?: string;
  /** Ek paket girdileri (tablo, not, çizim…). */
  parts?: Record<string, string>;
  /** Ek içerik türü geçersiz kılmaları: parça → tür. */
  types?: Record<string, string>;
  calcChain?: boolean;
}

/** `<c>` yardımcıları */
export const n = (ref: string, v: number, s?: number) =>
  `<c r="${ref}"${s ? ` s="${s}"` : ""}><v>${v}</v></c>`;
export const str = (ref: string, text: string, s?: number) =>
  `<c r="${ref}" t="inlineStr"${s ? ` s="${s}"` : ""}><is><t>${text}</t></is></c>`;
export const fx = (ref: string, formula: string, v?: number | string, s?: number) =>
  `<c r="${ref}"${typeof v === "string" ? ' t="str"' : ""}${s ? ` s="${s}"` : ""}><f>${formula
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")}</f>${v !== undefined ? `<v>${v}</v>` : ""}</c>`;
export const row = (r: number, ...cells: string[]) => `<row r="${r}">${cells.join("")}</row>`;
export const data = (...rows: string[]) => `<sheetData>${rows.join("")}</sheetData>`;

export function buildXlsxFixture(book: FixtureBook): Buffer {
  const files: Record<string, string> = {};
  const sheetTypes = book.sheets
    .map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${CT}.worksheet+xml"/>`,
    )
    .join("");
  const extraTypes = Object.entries(book.types ?? {})
    .map(([part, type]) => `<Override PartName="/${part}" ContentType="${type}"/>`)
    .join("");
  files["[Content_Types].xml"] =
    `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${CT}.sheet.main+xml"/>${sheetTypes}<Override PartName="/xl/styles.xml" ContentType="${CT}.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="${CT}.sharedStrings+xml"/>${
      book.calcChain
        ? `<Override PartName="/xl/calcChain.xml" ContentType="${CT}.calcChain+xml"/>`
        : ""
    }${extraTypes}</Types>`;
  files["_rels/.rels"] =
    `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const count = book.sheets.length;
  files["xl/_rels/workbook.xml.rels"] =
    `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${book.sheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join(
        "",
      )}<Relationship Id="rId${count + 1}" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="rId${
      count + 2
    }" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>${
      book.calcChain
        ? `<Relationship Id="rId${count + 3}" Type="${REL}/calcChain" Target="calcChain.xml"/>`
        : ""
    }</Relationships>`;
  files["xl/workbook.xml"] =
    `${DECL}<workbook xmlns="${MAIN}" xmlns:r="${REL}">${book.workbookPr ?? "<workbookPr/>"}<bookViews><workbookView activeTab="0"/></bookViews><sheets>${book.sheets
      .map(
        (s, i) =>
          `<sheet name="${s.name}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ""} r:id="rId${i + 1}"/>`,
      )
      .join(
        "",
      )}</sheets>${book.definedNames ? `<definedNames>${book.definedNames}</definedNames>` : ""}<calcPr calcId="191029"/></workbook>`;
  files["xl/styles.xml"] =
    `${DECL}<styleSheet xmlns="${MAIN}">${book.numFmts ? `<numFmts>${book.numFmts}</numFmts>` : ""}<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs>${
      book.cellXfs ?? '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    }</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  files["xl/sharedStrings.xml"] =
    `${DECL}<sst xmlns="${MAIN}" count="${book.shared?.length ?? 0}" uniqueCount="${book.shared?.length ?? 0}">${(
      book.shared ?? []
    )
      .map((s) => (s.startsWith("<") ? `<si>${s}</si>` : `<si><t>${s}</t></si>`))
      .join("")}</sst>`;
  if (book.calcChain) {
    files["xl/calcChain.xml"] = `${DECL}<calcChain xmlns="${MAIN}"><c r="A1" i="1"/></calcChain>`;
  }
  book.sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] =
      `${DECL}<worksheet xmlns="${MAIN}" xmlns:r="${REL}">${s.body}</worksheet>`;
    if (s.rels) {
      files[`xl/worksheets/_rels/sheet${i + 1}.xml.rels`] =
        `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Object.entries(
          s.rels,
        )
          .map(
            ([id, [type, target]]) =>
              `<Relationship Id="${id}" Type="${type.includes("/") ? type : `${REL}/${type}`}" Target="${target}"/>`,
          )
          .join("")}</Relationships>`;
    }
  });
  Object.assign(files, book.parts ?? {});
  return buildZip(files);
}
