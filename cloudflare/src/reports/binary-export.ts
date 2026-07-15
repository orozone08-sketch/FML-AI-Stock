import { printableRows } from "./export";

const encoder = new TextEncoder();

function xml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[character] ?? character);
}

function little(value: number, bytes: number): number[] {
  return Array.from({ length: bytes }, (_, index) => (value >>> (index * 8)) & 0xff);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: Array<{ name: string; body: string }>): Uint8Array {
  const local: number[] = [];
  const central: number[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const body = encoder.encode(entry.body);
    const checksum = crc32(body);
    const localHeader = [
      ...little(0x04034b50, 4), ...little(20, 2), ...little(0x0800, 2), ...little(0, 2),
      ...little(0, 2), ...little(0, 2), ...little(checksum, 4), ...little(body.length, 4),
      ...little(body.length, 4), ...little(name.length, 2), ...little(0, 2), ...name,
    ];
    local.push(...localHeader, ...body);
    central.push(
      ...little(0x02014b50, 4), ...little(20, 2), ...little(20, 2), ...little(0x0800, 2),
      ...little(0, 2), ...little(0, 2), ...little(0, 2), ...little(checksum, 4),
      ...little(body.length, 4), ...little(body.length, 4), ...little(name.length, 2),
      ...little(0, 2), ...little(0, 2), ...little(0, 2), ...little(0, 2), ...little(0, 4),
      ...little(offset, 4), ...name,
    );
    offset += localHeader.length + body.length;
  }
  const end = [
    ...little(0x06054b50, 4), ...little(0, 2), ...little(0, 2), ...little(entries.length, 2),
    ...little(entries.length, 2), ...little(central.length, 4), ...little(local.length, 4),
    ...little(0, 2),
  ];
  return Uint8Array.from([...local, ...central, ...end]);
}

function columnName(index: number): string {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

export function toXlsx(rows: Record<string, unknown>[], sheetName = "Report"): Uint8Array {
  const printable = printableRows(rows);
  const values = [printable.headers, ...printable.rows];
  const sheetRows = values.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, columnIndex) => {
    const cell = `${columnName(columnIndex)}${rowIndex + 1}`;
    const safe = /^[\t\r\n ]*[=+\-@]/.test(value) ? `'${value}` : value;
    return `<c r="${cell}" t="inlineStr" s="${rowIndex === 0 ? 1 : 0}"><is><t xml:space="preserve">${xml(safe)}</t></is></c>`;
  }).join("")}</row>`).join("");
  const widths = printable.headers.map((header, index) => Math.min(42, Math.max(12,
    ...values.map((row) => String(row[index] ?? "").length + 2), header.length + 2,
  )));
  const columns = widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("");
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${columns}</cols><sheetData>${sheetRows}</sheetData></worksheet>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheetName.slice(0, 31) || "Report")}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="10"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Aptos"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF101828"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs></styleSheet>`;
  return zip([
    { name:"[Content_Types].xml", body:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name:"_rels/.rels", body:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name:"xl/workbook.xml", body:workbook },
    { name:"xl/_rels/workbook.xml.rels", body:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name:"xl/worksheets/sheet1.xml", body:worksheet },
    { name:"xl/styles.xml", body:styles },
  ]);
}

function pdfText(value: string): string {
  return value.normalize("NFKD").replace(/[^\x20-\x7e]/g, "?").replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

export function toPdf(title: string, rows: Record<string, unknown>[]): Uint8Array {
  const printable = printableRows(rows);
  const data = [printable.headers, ...printable.rows];
  const perPage = 34;
  const chunks = data.length ? Array.from({ length: Math.ceil(data.length / perPage) }, (_, index) => data.slice(index * perPage, (index + 1) * perPage)) : [[]];
  const objects: string[] = [];
  const pageIds: number[] = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>", "");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (const [pageIndex, chunk] of chunks.entries()) {
    const contentId = objects.length + 1;
    const pageId = contentId + 1;
    const lines = [title, `Page ${pageIndex + 1} of ${chunks.length}`, ...chunk.map((row) => row.map((cell) => String(cell).slice(0, 30)).join(" | "))];
    const commands = lines.map((line, index) => `BT /F1 ${index === 0 ? 14 : 7} Tf 24 ${560 - index * 15} Td (${pdfText(line)}) Tj ET`).join("\n");
    objects.push(`<< /Length ${encoder.encode(commands).length} >>\nstream\n${commands}\nendstream`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  }
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  let output = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(encoder.encode(output).length);
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = encoder.encode(output).length;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encoder.encode(output);
}
