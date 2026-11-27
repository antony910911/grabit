// 展示版的模擬 AI：依檔名關鍵字判斷，不會連到任何外部服務
import type { AiEngine, AnalyzeInput, EngineOutput, AskTools, SearchHit } from '../../src/worker/ai';

interface Topic {
  kw: string[];
  folder: string;
  tags: string[];
  project: string | null;
  kind: string;
  lines: string[];
}

const TOPICS: Topic[] = [
  { kw: ['報價', '採購', '發票', 'invoice', 'quotation'], folder: '行政工作/採購', tags: ['採購', '報價'], project: null, kind: '採購報價單', lines: ['品項：GC 管柱 DB-5', '數量：2 支', '報價：NT$ 48,000（含稅）', '有效期限：30 天'] },
  { kw: ['bmp', '沼氣', '厭氧', 'vfa', 'cod', '甲烷', '100l'], folder: '沼氣研發/操作數據', tags: ['沼氣', '操作數據'], project: '厭氧消化', kind: '沼氣實驗紀錄', lines: ['反應槽：100L 厭氧消化槽', '溫度：37 °C，HRT 20 天', '甲烷產率：0.31 L CH4/g VS', 'VFA/ALK 比值 0.21，系統穩定'] },
  { kw: ['farnesene', 'gc', 'hplc', 'ppj', '酵母', '發酵', '培養'], folder: '酵母研發/GC 分析', tags: ['Farnesene', 'GC 分析'], project: 'Farnesene', kind: '酵母發酵分析數據', lines: ['菌株：PPJ-07', '培養時間：72 小時', 'Farnesene 產量：1.8 g/L', 'GC 滯留時間 12.4 分鐘'] },
  { kw: ['會議', 'meeting', '週會', '月會'], folder: '行政工作/會議紀錄', tags: ['會議紀錄'], project: null, kind: '會議紀錄', lines: ['出席：研發部全體', '討論事項：下季實驗排程', '決議：12 月完成中試規劃', '待辦：採購新的 GC 管柱'] },
  { kw: ['期末', '期中', '報告', 'fy115', '結案', '計畫書'], folder: '計畫報告/FY115', tags: ['計畫報告', 'FY115'], project: 'FY115 計畫', kind: '計畫報告', lines: ['計畫名稱：生質能源整合計畫', '執行期間：FY115', '重點成果：完成中試放大', '經費執行率：92%'] },
  { kw: ['旅遊', '行程', '聚餐', '員旅'], folder: '私人/生活', tags: ['生活'], project: null, kind: '生活資料', lines: ['日期：12 月 20 日', '地點：宜蘭', '集合時間：08:00'] },
];

function topicOf(name: string, text: string): { t: Topic; inName: boolean } | null {
  const lower = name.toLowerCase();
  for (const t of TOPICS) if (t.kw.some((k) => lower.includes(k))) return { t, inName: true };
  const lt = text.toLowerCase();
  for (const t of TOPICS) if (t.kw.some((k) => lt.includes(k))) return { t, inName: false };
  return null;
}

/** 依檔名產生一段模擬的文件內容（版本不同內容稍有差異，方便展示版本比對） */
export function fakeContent(name: string): string {
  const hit = topicOf(name, '');
  const lines = hit ? [...hit.t.lines] : ['（展示用的模擬內容）'];
  const v = name.match(/v(\d+)|final|最終/i);
  if (v) {
    const n = v[1] ? Number(v[1]) : 9;
    lines.push(`版本說明：第 ${n === 9 ? '最終' : n} 版${n > 1 ? '，修正數據與結論' : ''}`);
    if (n > 1) lines[lines.length - 2] = lines[lines.length - 2] + '（已修訂）';
  }
  return [`《${name.replace(/\.[^.]+$/, '')}》`, ...lines].join('\n');
}

export const demoAi: AiEngine = {
  provider: 'demo',
  model: '展示用模擬 AI',
  async analyze(input: AnalyzeInput): Promise<EngineOutput> {
    const content = fakeContent(input.fileName);
    const hit = topicOf(input.fileName, '');
    if (!hit) {
      return {
        raw: { summary: `檔名「${input.fileName}」沒有明確的主題線索，建議人工確認。`, tags: [], suggested_name: '', project: '', folder: '', confidence: 0.3, reason: '檔名與內容都沒有可判斷的關鍵字', key_info: [], warnings: [], key_text: content },
        read: 'full',
        text: content,
      };
    }
    const { t } = hit;
    const folder = input.folders.find((f) => f.includes(t.folder.split('/').pop()!)) ?? t.folder;
    const ext = input.fileName.includes('.') ? input.fileName.slice(input.fileName.lastIndexOf('.')) : '';
    return {
      raw: {
        summary: `這是一份${t.kind}（來自${input.groupName}）。${t.lines.slice(0, 2).join('；')}。`,
        tags: t.tags,
        suggested_name: `${t.kind}_${t.lines[0]!.split('：').pop()!.replace(/[\s/]+/g, '')}${ext}`,
        folder,
        project: t.project && input.projects.includes(t.project) ? t.project : '',
        confidence: hit.inName ? 0.9 : 0.62,
        reason: `檔名含「${t.kw.find((k) => input.fileName.toLowerCase().includes(k)) ?? t.kw[0]}」，內容是${t.kind}`,
        key_info: t.lines.slice(0, 3),
        warnings: [],
        key_text: content,
      },
      read: 'full',
      text: content,
    };
  },
  async ask(question: string, tools: AskTools): Promise<string> {
    const q = question.toLowerCase();
    const words = new Set<string>();
    for (const t of TOPICS) for (const k of t.kw) if (q.includes(k)) words.add(k);
    for (const m of question.matchAll(/[A-Za-z][A-Za-z0-9]+/g)) words.add(m[0].toLowerCase());
    // 依符合的關鍵字數量排序，只留最相關的一群
    const score = new Map<number, { hit: SearchHit; n: number }>();
    for (const w of [...words].slice(0, 8)) {
      for (const h of await tools.search({ query: w, limit: 20 })) {
        const cur = score.get(h.id) ?? { hit: h, n: 0 };
        cur.n++;
        score.set(h.id, cur);
      }
    }
    const best = Math.max(0, ...[...score.values()].map((x) => x.n));
    const hits = [...score.values()].filter((x) => x.n === best).map((x) => x.hit).slice(0, 8);
    if (!hits.length) return '找不到相關的檔案。可以換個關鍵字試試，例如專案名稱、樣品編號或檔案類型。\n\n（展示版使用模擬 AI；正式版由你選的 AI 引擎讀取檔案摘要與內容後回答，免費的 Workers AI 也可以。）';
    return [
      `找到 ${hits.length} 個相關檔案：`,
      ...hits.map((h) => `• ${h.name} [#${h.id}]：${h.folder}，${h.group}，${h.received_at.slice(0, 10)}${h.summary ? `。${h.summary}` : ''}`),
      '',
      '（展示版使用模擬 AI；正式版由你選的 AI 引擎（免費的 Workers AI 或 Gemini）讀取檔案摘要與內容後，用自然語言回答你的問題。）',
    ].join('\n');
  },
};
