import { useState } from 'react';
import { api, type Group } from '../api';
import { ErrorBox, Loading, Sheet, Switch } from '../components';
import { formatTime, Link, useLoad, useToast } from '../lib';

const TYPE_LABEL = { group: '群組', room: '多人聊天', user: '一對一' };

export function Groups() {
  const toast = useToast();
  const { data, error, loading, reload } = useLoad(() => api<{ items: Group[] }>('/groups'), []);
  const [edit, setEdit] = useState<Group | null>(null);
  const [alias, setAlias] = useState('');

  const update = async (g: Group, body: { alias?: string | null; enabled?: boolean }) => {
    try {
      await api(`/groups/${encodeURIComponent(g.id)}`, { method: 'PATCH', json: body });
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
          <p>Bot 所在的 LINE 群組，可以個別暫停備份</p>
        </div>
      </div>
      {error && <ErrorBox message={error} onRetry={reload} />}
      <div className="card">
        {loading && !data ? (
          <Loading />
        ) : !data?.items.length ? (
          <div className="empty">
            <h3>還沒有群組</h3>
            在 LINE 把你的官方帳號邀請進群組，就會自動出現在這裡。
          </div>
        ) : (
          <ul className="list">
            {data.items.map((g) => (
              <li key={g.id} className="rule-line" style={{ opacity: g.joined ? 1 : 0.55 }}>
                <div className="grow">
                  <div className="title">
                    {g.alias || g.name || '（未命名）'}{' '}
                    <span className="badge muted">{TYPE_LABEL[g.source_type] ?? g.source_type}</span>{' '}
                    {!g.joined && <span className="badge danger">Bot 已離開</span>}
                  </div>
                  <div className="meta">
                    {g.alias && g.name ? `LINE 名稱：${g.name} · ` : ''}
                    <Link to={`/files?group=${encodeURIComponent(g.id)}`}>{g.file_count} 個檔案</Link>
                    {g.last_file_at ? ` · 最近 ${formatTime(g.last_file_at)}` : ''}
                  </div>
                </div>
                <button
                  className="btn sm"
                  onClick={() => {
                    setEdit(g);
                    setAlias(g.alias ?? '');
                  }}
                >
                  改名
                </button>
                <Switch checked={!!g.enabled} onChange={(v) => update(g, { enabled: v })} label={`備份「${g.alias || g.name}」`} />
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="muted small">關閉開關後，這個群組的新檔案就不會再備份；已備份的檔案不受影響。</p>

      {edit && (
        <Sheet
          title="群組顯示名稱"
          onClose={() => setEdit(null)}
          actions={
            <>
              <button className="btn" onClick={() => setEdit(null)}>
                取消
              </button>
              <button
                className="btn primary"
                onClick={async () => {
                  await update(edit, { alias: alias.trim() || null });
                  setEdit(null);
                }}
              >
                儲存
              </button>
            </>
          }
        >
          <label className="field">
            <span>自訂名稱</span>
            <input className="input" value={alias} onChange={(e) => setAlias(e.target.value)} placeholder={edit.name || '例：酵母研發'} autoFocus />
            <small>資料夾變數 {'{group}'} 會使用這個名稱（只影響之後的新檔案）。留空則使用 LINE 上的群組名稱。</small>
          </label>
        </Sheet>
      )}
    </>
  );
}
