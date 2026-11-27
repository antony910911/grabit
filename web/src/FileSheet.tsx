import { useEffect, useState } from 'react';
import { api, type FileDetail, type Project, type Suggestion } from './api';
import { ErrorBox, FileIcon, FolderInput, Icon, Loading, ProjectBadge, Sheet, SourceIcon, StatusBadge, TagChip } from './components';
import { ask, canEdit, formatBytes, formatTime, lineDiff, navigate, useLoad, useMe, useToast } from './lib';
import { AiPanel } from './AiPanel';

const HOW: Record<string, string> = { rule: '檔名規則', ai: 'AI 判讀內容', group: '群組預設資料夾', manual: '手動調整', none: '沒有符合的規則' };

/** 搬移後的提示：可以復原，學到規則時提醒 */
export function useAfterMove() {
  const toast = useToast();
  return (msg: string, r: { batchId?: string | null; suggestion?: Pick<Suggestion, 'pattern'> & { targetPath?: string } | null }, onUndone?: () => void) => {
    if (r.suggestion) {
      toast(`${msg}。之後含「${r.suggestion.pattern}」的檔案要自動放這裡嗎？`, 'ok', { label: '看建議規則', onClick: () => navigate('/rules') });
    } else if (r.batchId) {
      toast(msg, 'ok', {
        label: '復原',
        onClick: async () => {
          try {
            await api(`/operations/${r.batchId}/undo`, { method: 'POST', json: {} });
            toast('已復原');
            onUndone?.();
          } catch (e) {
            toast((e as Error).message, 'error');
          }
        },
      });
    } else toast(msg);
  };
}

export function FileSheet({ id, folders, onClose, onChanged }: { id: number; folders: string[]; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const me = useMe();
  const editable = canEdit(me);
  const afterMove = useAfterMove();
  const [current, setCurrent] = useState(id);
  const { data: f, error, loading, reload } = useLoad(() => api<FileDetail>(`/files/${current}`), [current]);
  const projects = useLoad(() => api<{ items: Project[] }>('/projects'), []);
  const [mode, setMode] = useState<'view' | 'move' | 'compare'>('view');
  const [folder, setFolder] = useState('');
  const [name, setName] = useState('');
  const [newTag, setNewTag] = useState('');
  const [compareWith, setCompareWith] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setCurrent(id), [id]);
  useEffect(() => {
    if (f) {
      setFolder(f.folder_path ?? '');
      setName(f.stored_name ?? f.original_name);
    }
  }, [f]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const refresh = () => {
    reload();
    onChanged();
  };

  const save = () =>
    run(async () => {
      const r = await api<{ batchId: string; suggestion: Suggestion | null }>(`/files/${current}`, { method: 'PATCH', json: { folderPath: folder, storedName: name } });
      afterMove(`已移到 ${folder}`, r, refresh);
      setMode('view');
      refresh();
    });

  const setTags = (tags: string[]) =>
    run(async () => {
      await api(`/files/${current}`, { method: 'PATCH', json: { tags } });
      refresh();
    });

  const setProject = (projectId: number | null) =>
    run(async () => {
      await api(`/files/${current}`, { method: 'PATCH', json: { projectId } });
      refresh();
    });

  const action = (path: string, msg: string, close = false) =>
    run(async () => {
      const r = await api<{ batchId?: string }>(path, { method: 'POST', json: {} });
      if (r.batchId) afterMove(msg, r, refresh);
      else toast(msg);
      refresh();
      if (close) onClose();
    });

  const remove = () =>
    run(async () => {
      if (!(await ask('確定要刪除這個檔案？雲端上的檔案會移到垃圾桶／資源回收筒（可以救回）。'))) return;
      await api(`/files/${current}`, { method: 'DELETE' });
      toast('已刪除');
      onChanged();
      onClose();
    });

  const title = mode === 'move' ? '移動或改名' : mode === 'compare' ? '版本比對' : '檔案資訊';
  const preview = f && !f.drive_link && f.status !== 'pending' ? `/api/files/${f.id}/download?inline=1` : null;

  return (
    <Sheet title={title} onClose={onClose}>
      {loading && !f && <Loading />}
      {error && <ErrorBox message={error} />}
      {f && mode === 'view' && (
        <>
          <div className="row" style={{ marginBottom: 12, flexWrap: 'nowrap', alignItems: 'flex-start' }}>
            <FileIcon ext={f.ext} type={f.message_type} />
            <div className="grow">
              <div className="path">{f.stored_name ?? f.original_name}</div>
              <div className="row" style={{ gap: 6, marginTop: 4 }}>
                <StatusBadge file={f} />
                {f.version_label && <span className="version-pill">{f.version_label}</span>}
                {f.project_name && <ProjectBadge name={f.project_name} color={f.project_color} />}
              </div>
            </div>
          </div>

          {(f.status === 'done' || f.status === 'duplicate') && (
            <div className="file-open">
              {me?.demo ? (
                <button className="btn primary file-download" onClick={() => toast('展示版沒有真的檔案；正式版按這裡會直接下載')}>
                  <Icon name="download" />
                  下載
                  {f.size ? <span className="file-size">{formatBytes(f.size)}</span> : null}
                </button>
              ) : (
                // 透過 GrabIt 下載：依 GrabIt 的群組權限判斷，不需要對方有雲端硬碟的權限
                <a className="btn primary file-download" href={`/api/files/${f.id}/download`} download>
                  <Icon name="download" />
                  下載
                  {f.size ? <span className="file-size">{formatBytes(f.size)}</span> : null}
                </a>
              )}
              {preview && (
                <button
                  className="btn"
                  onClick={async () => {
                    // 用 fetch 取得內容再開新分頁，沒有雲端權限的人、WebDAV／展示版這類沒有公開連結的空間也能預覽
                    const w = window.open('', '_blank');
                    if (!w) {
                      toast('這個環境不允許開啟新分頁，請在 GrabIt 網站上預覽', 'error');
                      return;
                    }
                    try {
                      const res = await fetch(preview);
                      if (!res.ok) throw new Error(`HTTP ${res.status}`);
                      w.location.href = URL.createObjectURL(await res.blob());
                    } catch (e) {
                      w.close();
                      toast(`無法預覽：${(e as Error).message}`, 'error');
                    }
                  }}
                >
                  <Icon name="eye" />
                  預覽
                </button>
              )}
              {f.drive_link && (
                // 只有打得開的人才會拿到雲端連結（雲端帳號本人，或專屬資料夾有分享給他）
                <a className="btn" href={f.drive_link} target="_blank" rel="noreferrer" title={me?.email ? `用 Google 帳號 ${me.email} 開啟` : undefined}>
                  <Icon name="external" />
                  在 {f.storage_name ?? '雲端'} 開啟
                </a>
              )}
            </div>
          )}

          <AiPanel
            f={f}
            editable={editable}
            busy={busy}
            folders={folders}
            projects={projects.data?.items ?? []}
            run={run}
            onDone={(msg, r) => {
              if (r.batchId) afterMove(msg, r, refresh);
              else toast(msg);
              refresh();
            }}
          />

          <dl className="kv">
            <dt>位置</dt>
            <dd>
              {f.storage_name ? `${f.storage_name}：` : ''}
              {f.folder_path ?? '—'}
            </dd>
            <dt>來源</dt>
            <dd>
              <SourceIcon type={f.source} /> {f.group_name}
            </dd>
            <dt>上傳者</dt>
            <dd>
              {f.uploader_key ? (
                <button
                  className="linklike"
                  onClick={() => {
                    onClose();
                    navigate(`/files?uploader=${encodeURIComponent(f.uploader_key!)}`);
                  }}
                >
                  {f.uploader_name ?? '（沒有名稱）'} · 看這個人的所有檔案
                </button>
              ) : (
                <span className="muted">{f.uploader_name ? `${f.uploader_name}（未知身分）` : '未知上傳者'}</span>
              )}
            </dd>
            <dt>收到時間</dt>
            <dd>{formatTime(f.received_at)}</dd>
            <dt>大小</dt>
            <dd>{formatBytes(f.size)}</dd>
            {f.stored_name && f.original_name !== f.stored_name && (
              <>
                <dt>原檔名</dt>
                <dd>{f.original_name}</dd>
              </>
            )}
            <dt>分類依據</dt>
            <dd>{f.classified_by === 'rule' && f.rule_name ? `規則「${f.rule_name}」` : HOW[f.classified_by ?? ''] ?? '—'}</dd>
            {f.status === 'duplicate' && (
              <>
                <dt>重複</dt>
                <dd>
                  與檔案 #{f.duplicate_of} 內容相同。原本要放在 {f.target_folder ?? '—'}
                </dd>
              </>
            )}
            {f.error && (
              <>
                <dt>錯誤</dt>
                <dd style={{ color: 'var(--danger)' }}>{f.error}</dd>
              </>
            )}
          </dl>

          <div className="section-title">標籤與專案</div>
          <div className="tags" style={{ marginBottom: 8 }}>
            {f.tags.length ? f.tags.map((t) => <TagChip key={t.id} tag={t} onRemove={editable ? () => setTags(f.tags.filter((x) => x.id !== t.id).map((x) => x.name)) : undefined} />) : <span className="muted small">沒有標籤</span>}
          </div>
          {editable && (
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input
                className="input grow"
                placeholder="新增標籤，按 Enter"
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newTag.trim() && !e.nativeEvent.isComposing) {
                    setTags([...f.tags.map((t) => t.name), newTag.trim()]);
                    setNewTag('');
                  }
                }}
              />
              <select className="select" style={{ width: 'auto' }} value={f.project_id ?? ''} onChange={(e) => setProject(e.target.value ? Number(e.target.value) : null)} aria-label="專案">
                <option value="">不屬於專案</option>
                {projects.data?.items.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {f.versions.length > 1 && (
            <>
              <div className="section-title">版本（{f.versions.length}）</div>
              <ul className="list card">
                {f.versions.map((v, i) => (
                  <li key={v.id} className="row" style={{ padding: '8px 12px', flexWrap: 'nowrap' }}>
                    <span className="version-pill">{v.version_label ?? (i === 0 ? '最新' : '版本')}</span>
                    <button className="cite" style={{ background: 'none', color: v.id === f.id ? 'var(--text)' : 'var(--accent)' }} onClick={() => setCurrent(v.id)}>
                      {v.name}
                    </button>
                    <span className="muted small grow" style={{ textAlign: 'right' }}>
                      {formatTime(v.received_at)}
                    </span>
                    {v.id !== f.id && (
                      <button
                        className="btn sm"
                        onClick={() => {
                          setCompareWith(v.id);
                          setMode('compare');
                        }}
                      >
                        比對
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}

          {f.content_excerpt && (
            <>
              <div className="section-title">內容摘錄</div>
              <div className="excerpt">{f.content_excerpt}</div>
            </>
          )}

          <div className="sheet-actions">
            {editable && (f.status === 'failed' || f.status === 'pending' || f.status === 'skipped') && f.source === 'line' && (
              <button className="btn" disabled={busy} onClick={() => action(`/files/${f.id}/retry`, '已重新排入處理')}>
                <Icon name="refresh" />
                重新處理
              </button>
            )}
            {editable && f.status !== 'deleted' && (
              <button className="btn danger" disabled={busy} onClick={remove}>
                刪除
              </button>
            )}
            {editable && f.status === 'duplicate' && (
              <button className="btn" disabled={busy} onClick={() => action(`/files/${f.id}/keep`, '已保留，放回原本的資料夾')}>
                仍要保留
              </button>
            )}
            {editable && f.status === 'done' && (
              <button className="btn" onClick={() => setMode('move')}>
                移動／改名
              </button>
            )}
          </div>
        </>
      )}
      {f && mode === 'move' && (
        <>
          <label className="field">
            <span>資料夾</span>
            <FolderInput value={folder} onChange={setFolder} folders={folders} autoFocus />
            <small>用 / 分隔層級，不存在的資料夾會自動建立。搬移後系統會學習並建議規則。</small>
          </label>
          <label className="field">
            <span>檔名</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="sheet-actions">
            <button className="btn" onClick={() => setMode('view')}>
              取消
            </button>
            <button className="btn primary" disabled={busy || !folder.trim() || !name.trim()} onClick={save}>
              {busy ? '處理中…' : '儲存'}
            </button>
          </div>
        </>
      )}
      {f && mode === 'compare' && compareWith && <Compare a={compareWith} b={f.id} onBack={() => setMode('view')} />}
    </Sheet>
  );
}

interface Side {
  id: number;
  name: string;
  version_label: string | null;
  received_at: string;
  summary: string | null;
  text: string;
  size: number | null;
  sender: string | null;
}

function Compare({ a, b, onBack }: { a: number; b: number; onBack: () => void }) {
  const { data, error, loading } = useLoad(() => api<{ a: Side; b: Side }>(`/files/${a}/compare/${b}`), [a, b]);
  const [old, cur] = data ? (new Date(data.a.received_at) <= new Date(data.b.received_at) ? [data.a, data.b] : [data.b, data.a]) : [null, null];
  const diff = old && cur ? lineDiff(old.text, cur.text) : [];
  const changed = diff.filter((d) => d.type !== 'same').length;
  return (
    <>
      {loading && <Loading />}
      {error && <ErrorBox message={error} />}
      {old && cur && (
        <>
          <div className="cols-2">
            {[old, cur].map((s, i) => (
              <div key={s.id} className="card card-pad small">
                <div className="row" style={{ gap: 6 }}>
                  <span className="version-pill">{i === 0 ? '舊' : '新'}</span>
                  <strong>{s.version_label ?? s.name}</strong>
                </div>
                <div className="muted">
                  {formatTime(s.received_at)} · {formatBytes(s.size)}
                  {s.sender ? ` · ${s.sender}` : ''}
                </div>
                {s.summary && <p style={{ margin: '8px 0 0' }}>{s.summary}</p>}
              </div>
            ))}
          </div>
          <div className="section-title">內文差異{old.text || cur.text ? `（${changed} 行不同）` : ''}</div>
          {old.text || cur.text ? (
            <div className="diff">
              {diff.map((d, i) => (
                <div key={i} className={d.type === 'same' ? '' : d.type}>
                  {d.type === 'add' ? '+ ' : d.type === 'del' ? '- ' : '  '}
                  {d.text || ' '}
                </div>
              ))}
            </div>
          ) : (
            <p className="muted small">這兩個版本沒有可以比對的文字內容（例如 PDF、圖片，或沒有啟用 AI 判讀）。</p>
          )}
        </>
      )}
      <div className="sheet-actions">
        <button className="btn" onClick={onBack}>
          返回
        </button>
      </div>
    </>
  );
}
