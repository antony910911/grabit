import { useState } from 'react';
import { api, type Group, type Project, type Storage, type User } from '../api';
import { Empty, ErrorBox, Loading, ProjectBadge, Sheet, SourceIcon, Switch } from '../components';
import { ask, formatBytes, formatTime, Link, useLoad, useMe, useToast } from '../lib';

const TYPE_LABEL: Record<string, string> = { group: 'LINE 群組', room: '多人聊天', user: '一對一', email: 'Email', upload: '手動上傳' };
const FILE_TYPES: [string, string][] = [
  ['pdf', 'PDF'],
  ['document', 'Word／文字'],
  ['spreadsheet', 'Excel／CSV'],
  ['presentation', '簡報'],
  ['archive', '壓縮檔'],
  ['other', '其他'],
];

export function Groups() {
  const me = useMe();
  const { data, error, loading, reload } = useLoad(() => api<{ items: Group[] }>('/groups'), []);
  const [edit, setEdit] = useState<Group | null>(null);
  const admin = me?.role === 'admin';
  const pending = data?.items.filter((g) => !g.configured) ?? [];
  const toast = useToast();
  const applyProject = async (g: Group) => {
    try {
      const r = await api<{ updated: number }>(`/groups/${encodeURIComponent(g.id)}/apply-project`, { method: 'POST', json: {} });
      toast(`已把 ${r.updated} 個檔案加入「${g.project_name}」`);
      reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>群組</h1>
          <p>一個 Bot 加入多個群組；每個群組可以有自己的雲端空間、資料夾、規則與權限</p>
        </div>
      </div>
      {pending.length > 0 && admin && (
        <div className="notice info">
          有 {pending.length} 個新群組待設定。設定前會先用預設值備份到「待分類」，不會漏掉檔案。
        </div>
      )}
      {error && <ErrorBox message={error} onRetry={reload} />}
      {loading && !data ? (
        <Loading />
      ) : !data?.items.length ? (
        <div className="card">
          <Empty title="還沒有群組">
            在 LINE 把官方帳號邀請進群組，就會自動出現在這裡。
            <ol className="small" style={{ textAlign: 'left', maxWidth: 360, margin: '12px auto 0' }}>
              <li>把 GrabIt Bot 邀請加入 LINE 群組</li>
              <li>系統自動辨識群組並取得名稱</li>
              <li>這裡出現「待設定」的群組</li>
              <li>指定雲端空間、資料夾與規則</li>
              <li>完成設定，之後自動歸檔</li>
            </ol>
          </Empty>
        </div>
      ) : (
        <div className="stack">
          {data.items.map((g) => (
            <div key={g.id} className="card card-pad" style={{ opacity: g.joined || g.source_type === 'email' || g.source_type === 'upload' ? 1 : 0.6 }}>
              <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
                <div className="grow">
                  <div className="row" style={{ gap: 6 }}>
                    <SourceIcon type={g.source_type} />
                    <strong>{g.alias || g.name || '（未命名）'}</strong>
                    <span className="badge muted">{TYPE_LABEL[g.source_type]}</span>
                    {!g.configured && <span className="badge warn">待設定</span>}
                    {!g.enabled && <span className="badge muted">已暫停</span>}
                    {!g.joined && g.source_type === 'group' && <span className="badge danger">Bot 已離開</span>}
                  </div>
                  <div className="muted small" style={{ marginTop: 4 }}>
                    <Link to={`/files?group=${encodeURIComponent(g.id)}`}>{g.file_count} 個檔案</Link> · {formatBytes(g.bytes)}
                    {g.last_file_at ? ` · 最近 ${formatTime(g.last_file_at)}` : ''}
                  </div>
                  <div className="row small" style={{ gap: 10, marginTop: 8 }}>
                    <span>☁ {g.storage_name ?? '預設空間'}</span>
                    <span>📁 {g.base_folder || `待分類/${g.alias || g.name}`}</span>
                    {g.project_name && <ProjectBadge name={g.project_name} />}
                    {!g.backup_images && <span className="muted">不備份照片</span>}
                    {!g.backup_videos && <span className="muted">不備份影片</span>}
                    {g.notify ? <span>🔔 歸檔通知</span> : null}
                    {g.ai_enabled ? <span>✨ AI 判讀{g.ai_external ? '（可用外部 AI）' : ''}</span> : <span className="muted">AI 關閉</span>}
                    {g.members.length > 0 && <span>👥 {g.members.length} 位成員可看</span>}
                  </div>
                  {g.project_id && g.outside_project > 0 && admin && (
                    <div className="notice info small" style={{ margin: '10px 0 0' }}>
                      <span className="grow">有 {g.outside_project} 個之前收到的檔案還沒加入「{g.project_name}」。</span>
                      <button className="btn sm" onClick={() => applyProject(g)}>
                        加入專案
                      </button>
                    </div>
                  )}
                </div>
                {admin && (
                  <button className={`btn sm ${g.configured ? '' : 'primary'}`} onClick={() => setEdit(g)}>
                    {g.configured ? '設定' : '開始設定'}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {edit && (
        <GroupSettings
          group={edit}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            reload();
          }}
        />
      )}
    </>
  );
}

function GroupSettings({ group, onClose, onSaved }: { group: Group; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const storages = useLoad(() => api<{ items: Storage[] }>('/storages'), []);
  const projects = useLoad(() => api<{ items: Project[] }>('/projects'), []);
  const users = useLoad(() => api<{ items: User[] }>('/users'), []);
  const [g, setG] = useState({ ...group, file_types: group.file_types ?? [] });
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof g>(k: K, v: (typeof g)[K]) => setG((x) => ({ ...x, [k]: v }));
  const isLine = ['group', 'room', 'user'].includes(group.source_type);

  const save = async () => {
    setBusy(true);
    try {
      await api(`/groups/${encodeURIComponent(group.id)}`, {
        method: 'PATCH',
        json: {
          alias: g.alias,
          enabled: !!g.enabled,
          storage_id: g.storage_id,
          base_folder: g.base_folder,
          rename_template: g.rename_template,
          file_types: g.file_types,
          backup_images: !!g.backup_images,
          backup_videos: !!g.backup_videos,
          notify: !!g.notify,
          ai_enabled: !!g.ai_enabled,
          ai_external: !!g.ai_external,
          project_id: g.project_id,
          configured: true,
          members: g.members,
        },
      });
      toast('群組設定已儲存');
      // 換了預設專案：問要不要把現有檔案也加進去（預設專案原本只影響之後收到的檔案）
      if (g.project_id && g.project_id !== group.project_id && group.file_count > 0) {
        const name = projects.data?.items.find((p) => p.id === g.project_id)?.name ?? '這個專案';
        if (await ask(`要把這個群組現有的 ${group.file_count} 個檔案也加入「${name}」嗎？（已經在其他專案的檔案不會被改動）`, '加入專案')) {
          const r = await api<{ updated: number }>(`/groups/${encodeURIComponent(group.id)}/apply-project`, { method: 'POST', json: {} });
          toast(`已把 ${r.updated} 個檔案加入「${name}」`);
        }
      }
      onSaved();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const ALL = FILE_TYPES.map(([k]) => k);
  const toggleType = (t: string) => {
    const cur = g.file_types.length ? g.file_types.filter((x) => ALL.includes(x)) : ALL;
    const next = cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t];
    // 全選 = 不限制；全部取消 = 只收照片影片（由下方開關決定）
    set('file_types', next.length === ALL.length ? [] : next.length ? next : ['__none__']);
  };
  const toggleMember = (email: string) => set('members', g.members.includes(email) ? g.members.filter((x) => x !== email) : [...g.members, email]);
  const limitedUsers = users.data?.items.filter((u) => u.role !== 'admin' && !u.all_groups) ?? [];

  return (
    <Sheet
      title={`群組設定：${group.alias || group.name}`}
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy} onClick={save}>
            {group.configured ? '儲存' : '完成設定，開始歸檔'}
          </button>
        </>
      }
    >
      <label className="field">
        <span>自訂名稱</span>
        <input className="input" value={g.alias ?? ''} placeholder={group.name} onChange={(e) => set('alias', e.target.value)} />
        <small>資料夾變數 {'{group}'} 會使用這個名稱。LINE 上的名稱：{group.name || '—'}</small>
      </label>
      <div className="kv-row">
        <div className="lbl">
          自動下載
          <small>關閉後這個來源的新檔案不再備份</small>
        </div>
        <Switch checked={!!g.enabled} onChange={(v) => set('enabled', v ? 1 : 0)} label="自動下載" />
      </div>
      <label className="field">
        <span>雲端儲存空間</span>
        <select className="select" value={g.storage_id ?? ''} onChange={(e) => set('storage_id', e.target.value ? Number(e.target.value) : null)}>
          <option value="">預設空間</option>
          {storages.data?.items.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}（{s.typeLabel}）
            </option>
          ))}
        </select>
        <small>例如工作群組存公司 OneDrive、私人群組存個人 Google Drive</small>
      </label>
      <label className="field">
        <span>預設專案</span>
        <select className="select" value={g.project_id ?? ''} onChange={(e) => set('project_id', e.target.value ? Number(e.target.value) : null)} aria-describedby="project-hint">
          <option value="">不指定</option>
          {projects.data?.items.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <small id="project-hint">這個群組之後收到的檔案會自動加入這個專案。</small>
      </label>
      <label className="field">
        <span>指定儲存資料夾（沒有規則符合時）</span>
        <input className="input" value={g.base_folder ?? ''} placeholder={`待分類/${g.alias || group.name}`} onChange={(e) => set('base_folder', e.target.value)} />
        <small>可用變數：{'{group} {yyyy} {MM}'}。這裡的檔案仍會出現在「待分類」讓你確認。</small>
      </label>
      <label className="field">
        <span>自動重新命名規則</span>
        <input className="input" value={g.rename_template ?? ''} placeholder="留空 = 保留原檔名，例：{yyyyMMdd}_{name}" onChange={(e) => set('rename_template', e.target.value)} />
        <small>分類規則有自己的改名設定時，以規則為準</small>
      </label>
      <div className="field">
        <span>接收檔案類型</span>
        <div className="checks">
          {FILE_TYPES.map(([k, v]) => (
            <label key={k} className="check">
              <input type="checkbox" className="cb" checked={!g.file_types.length || g.file_types.includes(k)} onChange={() => toggleType(k)} />
              {v}
            </label>
          ))}
        </div>
        <small>全部勾選 = 不限制</small>
      </div>
      {isLine && (
        <>
          <div className="kv-row">
            <div className="lbl">備份照片</div>
            <Switch checked={!!g.backup_images} onChange={(v) => set('backup_images', v ? 1 : 0)} label="備份照片" />
          </div>
          <div className="kv-row">
            <div className="lbl">備份影片與錄音</div>
            <Switch checked={!!g.backup_videos} onChange={(v) => set('backup_videos', v ? 1 : 0)} label="備份影片" />
          </div>
          <div className="kv-row">
            <div className="lbl">
              歸檔成功通知
              <small>Bot 在群組裡回覆「已歸檔到哪個資料夾」（回覆訊息免費）</small>
            </div>
            <Switch checked={!!g.notify} onChange={(v) => set('notify', v ? 1 : 0)} label="歸檔通知" />
          </div>
        </>
      )}
      <div className="kv-row">
        <div className="lbl">
          AI 判讀內容
          <small>產生摘要、標籤；規則判斷不了時由 AI 建議分類</small>
        </div>
        <Switch checked={!!g.ai_enabled} onChange={(v) => set('ai_enabled', v ? 1 : 0)} label="AI" />
      </div>
      {!!g.ai_enabled && (
        <div className="kv-row">
          <div className="lbl">
            允許送交外部 AI（Gemini 免費版）
            <small>Gemini 免費版會用送出的內容改善 Google 的產品。公司機密、個資的群組請不要打開；使用免費的 Workers AI 時不受影響</small>
          </div>
          <Switch checked={!!g.ai_external} onChange={(v) => set('ai_external', v ? 1 : 0)} label="允許送交外部 AI" />
        </div>
      )}
      <div className="field" style={{ marginTop: 14 }}>
        <span>檔案存取權限</span>
        {limitedUsers.length === 0 ? (
          <small>管理員與「可看所有群組」的成員都能看到。要限制個別成員，請先到「成員與權限」新增成員。</small>
        ) : (
          <>
            <div className="checks">
              {limitedUsers.map((u) => (
                <label key={u.email} className="check small">
                  <input type="checkbox" className="cb" checked={g.members.includes(u.email)} onChange={() => toggleMember(u.email)} />
                  {u.name || u.email}
                </label>
              ))}
            </div>
            <small>勾選的成員可以看到這個群組的檔案（管理員一律可看）</small>
          </>
        )}
      </div>
    </Sheet>
  );
}
