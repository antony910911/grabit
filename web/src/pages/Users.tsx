import { useState } from 'react';
import { api, type Group, type Role, type User } from '../api';
import { Empty, ErrorBox, Icon, Loading, Sheet } from '../components';
import { ask, formatTime, useLoad, useMe, useToast } from '../lib';

const ROLE: Record<Role, [string, string]> = {
  admin: ['管理員', '所有群組、規則、雲端與成員設定'],
  editor: ['編輯者', '整理檔案（搬移、改名、標籤）與規則'],
  viewer: ['檢視者', '只能查看與下載'],
};

export function Users() {
  const me = useMe();
  const users = useLoad(() => api<{ items: User[] }>('/users'), []);
  const groups = useLoad(() => api<{ items: Group[] }>('/groups'), []);
  const [edit, setEdit] = useState<(Partial<User> & { isNew?: boolean }) | null>(null);
  if (me && me.role !== 'admin') return <div className="notice warn">只有管理員可以管理成員。</div>;
  const groupName = (id: string) => {
    const g = groups.data?.items.find((x) => x.id === id);
    return g ? g.alias || g.name : id.slice(0, 8);
  };
  return (
    <>
      <div className="page-head">
        <div>
          <h1>成員與權限</h1>
          <p>用 email 登入（Cloudflare Access），依角色與群組決定能看到哪些檔案</p>
        </div>
        <button className="btn sm primary" onClick={() => setEdit({ isNew: true, email: '', role: 'viewer', all_groups: 0, groups: [] })}>
          <Icon name="plus" />
          新增成員
        </button>
      </div>
      {users.error && <ErrorBox message={users.error} />}
      <div className="card">
        {users.loading && !users.data ? (
          <Loading />
        ) : !users.data?.items.length ? (
          <Empty title="還沒有成員" />
        ) : (
          <ul className="list">
            {users.data.items.map((u) => (
              <li key={u.email} className="rule-line">
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="title" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {u.name ? `${u.name}（${u.email}）` : u.email} {u.email === me?.email && <span className="badge muted">你</span>}
                  </div>
                  <div className="meta">
                    <span className={`badge ${u.role === 'admin' ? 'info' : 'muted'}`}>{ROLE[u.role][0]}</span>{' '}
                    {u.role === 'admin' || u.all_groups ? '所有群組' : u.groups.length ? u.groups.map(groupName).join('、') : '尚未授權任何群組'}
                    {u.last_seen ? ` · 最近登入 ${formatTime(u.last_seen)}` : ' · 尚未登入'}
                  </div>
                </div>
                <button className="btn sm" onClick={() => setEdit(u)}>
                  編輯
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="muted small" style={{ marginTop: 12 }}>
        新成員也要加到 Cloudflare Access 的允許名單，才能通過登入頁。
      </p>
      {edit && (
        <UserSheet
          user={edit}
          groups={groups.data?.items ?? []}
          self={me?.email}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            users.reload();
          }}
        />
      )}
    </>
  );
}

function UserSheet({ user, groups, self, onClose, onSaved }: { user: Partial<User> & { isNew?: boolean }; groups: Group[]; self?: string; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [u, setU] = useState({ email: user.email ?? '', name: user.name ?? '', role: user.role ?? 'viewer', all_groups: !!user.all_groups, groups: user.groups ?? [] });
  const save = async () => {
    try {
      if (user.isNew) await api('/users', { method: 'POST', json: u });
      else await api(`/users/${encodeURIComponent(u.email)}`, { method: 'PATCH', json: u });
      toast('已儲存');
      onSaved();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const remove = async () => {
    if (!(await ask(`移除成員 ${u.email}？`))) return;
    try {
      await api(`/users/${encodeURIComponent(u.email)}`, { method: 'DELETE' });
      onSaved();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const toggle = (id: string) => setU((x) => ({ ...x, groups: x.groups.includes(id) ? x.groups.filter((g) => g !== id) : [...x.groups, id] }));
  return (
    <Sheet
      title={user.isNew ? '新增成員' : '編輯成員'}
      onClose={onClose}
      actions={
        <>
          {!user.isNew && u.email !== self && (
            <button className="btn danger" style={{ marginRight: 'auto' }} onClick={remove}>
              移除
            </button>
          )}
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={!u.email} onClick={save}>
            儲存
          </button>
        </>
      }
    >
      <label className="field">
        <span>Email</span>
        <input className="input" type="email" value={u.email} disabled={!user.isNew} onChange={(e) => setU({ ...u, email: e.target.value })} autoFocus />
      </label>
      <label className="field">
        <span>名稱（選填）</span>
        <input className="input" value={u.name} onChange={(e) => setU({ ...u, name: e.target.value })} />
      </label>
      <div className="field">
        <span>角色</span>
        {(Object.keys(ROLE) as Role[]).map((r) => (
          <label key={r} className="check" style={{ display: 'flex', padding: '6px 0' }}>
            <input type="radio" name="role" checked={u.role === r} onChange={() => setU({ ...u, role: r })} />
            <span>
              <strong>{ROLE[r][0]}</strong> <span className="muted small">{ROLE[r][1]}</span>
            </span>
          </label>
        ))}
      </div>
      {u.role !== 'admin' && (
        <div className="field">
          <span>可以看到的群組</span>
          <label className="check" style={{ marginBottom: 8 }}>
            <input type="checkbox" className="cb" checked={u.all_groups} onChange={(e) => setU({ ...u, all_groups: e.target.checked })} />
            所有群組（包含之後加入的）
          </label>
          {!u.all_groups && (
            <div className="checks">
              {groups.map((g) => (
                <label key={g.id} className="check small">
                  <input type="checkbox" className="cb" checked={u.groups.includes(g.id)} onChange={() => toggle(g.id)} />
                  {g.alias || g.name || g.id.slice(0, 8)}
                </label>
              ))}
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}
