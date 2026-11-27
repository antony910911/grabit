import { useEffect, useState } from 'react';
import { api, type AiSuggestion, type FileDetail, type Project } from './api';
import { FolderInput, Icon } from './components';
import { formatTime } from './lib';

const PROVIDER: Record<string, string> = { workers: 'Workers AI', gemini: 'Gemini', claude: 'Claude', demo: '展示用模擬 AI' };

function statusText(f: FileDetail): { text: string; tone: 'muted' | 'warn' | 'danger' | 'ok' } | null {
  switch (f.ai_status) {
    case 'queued':
    case 'running':
      return { text: '等待 AI 分析…', tone: 'muted' };
    case 'deferred':
      return { text: `延後分析：${f.ai_error ?? ''}`, tone: 'warn' };
    case 'failed':
      return { text: `分析失敗：${f.ai_error ?? ''}（檔案已照常歸檔）`, tone: 'danger' };
    case 'skipped':
      return { text: `沒有分析：${f.ai_error ?? ''}`, tone: 'muted' };
    default:
      return null;
  }
}

/** 檔案資訊裡的 AI 判讀結果：建議檔名、專案、資料夾、標籤、摘要；可以採用、編輯、略過、重新分析 */
export function AiPanel({
  f,
  editable,
  busy,
  folders,
  projects,
  run,
  onDone,
}: {
  f: FileDetail;
  editable: boolean;
  busy: boolean;
  folders: string[];
  projects: Project[];
  run: (fn: () => Promise<void>) => Promise<void>;
  onDone: (msg: string, r: { batchId?: string | null }) => void;
}) {
  const s: AiSuggestion | null = f.ai_suggestion;
  const [editing, setEditing] = useState(false);
  const [folder, setFolder] = useState('');
  const [name, setName] = useState('');
  const [project, setProject] = useState('');
  const [useName, setUseName] = useState(false);
  useEffect(() => {
    setFolder(s?.folder ?? '');
    setName(s?.suggestedName ?? '');
    setProject(s?.project ?? '');
    setUseName(false);
    setEditing(false);
  }, [f.id, f.ai_at, s?.folder, s?.suggestedName, s?.project]);

  const status = statusText(f);
  if (!status && !f.ai_summary && !s && !editable) return null;

  const folderPending = !!s?.folder && !s.applied?.folder && s.folder !== f.folder_path;
  const projectPending = !!s?.project && !f.project_name;
  const namePending = !!s?.suggestedName && !s.applied?.name && s.suggestedName !== f.stored_name;
  const canAccept = editable && !!s && !s.dismissed && (folderPending || projectPending || namePending || editing);

  const accept = () =>
    run(async () => {
      const body: Record<string, unknown> = {};
      if (editing ? folder.trim() && folder.trim() !== f.folder_path : folderPending) body.folder = editing ? folder.trim() : s!.folder;
      if (editing ? project && project !== f.project_name : projectPending) body.project = editing ? project : s!.project;
      if (useName && (editing ? name.trim() : s!.suggestedName)) body.name = editing ? name.trim() : s!.suggestedName;
      if (!Object.keys(body).length) throw new Error('沒有要套用的變更');
      const r = await api<{ batchId?: string; folderPath: string; storedName: string }>(`/files/${f.id}/accept-ai`, { method: 'POST', json: body });
      onDone(body.folder ? `已採用 AI 建議：${r.folderPath}` : '已採用 AI 建議', r);
    });
  const dismiss = () =>
    run(async () => {
      await api(`/files/${f.id}/ai/dismiss`, { method: 'POST', json: {} });
      onDone('已略過 AI 建議', {});
    });
  const reanalyze = () =>
    run(async () => {
      await api(`/files/${f.id}/ai`, { method: 'POST', json: {} });
      onDone('已重新排入 AI 分析', {});
    });

  return (
    <div className="ai-box">
      <div className="head">
        <Icon name="ai" />
        AI 判讀
        {f.ai_status === 'done' && s?.provider && (
          <span className="ai-meta">
            {PROVIDER[s.provider] ?? s.provider}
            {s.at ? ` · ${formatTime(s.at)}` : ''}
          </span>
        )}
      </div>
      {status && <div className={`small ai-status ${status.tone}`}>{status.text}</div>}
      {f.ai_summary && <p className="ai-summary">{f.ai_summary}</p>}

      {s && !s.dismissed && (
        <dl className="ai-fields">
          {(s.suggestedName || editing) && (
            <>
              <dt>建議檔名</dt>
              <dd>
                {editing ? <input className="input" value={name} onChange={(e) => setName(e.target.value)} aria-label="建議檔名" /> : <span className="ai-value">{s.suggestedName}</span>}
                {s.applied?.name ? (
                  <span className="badge ok">已套用</span>
                ) : (
                  editable &&
                  (s.suggestedName || editing) && (
                    <label className="check-row small" style={{ marginTop: 4 }}>
                      <input type="checkbox" checked={useName} onChange={(e) => setUseName(e.target.checked)} />
                      <span>採用時一併改檔名（原檔名會保留在紀錄裡）</span>
                    </label>
                  )
                )}
              </dd>
            </>
          )}
          {(s.project || editing) && (
            <>
              <dt>建議專案</dt>
              <dd>
                {editing ? (
                  <select className="select" value={project} onChange={(e) => setProject(e.target.value)} aria-label="建議專案">
                    <option value="">不指定</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.name}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="ai-value">{s.project}</span>
                )}
                {s.applied?.project && <span className="badge ok">已套用</span>}
              </dd>
            </>
          )}
          {(s.folder || editing) && (
            <>
              <dt>建議位置</dt>
              <dd>
                {editing ? <FolderInput value={folder} onChange={setFolder} folders={folders} /> : <span className="ai-value">{s.folder}</span>}
                {s.applied?.folder ? <span className="badge ok">已自動歸檔</span> : s.folder && s.folderKnown === false && <span className="badge warn">新資料夾，需確認</span>}
              </dd>
            </>
          )}
          {s.tags.length > 0 && (
            <>
              <dt>標籤</dt>
              <dd className="row" style={{ gap: 4 }}>
                {s.tags.map((t) => (
                  <span key={t} className="tag">
                    {t}
                  </span>
                ))}
              </dd>
            </>
          )}
          {!!s.keyInfo?.length && (
            <>
              <dt>重要資訊</dt>
              <dd>
                <ul className="ai-list">
                  {s.keyInfo.map((k) => (
                    <li key={k}>{k}</li>
                  ))}
                </ul>
              </dd>
            </>
          )}
          <dt>判斷信心</dt>
          <dd>
            <span className="ai-conf">
              <i style={{ width: `${Math.round(s.confidence * 100)}%` }} />
            </span>
            {Math.round(s.confidence * 100)}%<span className="muted small">（模型自評，未校準）</span>
          </dd>
          {s.reason && (
            <>
              <dt>依據</dt>
              <dd className="muted">{s.reason}</dd>
            </>
          )}
        </dl>
      )}
      {s && !s.dismissed && !!s.warnings?.length && (
        <ul className="ai-list ai-warn">
          {s.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {s?.dismissed && <div className="small muted">已略過這次的 AI 建議。</div>}

      {editable && (
        <div className="ai-actions">
          {canAccept && (
            <button className="btn sm primary" disabled={busy} onClick={accept}>
              {editing ? '套用' : '採用建議'}
            </button>
          )}
          {s && !s.dismissed && (
            <button className="btn sm" disabled={busy} onClick={() => setEditing(!editing)}>
              {editing ? '取消編輯' : '編輯'}
            </button>
          )}
          {s && !s.dismissed && !s.applied?.folder && (
            <button className="btn sm" disabled={busy} onClick={dismiss}>
              略過
            </button>
          )}
          <button className="btn sm ghost" disabled={busy || f.ai_status === 'queued' || f.ai_status === 'running'} onClick={reanalyze}>
            <Icon name="refresh" />
            {f.ai_status ? '重新分析' : '分析這個檔案'}
          </button>
        </div>
      )}
    </div>
  );
}
