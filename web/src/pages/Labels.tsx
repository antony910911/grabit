import { useState } from 'react';
import { api, type Project, type Tag } from '../api';
import { Empty, ErrorBox, Icon, Loading, ProjectBadge, Sheet } from '../components';
import { canEdit, Link, useLoad, useMe, useToast } from '../lib';

const COLORS = ['#4a6fa5', '#2c7a52', '#a75a1d', '#a2382f', '#6a4a97', '#2f8a8a', '#8a6d1f', '#697181'];

export function Labels() {
  const toast = useToast();
  const me = useMe();
  const editable = canEdit(me);
  const projects = useLoad(() => api<{ items: Project[] }>('/projects'), []);
  const tags = useLoad(() => api<{ items: Tag[] }>('/tags'), []);
  const [editP, setEditP] = useState<Partial<Project> | null>(null);
  const [editT, setEditT] = useState<Tag | null>(null);

  const saveProject = async () => {
    if (!editP) return;
    try {
      if (editP.id) await api(`/projects/${editP.id}`, { method: 'PUT', json: editP });
      else await api('/projects', { method: 'POST', json: editP });
      setEditP(null);
      projects.reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const deleteProject = async () => {
    if (!editP?.id || !confirm(`刪除專案「${editP.name}」？檔案不會被刪除，只是不再屬於這個專案。`)) return;
    await api(`/projects/${editP.id}`, { method: 'DELETE' });
    setEditP(null);
    projects.reload();
  };
  const saveTag = async () => {
    if (!editT) return;
    try {
      const r = await api<{ mergedInto?: number }>(`/tags/${editT.id}`, { method: 'PUT', json: editT });
      if (r.mergedInto) toast('已合併到同名標籤');
      setEditT(null);
      tags.reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const deleteTag = async () => {
    if (!editT || !confirm(`刪除標籤「${editT.name}」？`)) return;
    await api(`/tags/${editT.id}`, { method: 'DELETE' });
    setEditT(null);
    tags.reload();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>專案與標籤</h1>
          <p>「檔案來源」和「實際分類」分開：不同群組傳來的檔案，也能歸到同一個研究專案</p>
        </div>
      </div>
      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h2>專案</h2>
            {editable && (
              <button className="btn sm primary" onClick={() => setEditP({ name: '', color: COLORS[0], description: '' })}>
                <Icon name="plus" />
                新增專案
              </button>
            )}
          </div>
          {projects.error && <ErrorBox message={projects.error} />}
          {projects.loading && !projects.data ? (
            <Loading />
          ) : !projects.data?.items.length ? (
            <Empty title="還沒有專案">建立專案後，可以在規則、群組或個別檔案指定專案。</Empty>
          ) : (
            <ul className="list">
              {projects.data.items.map((p) => (
                <li key={p.id} className="rule-line">
                  <div className="grow">
                    <ProjectBadge name={p.name} color={p.color} />
                    {p.description && <div className="muted small">{p.description}</div>}
                  </div>
                  <Link to={`/files?project=${p.id}`} className="small">
                    {p.count} 個檔案
                  </Link>
                  {editable && (
                    <button className="btn sm" onClick={() => setEditP(p)}>
                      編輯
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="card">
          <div className="card-head">
            <h2>標籤</h2>
            <span className="muted small">規則、AI 或手動加上</span>
          </div>
          {tags.loading && !tags.data ? (
            <Loading />
          ) : !tags.data?.items.length ? (
            <Empty title="還沒有標籤">在規則裡設定標籤，或在檔案詳情手動加上；啟用 AI 後也會自動產生。</Empty>
          ) : (
            <div className="card-pad tags" style={{ gap: 8 }}>
              {tags.data.items.map((t) => (
                <button key={t.id} className="tag" style={{ cursor: 'pointer', fontSize: 13, padding: '4px 10px' }} onClick={() => (editable ? setEditT(t) : undefined)}>
                  <i style={{ width: 8, height: 8, borderRadius: 3, background: t.color }} />
                  {t.name} <span className="muted">{t.count}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {editP && (
        <Sheet
          title={editP.id ? '編輯專案' : '新增專案'}
          onClose={() => setEditP(null)}
          actions={
            <>
              {editP.id && (
                <button className="btn danger" style={{ marginRight: 'auto' }} onClick={deleteProject}>
                  刪除
                </button>
              )}
              <button className="btn" onClick={() => setEditP(null)}>
                取消
              </button>
              <button className="btn primary" disabled={!editP.name?.trim()} onClick={saveProject}>
                儲存
              </button>
            </>
          }
        >
          <label className="field">
            <span>專案名稱</span>
            <input className="input" value={editP.name ?? ''} onChange={(e) => setEditP({ ...editP, name: e.target.value })} placeholder="例：Farnesene、FY115 計畫" autoFocus />
          </label>
          <label className="field">
            <span>說明（選填）</span>
            <input className="input" value={editP.description ?? ''} onChange={(e) => setEditP({ ...editP, description: e.target.value })} />
          </label>
          <div className="field">
            <span>顏色</span>
            <div className="swatches">
              {COLORS.map((c) => (
                <button key={c} type="button" className={editP.color === c ? 'on' : ''} style={{ background: c }} onClick={() => setEditP({ ...editP, color: c })} aria-label={c} />
              ))}
            </div>
          </div>
        </Sheet>
      )}
      {editT && (
        <Sheet
          title="編輯標籤"
          onClose={() => setEditT(null)}
          actions={
            <>
              <button className="btn danger" style={{ marginRight: 'auto' }} onClick={deleteTag}>
                刪除
              </button>
              <button className="btn" onClick={() => setEditT(null)}>
                取消
              </button>
              <button className="btn primary" onClick={saveTag}>
                儲存
              </button>
            </>
          }
        >
          <label className="field">
            <span>標籤名稱</span>
            <input className="input" value={editT.name} onChange={(e) => setEditT({ ...editT, name: e.target.value })} autoFocus />
            <small>改成已經存在的標籤名稱，會把兩個標籤合併</small>
          </label>
          <div className="field">
            <span>顏色</span>
            <div className="swatches">
              {COLORS.map((c) => (
                <button key={c} type="button" className={editT.color === c ? 'on' : ''} style={{ background: c }} onClick={() => setEditT({ ...editT, color: c })} aria-label={c} />
              ))}
            </div>
          </div>
        </Sheet>
      )}
    </>
  );
}
