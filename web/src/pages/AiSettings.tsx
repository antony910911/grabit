import { useEffect, useState } from 'react';
import { api } from '../api';
import { Switch } from '../components';
import { useToast } from '../lib';

type Provider = 'workers' | 'gemini' | 'claude' | 'off';
interface Features {
  summary: boolean;
  tags: boolean;
  classify: boolean;
  rename: boolean;
  keyInfo: boolean;
}
export interface AiSettingsResp {
  provider: Provider;
  workersModel: string;
  geminiModel: string;
  dailyLimit: number;
  neuronBudget: number;
  threshold: number;
  onlyUnmatched: boolean;
  externalNeedsConsent: boolean;
  features: Features;
  available: { workers: boolean; gemini: boolean; claude: boolean };
  workersModels: { id: string; label: string }[];
  defaultGeminiModel: string;
  claudeModel: string;
  demo: boolean;
  status: {
    ready: boolean;
    provider: string;
    model: string | null;
    today: { count: number; units: number; unitLabel: string; estimated: boolean; resetAt: string };
    queued: number;
    deferred: number;
    failed: number;
    lastAt: string | null;
    paused: { until: string; reason: string } | null;
    estimatedDocsPerDay: number | null;
  };
}

const FEATURES: { key: keyof Features; label: string; hint: string }[] = [
  { key: 'summary', label: '文件摘要', hint: '2–3 句話說明文件內容' },
  { key: 'tags', label: '自動標籤', hint: '依內容加上標籤' },
  { key: 'classify', label: '分類建議與自動分類', hint: '把握度夠高、而且是既有資料夾時自動搬移' },
  { key: 'rename', label: '文件重新命名', hint: '把握度夠高時改成 AI 建議的檔名（預設關閉）' },
  { key: 'keyInfo', label: '重要資訊擷取', hint: '日期、金額、樣品編號、結論' },
];

const time = (iso: string | null) => (iso ? new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

export function AiCard({ ai, semantic, onSaved }: { ai: AiSettingsResp; semantic: boolean; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState(ai);
  const [busy, setBusy] = useState(false);
  const [geminiModels, setGeminiModels] = useState<{ id: string; label: string }[]>([]);
  const [backfill, setBackfill] = useState(20);
  useEffect(() => setF(ai), [ai]);

  const dirty = JSON.stringify({ ...f, status: null }) !== JSON.stringify({ ...ai, status: null });
  const st = ai.status;

  const call = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok);
      onSaved();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    call(
      () =>
        api('/settings', {
          method: 'PUT',
          json: {
            ai: {
              provider: f.provider,
              workersModel: f.workersModel,
              geminiModel: f.geminiModel,
              dailyLimit: f.dailyLimit,
              neuronBudget: f.neuronBudget,
              threshold: f.threshold,
              onlyUnmatched: f.onlyUnmatched,
              externalNeedsConsent: f.externalNeedsConsent,
              features: f.features,
            },
          },
        }),
      '已儲存 AI 設定',
    );

  const engines: { id: Provider; title: string; tag: string; desc: string; available: boolean; missing?: string; hidden?: boolean }[] = [
    {
      id: 'workers',
      title: 'Cloudflare Workers AI',
      tag: '免費・預設',
      desc: `在你自己的 Cloudflare 帳號裡執行，每天 10,000 Neurons 免費${st.estimatedDocsPerDay && ai.provider === 'workers' ? `（約可分析 ${st.estimatedDocsPerDay} 份）` : ''}。PDF、Word、Excel、簡報讀文字；圖片只依檔名判斷。`,
      available: ai.available.workers,
      missing: 'wrangler.toml 需要 [ai] binding（新版已內建，重新部署即可）',
    },
    {
      id: 'gemini',
      title: 'Gemini 免費 API',
      tag: '選用',
      desc: '可以直接讀 PDF 與圖片。注意：免費版會用送出的內容改善 Google 的產品，只適合可以對外的文件。',
      available: ai.available.gemini,
      missing: '在 Cloudflare 的 Variables and Secrets 加上 GEMINI_API_KEY（Secret）',
    },
    { id: 'claude', title: `Claude（${ai.claudeModel}）`, tag: '付費', desc: '判讀最準，依用量計費；也提供「問 AI」。', available: ai.available.claude, hidden: !ai.available.claude && ai.provider !== 'claude' },
    { id: 'off', title: '不使用 AI', tag: '', desc: '只用群組與分類規則歸檔，檔案管理與搜尋照常。', available: true },
  ];

  const badge = ai.provider === 'off' ? <span className="badge muted">已關閉</span> : st.paused ? <span className="badge warn">暫停中</span> : st.ready ? <span className="badge ok">啟用</span> : <span className="badge warn">待設定</span>;

  return (
    <section className="card card-pad">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>AI 文件判讀</h2>
        {badge}
      </div>
      <p className="muted small">檔案會先照群組和分類規則存好，AI 之後才在背景讀內容、產生摘要與標籤，規則判斷不了的再建議資料夾。AI 失敗、關閉或額度用完，都不影響收檔。</p>

      {st.paused && (
        <div className="notice warn" style={{ marginBottom: 12 }}>
          <div className="grow">
            {st.paused.reason}，AI 暫停到 {time(st.paused.until)}，之後會自動繼續。檔案照常歸檔，等待中的會在額度重置後補做。
          </div>
          <button className="btn sm" disabled={busy} onClick={() => call(() => api('/ai/resume', { method: 'POST', json: {} }), '已繼續')}>
            現在繼續
          </button>
        </div>
      )}

      <div className="field">
        <span>AI 引擎</span>
        <div className="engine-list" role="radiogroup" aria-label="AI 引擎">
          {engines
            .filter((e) => !e.hidden)
            .map((e) => (
              <label key={e.id} className={`engine${f.provider === e.id ? ' on' : ''}${!e.available ? ' off' : ''}`}>
                <input type="radio" name="ai-provider" checked={f.provider === e.id} disabled={!e.available && f.provider !== e.id} onChange={() => setF({ ...f, provider: e.id })} />
                <div className="grow">
                  <div className="engine-title">
                    {e.title}
                    {e.tag && <span className={`badge ${e.tag === '付費' ? 'warn' : e.tag.startsWith('免費') ? 'ok' : 'muted'}`}>{e.tag}</span>}
                  </div>
                  <div className="muted small">{e.desc}</div>
                  {!e.available && e.missing && <div className="small engine-missing">還不能用：{e.missing}</div>}
                </div>
              </label>
            ))}
        </div>
      </div>

      {f.provider === 'workers' && (
        <label className="field">
          <span>模型</span>
          <select className="select" value={f.workersModel} onChange={(e) => setF({ ...f, workersModel: e.target.value })}>
            {[...ai.workersModels, ...(ai.workersModels.some((m) => m.id === f.workersModel) ? [] : [{ id: f.workersModel, label: f.workersModel }])].map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <small>都支援繁體中文與結構化輸出。換模型前請先確認 Cloudflare 上它仍在免費額度內。</small>
        </label>
      )}
      {f.provider === 'gemini' && (
        <label className="field">
          <span>模型</span>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input className="input grow" list="gemini-models" value={f.geminiModel} onChange={(e) => setF({ ...f, geminiModel: e.target.value })} placeholder={ai.defaultGeminiModel} />
            <datalist id="gemini-models">
              {geminiModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </datalist>
            <button
              type="button"
              className="btn sm"
              disabled={busy || !ai.available.gemini}
              onClick={() =>
                call(async () => {
                  const r = await api<{ items: { id: string; label: string }[] }>('/ai/gemini-models');
                  setGeminiModels(r.items);
                }, '已取得可用的模型')
              }
            >
              查詢可用模型
            </button>
          </div>
          <small>預設 {ai.defaultGeminiModel}（Google 最新的 Flash 模型）。各模型的免費額度不同，以 Google AI Studio 顯示的為準。</small>
        </label>
      )}

      {f.provider !== 'off' && (
        <>
          <div className="field">
            <span>功能</span>
            <div className="feature-grid">
              {FEATURES.map((x) => (
                <label key={x.key} className="check-row">
                  <input type="checkbox" checked={f.features[x.key]} onChange={(e) => setF({ ...f, features: { ...f.features, [x.key]: e.target.checked } })} />
                  <span>
                    {x.label}
                    <small>{x.hint}</small>
                  </span>
                </label>
              ))}
              <label className="check-row off">
                <input type="checkbox" checked={semantic} disabled />
                <span>
                  語意搜尋（選用）
                  <small>{semantic ? '已啟用' : '需要另外設定 Vectorize，見 README'}</small>
                </span>
              </label>
            </div>
          </div>

          <div className="setting-rows">
            <label className="setting-row">
              <span>
                每日分析上限
                <small>超過就暫停到隔天，等待中的檔案之後補做</small>
              </span>
              <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                <input className="input num" type="number" min={0} max={5000} value={f.dailyLimit} onChange={(e) => setF({ ...f, dailyLimit: Number(e.target.value) })} />份
              </span>
            </label>
            {f.provider === 'workers' && (
              <label className="setting-row">
                <span>
                  每日 Neurons 預算
                  <small>免費額度是 10,000；預設留一成緩衝。付費方案超過免費額度會計費，這個上限會讓 GrabIt 先停下來</small>
                </span>
                <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                  <input className="input num" type="number" min={0} max={10000} step={500} value={f.neuronBudget} onChange={(e) => setF({ ...f, neuronBudget: Number(e.target.value) })} />
                </span>
              </label>
            )}
            <label className="setting-row">
              <span>
                自動分類信心門檻：{Math.round(f.threshold * 100)}%
                <small>模型自己給的分數，沒有校準過，只當參考；低於門檻或是新資料夾的，留在「AI 待確認」</small>
              </span>
              <input type="range" min={0.5} max={1} step={0.05} value={f.threshold} onChange={(e) => setF({ ...f, threshold: Number(e.target.value) })} aria-label="自動分類信心門檻" />
            </label>
            <div className="setting-row">
              <span>
                只有規則無法分類時才呼叫 AI
                <small>省額度；規則已經分類的檔案不會被 AI 改動</small>
              </span>
              <Switch checked={f.onlyUnmatched} onChange={(v) => setF({ ...f, onlyUnmatched: v })} label="只有規則無法分類時才呼叫 AI" />
            </div>
            <div className="setting-row">
              <span>
                未授權的群組不送交外部 AI
                <small>使用 Gemini 時，只有在「群組設定」勾選「允許送交外部 AI」的群組才會送出</small>
              </span>
              <Switch checked={f.externalNeedsConsent} onChange={(v) => setF({ ...f, externalNeedsConsent: v })} label="未授權的群組不送交外部 AI" />
            </div>
            <div className="setting-row">
              <span>免費額度用完後暫停 AI</span>
              <b className="fixed-on">強制開啟</b>
            </div>
            <div className="setting-row">
              <span>自動改用付費模型</span>
              <b className="fixed-off">禁止</b>
            </div>
          </div>
        </>
      )}

      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
        <button className="btn primary" disabled={busy || !dirty} onClick={save}>
          儲存 AI 設定
        </button>
      </div>

      {ai.provider !== 'off' && (
        <div className="ai-usage">
          <div className="ai-usage-grid">
            <div>
              <b>
                {st.today.count}
                <small> / {ai.dailyLimit}</small>
              </b>
              <span>今日分析</span>
            </div>
            <div>
              <b>
                {st.today.units.toLocaleString()}
                {st.today.unitLabel === 'Neurons' && <small> / {ai.neuronBudget.toLocaleString()}</small>}
              </b>
              <span>今日 {st.today.unitLabel}（本地估算）</span>
            </div>
            <div>
              <b>{st.queued}</b>
              <span>等待中</span>
            </div>
            <div>
              <b>{st.deferred}</b>
              <span>延後</span>
            </div>
            <div>
              <b className={st.failed ? 'bad' : ''}>{st.failed}</b>
              <span>分析失敗</span>
            </div>
          </div>
          <p className="muted small" style={{ margin: '10px 0 0' }}>
            最後分析：{time(st.lastAt)}・額度重置：{time(st.today.resetAt)}・目前模型：{ai.demo ? '展示用模擬 AI' : (st.model ?? '—')}。用量是 GrabIt 依模型回報的 token 數換算的估計值；實際用量以{' '}
            {st.provider === 'gemini' ? 'Google AI Studio' : 'Cloudflare 後台的 Workers AI'} 顯示為準。
          </p>
          <div className="row" style={{ marginTop: 10, gap: 8 }}>
            <span className="small">分析還沒判讀過的舊檔案</span>
            <input className="input num" type="number" min={1} max={200} value={backfill} onChange={(e) => setBackfill(Number(e.target.value))} aria-label="份數" />
            <span className="small">份</span>
            <button
              className="btn sm"
              disabled={busy || !st.ready}
              onClick={() =>
                call(async () => {
                  const r = await api<{ queued: number; skipped: Record<string, number> }>('/ai/backfill', { method: 'POST', json: { limit: backfill } });
                  const sk = Object.entries(r.skipped)
                    .map(([k, v]) => `${k} ${v} 份`)
                    .join('、');
                  toast(`已排入 ${r.queued} 份${sk ? `；略過：${sk}` : ''}`);
                }, '')
              }
            >
              開始
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
