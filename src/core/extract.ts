import fs from 'node:fs';
import { logger } from '../logger.js';

/**
 * Extract plain text from a document so ANY model (free / local / Claude) can read it — mirroring the
 * inline-text trick used for plain-text uploads. Supports PDF, Word (.docx), Excel (.xlsx/.xls) and
 * PowerPoint (.pptx). Returns null for unsupported types or on failure, so the caller falls back to
 * Claude's file tools. Parser libs are loaded lazily (dynamic import) and tolerated as `any` to avoid
 * ESM/CJS + typing friction.
 */
export async function extractDocText(filePath: string, name: string): Promise<string | null> {
  const ext = (name.split('.').pop() || '').toLowerCase();
  try {
    if (ext === 'pdf') {
      const mod: any = await import('pdf-parse');
      const PDFParse = mod.PDFParse || (mod.default && mod.default.PDFParse);
      if (!PDFParse) return null;
      const parser = new PDFParse({ data: new Uint8Array(fs.readFileSync(filePath)) });
      const r = await parser.getText();
      return (String(r?.text || '').trim()) || null;
    }
    if (ext === 'docx') {
      const mod: any = await import('mammoth');
      const lib = mod.default || mod;
      const r = await lib.extractRawText({ path: filePath });
      return (String(r?.value || '').trim()) || null;
    }
    if (ext === 'xlsx' || ext === 'xls') {
      const mod: any = await import('xlsx');
      const XLSX = mod.default || mod;
      const wb = XLSX.readFile(filePath);
      const out = (wb.SheetNames as string[]).map((n) => '# ' + n + '\n' + XLSX.utils.sheet_to_csv(wb.Sheets[n])).join('\n\n');
      return out.trim() || null;
    }
    if (ext === 'pptx') {
      const mod: any = await import('adm-zip');
      const AdmZip = mod.default || mod;
      const zip = new AdmZip(filePath);
      const out: string[] = [];
      zip.getEntries().forEach((e: any) => {
        if (/ppt\/slides\/slide\d+\.xml$/.test(e.entryName)) {
          const xml = e.getData().toString('utf8') as string;
          const parts = (xml.match(/<a:t>[\s\S]*?<\/a:t>/g) || []).map((s) => s.replace(/<\/?a:t>/g, ''));
          if (parts.length) out.push(parts.join(' '));
        }
      });
      return out.join('\n').trim() || null;
    }
  } catch (err) {
    logger.warn({ err: String(err), name }, 'document text extraction failed');
    return null;
  }
  return null;
}
