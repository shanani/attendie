import { strToU8, zipSync } from "fflate";

/**
 * A minimal .xlsx writer: typed cells, formulas (with cached values), a few styles,
 * frozen header, auto-filter and right-to-left sheets. Enough for a validation-friendly export
 * without a large spreadsheet library.
 */

export type Fill = "header" | "red" | "orange" | "grey" | "green" | "yellow";
export type NumFmt = "int" | "time" | "date" | "text";

export interface Style {
  bold?: boolean;
  fill?: Fill;
  /** Grey text, for rows that are not counted. */
  muted?: boolean;
  numFmt?: NumFmt;
  wrap?: boolean;
}

export interface Cell {
  /** Text, number, or null for an empty cell. For a formula, the value Excel shows before recalculating. */
  value: string | number | null;
  /** Formula without the leading "=". */
  formula?: string;
  style?: Style;
}

export interface Sheet {
  name: string;
  rows: Cell[][];
  /** Column widths in characters. */
  widths?: number[];
  /** Keep the first row visible while scrolling. */
  freezeHeader?: boolean;
  /** Add filter buttons to the header row. */
  autoFilter?: boolean;
  rightToLeft?: boolean;
}

const FILL_COLORS: Record<Fill, string> = {
  header: "FFD9E2EC",
  red: "FFF8D7DA",
  orange: "FFFFE5C2",
  grey: "FFF2F2F2",
  green: "FFDFF3E4",
  yellow: "FFFFF6CC",
};
const NUM_FMT_IDS: Record<NumFmt, number> = { int: 1, time: 164, date: 165, text: 49 };
const FONTS = ["regular", "bold", "muted", "mutedBold"] as const;

function escapeXml(text: string): string {
  return text.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
}

/** 0 → "A", 26 → "AA". */
export function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/** Excel's serial day number for an ISO date (days since 1899-12-30). */
export function excelDate(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
}

/** Collects the distinct cell styles and gives each its index in styles.xml. */
class StyleTable {
  private keys: string[] = [""];
  private styles: Style[] = [{}];

  index(style: Style | undefined): number {
    if (!style) return 0;
    const key = JSON.stringify([style.bold, style.fill, style.muted, style.numFmt, style.wrap]);
    let i = this.keys.indexOf(key);
    if (i === -1) {
      i = this.keys.push(key) - 1;
      this.styles.push(style);
    }
    return i;
  }

  xml(): string {
    const fills = Object.values(FILL_COLORS)
      .map((rgb) => `<fill><patternFill patternType="solid"><fgColor rgb="${rgb}"/><bgColor indexed="64"/></patternFill></fill>`)
      .join("");
    const xfs = this.styles
      .map((s) => {
        const font = FONTS.indexOf(s.muted ? (s.bold ? "mutedBold" : "muted") : s.bold ? "bold" : "regular");
        const fill = s.fill ? 2 + Object.keys(FILL_COLORS).indexOf(s.fill) : 0;
        const numFmt = s.numFmt ? NUM_FMT_IDS[s.numFmt] : 0;
        const align = s.wrap ? `<alignment vertical="top" wrapText="1"/>` : `<alignment vertical="top"/>`;
        return `<xf numFmtId="${numFmt}" fontId="${font}" fillId="${fill}" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyAlignment="1">${align}</xf>`;
      })
      .join("");
    return (
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<numFmts count="2"><numFmt numFmtId="164" formatCode="hh:mm"/><numFmt numFmtId="165" formatCode="ddd dd mmm yyyy"/></numFmts>` +
      `<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font>` +
      `<font><sz val="11"/><color rgb="FF808080"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FF808080"/><name val="Calibri"/></font></fonts>` +
      `<fills count="${2 + Object.keys(FILL_COLORS).length}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${fills}</fills>` +
      `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="${this.styles.length}">${xfs}</cellXfs>` +
      `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
      `</styleSheet>`
    );
  }
}

function cellXml(cell: Cell, ref: string, styles: StyleTable): string {
  const s = styles.index(cell.style);
  const styleAttr = s ? ` s="${s}"` : "";
  const { value, formula } = cell;
  if (formula !== undefined) {
    const f = `<f>${escapeXml(formula)}</f>`;
    if (typeof value === "number") return `<c r="${ref}"${styleAttr}>${f}<v>${value}</v></c>`;
    if (typeof value === "string") return `<c r="${ref}"${styleAttr} t="str">${f}<v>${escapeXml(value)}</v></c>`;
    return `<c r="${ref}"${styleAttr}>${f}</c>`;
  }
  if (value === null || value === "") return s ? `<c r="${ref}"${styleAttr}/>` : "";
  if (typeof value === "number") return `<c r="${ref}"${styleAttr}><v>${value}</v></c>`;
  return `<c r="${ref}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function sheetXml(sheet: Sheet, styles: StyleTable): string {
  const columns = Math.max(1, ...sheet.rows.map((r) => r.length));
  const rows = sheet.rows
    .map((cells, r) => `<row r="${r + 1}">${cells.map((c, i) => cellXml(c, `${columnName(i)}${r + 1}`, styles)).join("")}</row>`)
    .join("");
  const pane = sheet.freezeHeader
    ? `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>`
    : "";
  const cols = sheet.widths?.length
    ? `<cols>${sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`
    : "";
  const filter = sheet.autoFilter ? `<autoFilter ref="A1:${columnName(columns - 1)}${sheet.rows.length}"/>` : "";
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheetViews><sheetView workbookViewId="0"${sheet.rightToLeft ? ` rightToLeft="1"` : ""}>${pane}</sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${rows}</sheetData>${filter}</worksheet>`
  );
}

/** Builds the .xlsx file. Excel recalculates every formula when it opens the file. */
export function buildXlsx(sheets: Sheet[]): Uint8Array {
  const styles = new StyleTable();
  const files: Record<string, Uint8Array> = {};
  sheets.forEach((sheet, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(sheet, styles))));

  const filterNames = sheets
    .map((s, i) =>
      s.autoFilter
        ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${s.name.replace(/'/g, "''")}'!$A$1:$${columnName(Math.max(1, ...s.rows.map((r) => r.length)) - 1)}$${s.rows.length}</definedName>`
        : "",
    )
    .join("");

  files["[Content_Types].xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      sheets
        .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
        .join("") +
      `</Types>`,
  );
  files["_rels/.rels"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`,
  );
  files["xl/workbook.xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets>${sheets.map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>` +
      (filterNames ? `<definedNames>${filterNames}</definedNames>` : "") +
      `<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`,
  );
  files["xl/_rels/workbook.xml.rels"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      sheets
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join("") +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `</Relationships>`,
  );
  files["xl/styles.xml"] = strToU8(styles.xml());
  return zipSync(files, { level: 6 });
}
