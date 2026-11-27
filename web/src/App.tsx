import { useEffect, useState } from 'react';
import { api, type Me } from './api';
import { Brand, Icon, Sheet } from './components';
import { Link, MeCtx, navigate, usePath, useToast } from './lib';
import { Dashboard } from './pages/Dashboard';
import { Files } from './pages/Files';
import { Rules } from './pages/Rules';
import { Groups } from './pages/Groups';
import { SettingsPage } from './pages/Settings';
import { Logs } from './pages/Logs';
import { Folders } from './pages/Folders';
import { Ask } from './pages/Ask';
import { Labels } from './pages/Labels';
import { Storages } from './pages/Storages';
import { Users } from './pages/Users';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  admin?: boolean;
}

const MAIN: NavItem[] = [
  { to: '/', label: '總覽', icon: 'home' },
  { to: '/files', label: '全部檔案', icon: 'files' },
  { to: '/ask', label: '問 AI', icon: 'ai' },
];
const SYSTEM: NavItem[] = [
  { to: '/folders', label: '資料夾管理', icon: 'folder' },
  { to: '/rules', label: '分類規則', icon: 'rules' },
  { to: '/groups', label: '群組設定', icon: 'groups' },
  { to: '/labels', label: '專案與標籤', icon: 'tag' },
  { to: '/storages', label: '雲端設定', icon: 'cloud' },
  { to: '/logs', label: '歸檔紀錄', icon: 'history' },
  { to: '/users', label: '成員與權限', icon: 'users', admin: true },
  { to: '/settings', label: '系統設定', icon: 'settings', admin: true },
];
const BOTTOM: NavItem[] = [
  { to: '/', label: '總覽', icon: 'home' },
  { to: '/files', label: '檔案', icon: 'files' },
  { to: '/ask', label: '問 AI', icon: 'ai' },
  { to: '/rules', label: '規則', icon: 'rules' },
  { to: '/more', label: '更多', icon: 'more' },
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
  return (
    <>
      <div className="page-head">
        <div>
          <h1>系統管理</h1>
          <p>{me?.email}</p>
        </div>
      </div>
      <div className="card menu-list">
        {SYSTEM.filter((n) => !n.admin || me?.role === 'admin').map((n) => (
          <Link key={n.to} to={n.to}>
            <Icon name={n.icon} />
            {n.label}
          </Link>
        ))}
      </div>
    </>
  );
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
  const [simulate, setSimulate] = useState(false);
  useEffect(() => {
    api<Me>('/me')
      .then(setMe)
      .catch((e: Error) => setMeError(e.message));
  }, []);

  const active = (to: string) => (to === '/' ? path === '/' : path.startsWith(to));
  let page;
  if (path.startsWith('/files')) page = <Files />;
  else if (path.startsWith('/ask')) page = <Ask />;
  else if (path.startsWith('/folders')) page = <Folders />;
  else if (path.startsWith('/rules')) page = <Rules />;
  else if (path.startsWith('/groups')) page = <Groups />;
  else if (path.startsWith('/labels')) page = <Labels />;
  else if (path.startsWith('/storages')) page = <Storages />;
  else if (path.startsWith('/users')) page = <Users />;
  else if (path.startsWith('/logs')) page = <Logs />;
  else if (path.startsWith('/settings')) page = <SettingsPage />;
  else if (path.startsWith('/more')) page = <More me={me} />;
  else page = <Dashboard onSimulate={me?.demo && window.__grabitDemo ? () => setSimulate(true) : undefined} />;

  const navLink = (n: NavItem) => (
    <Link key={n.to} to={n.to} className={active(n.to) ? 'active' : ''}>
      <Icon name={n.icon} />
      {n.label}
    </Link>
  );

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
          <div className="section">系統管理</div>
          {SYSTEM.filter((n) => !n.admin || me?.role === 'admin').map(navLink)}
          {me && (
            <div className="foot">
              {me.name ?? me.email}
              <br />
              {{ admin: '管理員', editor: '編輯者', viewer: '檢視者' }[me.role]}
            </div>
          )}
        </nav>
        <main className="main">
          {meError ? <div className="notice danger">{meError}</div> : page}
        </main>
        <nav className="bottom-nav" aria-label="主選單">
          {BOTTOM.map((n) => (
            <Link key={n.to} to={n.to} className={active(n.to) || (n.to === '/more' && SYSTEM.some((s) => s.to !== '/rules' && active(s.to))) ? 'active' : ''}>
              <Icon name={n.icon} />
              {n.label}
            </Link>
          ))}
        </nav>
      </div>
      {simulate && window.__grabitDemo && <Simulator onClose={() => setSimulate(false)} />}
    </MeCtx.Provider>
  );
}
