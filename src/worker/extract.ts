// 從檔案內容擷取文字（Office 檔是 zip + XML，不需要外部服務）
import { unzipSync, strFromU8 } from 'fflate';
import { splitExt } from './rules';

export type ContentKind = 'pdf' | 'image' | 'text' | 'none';

const IMAGE_MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
const TEXT_EXT = new Set(['txt', 'csv', 'tsv', 'md', 'json', 'xml', 'html', 'htm', 'log', 'yaml', 'yml']);
const OFFICE_EXT = new Set(['docx', 'pptx', 'xlsx']);

export interface Extracted {
  kind: ContentKind;
  text: string; // Office／純文字擷取出的內容
  mediaType?: string; // pdf / 圖片交給 AI 直接讀
}

function decodeXmlText(xml: string): string {
  return xml
    .replace(/<\/(w:p|a:p|row)>/g, '\n')
    .replace(/<(w:tab|w:br)\/>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function officeText(ext: string, data: Uint8Array): string {
  const files = unzipSync(data, {
    filter: (f) =>
      ext === 'docx'
        ? f.name === 'word/document.xml'
        : ext === 'pptx'
          ? /^ppt\/slides\/slide\d+\.xml$/.test(f.name)
          : f.name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(f.name),
  });
  const names = Object.keys(files).sort((a, b) => Number(a.match(/(\d+)\.xml$/)?.[1] ?? 0) - Number(b.match(/(\d+)\.xml$/)?.[1] ?? 0));
  if (ext === 'xlsx') {
    // 只取共用字串（儲存格裡的文字）；數字不太有助於分類
    const shared = files['xl/sharedStrings.xml'];
    return shared ? decodeXmlText(strFromU8(shared).replace(/<\/si>/g, '\n')) : '';
  }
  return names.map((n, i) => (ext === 'pptx' ? `【第 ${i + 1} 頁】\n` : '') + decodeXmlText(strFromU8(files[n]!))).join('\n\n');
}

export function extractContent(fileName: string, mime: string, data: ArrayBuffer): Extracted {
  const ext = splitExt(fileName).ext;
  try {
    if (ext === 'pdf' || mime === 'application/pdf') return { kind: 'pdf', text: '', mediaType: 'application/pdf' };
    if (IMAGE_MIME[ext] || /^image\/(jpeg|png|gif|webp)$/.test(mime)) return { kind: 'image', text: '', mediaType: IMAGE_MIME[ext] ?? mime };
    if (OFFICE_EXT.has(ext)) return { kind: 'text', text: officeText(ext, new Uint8Array(data)) };
    if (TEXT_EXT.has(ext) || mime.startsWith('text/')) return { kind: 'text', text: new TextDecoder().decode(data) };
  } catch {
    // 檔案損毀或格式不符：只用檔名判斷
  }
  return { kind: 'none', text: '' };
}

export function toBase64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
