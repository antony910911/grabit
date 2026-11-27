// 個人設定：外觀（每個人自己選）、登入中的裝置、你的權限
import { useEffect, useState } from 'react';
import { api, logout, type Me, type Role } from '../api';
import { useToast } from '../lib';
import { applyTheme, PALETTES, type Palette, type ThemeMode, type ThemePrefs } from '../theme';

const ROLE_LABEL: Record<Role, string> = { admin: '管理員', editor: '編輯者', viewer: '檢視者' };

/** 角色權限一覽（成員管理頁與個人設定頁共用） */
const PERMS: { label: string; viewer: string | boolean; editor: string | boolean; admin: string | boolean }[] = [
  { label: '看檔案、下載、搜尋、問 AI', viewer: '被授權的群組', editor: '被授權的群組', admin: '全部群組' },
  { label: '搬移、改名、刪除檔案，設定專案與標籤', viewer: false, editor: true, admin: true },
  { label: '分類規則、套用到舊檔案', viewer: false, editor: true, admin: true },
  { label: '歸檔紀錄、復原搬移', viewer: false, editor: true, admin: true },
  { label: '群組（雲端、資料夾、通知、成員）', viewer: false, editor: '只能看', admin: true },
  { label: '設定：雲端空間、成員與權限、系統設定', viewer: false, editor: false, admin: true },
  { label: '自己的外觀與登入裝置', viewer: true, editor: true, admin: true },
];

export function PermissionTable({ highlight }: { highlight?: Role }) {
  const cell = (v: string | boolean) => (v === true ? <span className="yes">✓</span> : v === false ? <span className="no">—</span> : <span className="small">{v}</span>);
  return (
    <div className="table-wrap">
      <table className="perm-table">
        <thead>
          <tr>
            <th>可以做的事</th>
            {(['viewer', 'editor', 'admin'] as Role[]).map((r) => (
              <th key={r} style={highlight === r ? { color: 'var(--accent)' } : undefined}>
                {ROLE_LABEL[r]}
                {highlight === r ? '（你）' : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {PERMS.map((p) => (
            <tr key={p.label}>
              <td>{p.label}</td>
              <td>{cell(p.viewer)}</td>
              <td>{cell(p.editor)}</td>
              <td>{cell(p.admin)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const MODES: { key: ThemeMode; label: string }[] = [
  { key: 'system', label: '跟隨系統' },
  { key: 'light', label: '淺色' },
  { key: 'dark', label: '深色' },
];

export function Account({ me, onPrefs }: { me: Me | null; onPrefs: (p: ThemePrefs) => void }) {
  const toast = useToast();
  const prefs: ThemePrefs = me?.prefs ?? { mode: 'system', palette: 'indigo' };
  const [sessions, setSessions] = useState<{ id: string; last_seen: string; user_agent: string | null; current: boolean }[] | null>(null);
  useEffect(() => {
    if (me && !me.demo) api<{ items: { id: string; last_seen: string; user_agent: string | null; current: boolean }[] }>('/me/sessions').then((r) => setSessions(r.items)).catch(() => {});
  }, [me]);

  const save = async (patch: Partial<ThemePrefs>) => {
    const next = { ...prefs, ...patch };
    applyTheme(next);
    onPrefs(next);
    try {
      await api('/me/prefs', { method: 'PUT', json: next });
    } catch (e) {
      toast(`外觀已套用在這台裝置，但沒有存到帳號：${(e as Error).message}`, 'error');
    }
  };
  const others = async () => {
    const r = await api<{ revoked: number }>('/me/logout-others', { method: 'POST', json: {} });
    toast(`已登出其他 ${r.revoked} 個裝置`);
    setSessions((s) => s?.filter((x) => x.current) ?? null);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>個人設定</h1>
          <p>
            {me?.name ? `${me.name}・` : ''}
            {me?.email}・{ROLE_LABEL[me?.role ?? 'viewer']}
          </p>
        </div>
      </div>
      <div className="stack">
        <section className="card card-pad">
          <h2>外觀</h2>
          <p className="muted small" style={{ margin: '4px 0 12px' }}>
            只會改變你自己看到的樣子，換裝置登入也會保留。
          </p>
          <div className="segmented" role="radiogroup" aria-label="淺色或深色">
            {MODES.map((m) => (
              <button key={m.key} role="radio" aria-checked={prefs.mode === m.key} className={prefs.mode === m.key ? 'on' : ''} onClick={() => save({ mode: m.key })}>
                {m.label}
              </button>
            ))}
          </div>
          <div className="small" style={{ fontWeight: 600, margin: '16px 0 8px' }}>
            主題色
          </div>
          <div className="palette-grid" role="radiogroup" aria-label="主題色">
            {PALETTES.map((p) => (
              <button key={p.key} role="radio" aria-checked={prefs.palette === p.key} className={`palette ${prefs.palette === p.key ? 'on' : ''}`} onClick={() => save({ palette: p.key as Palette })}>
                <span className="swatch">
                  {p.colors.map((c) => (
                    <i key={c} style={{ background: c }} />
                  ))}
                </span>
                <strong>{p.label}</strong>
              </button>
            ))}
          </div>
        </section>

        {!me?.demo && (
          <section className="card card-pad">
            <h2>登入</h2>
            <p className="muted small" style={{ margin: '4px 0 12px' }}>
              用 Google 帳號登入{sessions ? `，目前有 ${sessions.length} 個裝置登入中` : ''}。
            </p>
            <div className="row">
              <button className="btn" onClick={() => logout()}>
                登出
              </button>
              {sessions && sessions.length > 1 && (
                <button className="btn" onClick={others}>
                  登出其他裝置
                </button>
              )}
              <button className="btn danger" onClick={() => logout(true)}>
                登出所有裝置
              </button>
            </div>
          </section>
        )}

        <section className="card card-pad">
          <h2>你可以做的事</h2>
          <p className="muted small" style={{ margin: '4px 0 12px' }}>
            你的角色是「{ROLE_LABEL[me?.role ?? 'viewer']}」。需要更多權限請找管理員。
          </p>
          <PermissionTable highlight={me?.role} />
        </section>
      </div>
    </>
  );
}
