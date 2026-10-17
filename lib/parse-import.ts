import type { ImportMode } from "@/lib/types";

const HEADER = /^(text|tweet|tweets|content|post|body|内容|帖子)$/i;

export function parseImport(
  source: string,
  format: "text" | "csv",
): { tweets: string[]; mode: ImportMode } {
  const cleaned = source.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!cleaned.trim()) return { tweets: [], mode: format === "csv" ? "csv" : "lines" };
  if (format === "csv") return { tweets: parseCsv(cleaned), mode: "csv" };
  return parseText(cleaned);
}

function parseText(source: string): { tweets: string[]; mode: ImportMode } {
  const lines = source.split("\n");
  if (lines.some((line) => line.trim() === "---")) {
    const chunks: string[] = [];
    let buffer: string[] = [];
    for (const line of lines) {
      if (line.trim() === "---") {
        const text = buffer.join("\n").trim();
        if (text) chunks.push(text);
        buffer = [];
      } else {
        buffer.push(line);
      }
    }
    const last = buffer.join("\n").trim();
    if (last) chunks.push(last);
    return { tweets: chunks, mode: "separator" };
  }
  if (/\n[ \t]*\n/.test(source)) {
    return {
      tweets: source
        .split(/\n[ \t]*\n+/)
        .map((chunk) => chunk.trim())
        .filter(Boolean),
      mode: "paragraphs",
    };
  }
  return {
    tweets: lines.map((line) => line.trim()).filter(Boolean),
    mode: "lines",
  };
}

function parseCsv(source: string): string[] {
  const rows = parseCsvRows(source).filter((row) => row.some((cell) => cell.trim()));
  if (rows.length === 0) return [];
  const headerIndex = rows[0].findIndex((cell) => HEADER.test(cell.trim()));
  const column = headerIndex >= 0 ? headerIndex : 0;
  const dataRows = headerIndex >= 0 ? rows.slice(1) : rows;
  return dataRows.map((row) => (row[column] ?? "").trim()).filter(Boolean);
}

function parseCsvRows(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
