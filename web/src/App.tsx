import { useEffect, useState, type ReactElement } from 'react';
import { api, ApiError, logout, type Me, type Role } from './api';
import { Brand, Icon, Sheet } from './components';
import { ConfirmHost, Link, MeCtx, navigate, usePath, useToast } from './lib';
import { Dashboard } from './pages/Dashboard';
import { Rules } from './pages/Rules';
import { Groups } from './pages/Groups';
import { Logs } from './pages/Logs';
import { Library } from './pages/Library';
import { Ask } from './pages/Ask';
import { Login } from './pages/Login';
import { Account } from './pages/Account';
import { AdminSettings } from './pages/AdminSettings';
import { applyTheme } from './theme';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  /** 至少要這個角色才看得到 */
  role?: Role;
  match?: string[];
}

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };
const allowed = (me: Me | null, role?: Role) => !role || (!!me && RANK[me.role] >= RANK[role]);

// 主要功能：每個人都看得到
const MAIN: NavItem[] = [
  { to: '/', label: '總覽', icon: 'home' },
  { to: '/files', label: '檔案', icon: 'files', match: ['/files', '/library', '/folders', '/labels'] },
  { to: '/ask', label: '問 AI', icon: 'ai' },
];
// 管理：依角色顯示
const MANAGE: NavItem[] = [
  { to: '/rules', label: '分類規則', icon: 'rules', role: 'editor' },
  { to: '/groups', label: '群組', icon: 'groups', role: 'editor' },
  { to: '/logs', label: '歸檔紀錄', icon: 'history', role: 'editor' },
  { to: '/settings', label: '設定', icon: 'settings', role: 'admin', match: ['/settings', '/storages', '/users'] },
];

export interface DemoApi {
  groups(): { id: string; name: string }[];
  samples: string[];
  simulate(groupId: string, fileName: string, sender: string): Promise<void>;
  reset(): void;
  onReply(fn: (text: string) => void): () => void;
}

declare global {
  interface Window {
    __grabitDemo?: DemoApi;
  }
}

function More({ me }: { me: Me | null }) {
  const items = MANAGE.filter((n) => allowed(me, n.role));
  return (
    <>
      <div className="page-head">
        <div>
          <h1>更多</h1>
          <p>{me?.name ?? me?.email}</p>
        </div>
      </div>
      {items.length > 0 && (
        <div className="card menu-list" style={{ marginBottom: 14 }}>
          {items.map((n) => (
            <Link key={n.to} to={n.to}>
              <Icon name={n.icon} />
              {n.label}
            </Link>
          ))}
        </div>
      )}
      <div className="card menu-list">
        <Link to="/account">
          <Icon name="users" />
          個人設定（外觀、登入）
        </Link>
      </div>
    </>
  );
}

function NoAccess({ need }: { need: Role }) {
  return <div className="notice warn">這一頁需要「{need === 'admin' ? '管理員' : '編輯者'}」以上的權限。需要的話請找管理員。</div>;
}

function Simulator({ onClose }: { onClose: () => void }) {
  const demo = window.__grabitDemo!;
  const toast = useToast();
  const groups = demo.groups();
  const [group, setGroup] = useState(groups[0]?.id ?? '');
  const [name, setName] = useState(demo.samples[0]!);
  const [sender, setSender] = useState('小明');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    let replied = false;
    // 群組有開「歸檔成功通知」時，Bot 的回覆會由 App 顯示，這裡就不再蓋掉
    const off = demo.onReply(() => (replied = true));
    await demo.simulate(group, name, sender);
    off();
    setBusy(false);
    if (!replied) toast(`已收到「${name}」並完成歸檔`, 'ok', { label: '查看檔案', onClick: () => navigate('/files') });
    onClose();
  };
  return (
    <Sheet
      title="模擬 LINE 群組傳檔"
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy || !name.trim()} onClick={send}>
            傳送
          </button>
        </>
      }
    >
      <p className="muted small" style={{ marginTop: 0 }}>
        展示版會把這個檔案當成真的從 LINE 群組收到，走完整的歸檔流程：群組設定 → 檔名規則 → AI 判讀 → 上傳 → 去重 → 版本辨識。
      </p>
      <label className="field">
        <span>群組</span>
        <select className="select" value={group} onChange={(e) => setGroup(e.target.value)}>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>檔名</span>
        <input className="input" list="demo-samples" value={name} onChange={(e) => setName(e.target.value)} />
        <datalist id="demo-samples">
          {demo.samples.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <div className="chips">
          {demo.samples.slice(0, 6).map((s) => (
            <button type="button" key={s} className="chip" onClick={() => setName(s)}>
              {s}
            </button>
          ))}
        </div>
      </label>
      <label className="field">
        <span>傳送者</span>
        <input className="input" value={sender} onChange={(e) => setSender(e.target.value)} />
      </label>
    </Sheet>
  );
}

export function App() {
  const path = usePath();
  const toast = useToast();
  useEffect(() => window.__grabitDemo?.onReply((text) => toast(`LINE Bot 在群組回覆：${text.replace(/\n/g, ' ')}`)) as (() => void) | undefined, [toast]);
  const [me, setMe] = useState<Me | null>(null);
  const [meError, setMeError] = useState<string | null>(null);
  const [needLogin, setNeedLogin] = useState<string | null | false>(false);
  const [simulate, setSimulate] = useState(false);
  useEffect(() => {
    api<Me>('/me')
      .then((m) => {
        setMe(m);
        if (m.prefs) applyTheme(m.prefs);
      })
      .catch((e: Error) => (e instanceof ApiError && e.status === 401 ? setNeedLogin(null) : setMeError(e.message)));
    const onLogin = (e: Event) => setNeedLogin((e as CustomEvent<string>).detail);
    window.addEventListener('grabit-login-required', onLogin);
    return () => window.removeEventListener('grabit-login-required', onLogin);
  }, []);

  if (needLogin !== false || (path === '/login' && !me)) return <Login message={needLogin || null} />;

  const isActive = (n: NavItem) => (n.to === '/' ? path === '/' : (n.match ?? [n.to]).some((m) => path.startsWith(m)));
  const guard = (role: Role, el: ReactElement) => (me && !allowed(me, role) ? <NoAccess need={role} /> : el);
  let page;
  if (['/files', '/library', '/folders', '/labels'].some((m) => path.startsWith(m))) page = <Library key={path} />;
  else if (path.startsWith('/ask')) page = <Ask />;
  else if (path.startsWith('/rules')) page = guard('editor', <Rules />);
  else if (path.startsWith('/groups')) page = guard('editor', <Groups />);
  else if (path.startsWith('/logs')) page = guard('editor', <Logs />);
  else if (['/settings', '/storages', '/users'].some((m) => path.startsWith(m))) page = guard('admin', <AdminSettings />);
  else if (path.startsWith('/account')) page = <Account me={me} onPrefs={(prefs) => setMe((m) => (m ? { ...m, prefs } : m))} />;
  else if (path.startsWith('/more')) page = <More me={me} />;
  else page = <Dashboard onSimulate={me?.demo && window.__grabitDemo ? () => setSimulate(true) : undefined} />;

  const navLink = (n: NavItem) => (
    <Link key={n.to} to={n.to} className={isActive(n) ? 'active' : ''}>
      <Icon name={n.icon} />
      {n.label}
    </Link>
  );
  const manage = MANAGE.filter((n) => allowed(me, n.role));
  // 手機底部：總覽、檔案、問 AI、（編輯者以上）規則、更多
  const bottom: NavItem[] = [...MAIN, ...(allowed(me, 'editor') ? [MANAGE[0]!] : []), { to: '/more', label: '更多', icon: 'more', match: ['/more', '/account', ...manage.slice(1).flatMap((n) => n.match ?? [n.to])] }];

  return (
    <MeCtx.Provider value={me}>
      {me?.demo && (
        <div className="demo-banner">
          <span className="grow">展示版：資料、雲端空間和 AI 都是模擬的，重新整理會還原。</span>
          <button onClick={() => setSimulate(true)}>模擬群組傳檔</button>
        </div>
      )}
      <div className="app">
        <nav className="sidebar" aria-label="主選單">
          <div className="brand">
            <Brand />
          </div>
          {MAIN.map(navLink)}
          {manage.length > 0 && <div className="section">管理</div>}
          {manage.map(navLink)}
          {me && (
            <div className="foot">
              <Link to="/account">
                <strong style={{ color: 'var(--text)' }}>{me.name ?? me.email}</strong>
                <br />
                {{ admin: '管理員', editor: '編輯者', viewer: '檢視者' }[me.role]}・個人設定
              </Link>
              {!me.demo && (
                <button className="btn sm ghost" style={{ padding: 0, marginTop: 6 }} onClick={() => logout()}>
                  登出
                </button>
              )}
            </div>
          )}
        </nav>
        <main className="main">
          {meError ? <div className="notice danger">{meError}</div> : page}
        </main>
        <nav className="bottom-nav" aria-label="主選單">
          {bottom.map((n) => (
            <Link key={n.to} to={n.to} className={isActive(n) ? 'active' : ''}>
              <Icon name={n.icon} />
              {n.label}
            </Link>
          ))}
        </nav>
      </div>
      {simulate && window.__grabitDemo && <Simulator onClose={() => setSimulate(false)} />}
      <ConfirmHost />
    </MeCtx.Provider>
  );
}
