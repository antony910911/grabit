import { useEffect, useState } from 'react';
import { api } from './api';
import { Icon } from './components';
import { Link, usePath } from './lib';
import { Dashboard } from './pages/Dashboard';
import { Files } from './pages/Files';
import { Rules } from './pages/Rules';
import { Groups } from './pages/Groups';
import { SettingsPage } from './pages/Settings';
import { Logs } from './pages/Logs';

const NAV = [
  { to: '/', label: '總覽', icon: 'home' },
  { to: '/files', label: '檔案', icon: 'files' },
  { to: '/rules', label: '分類規則', short: '規則', icon: 'rules' },
  { to: '/groups', label: '群組', icon: 'groups' },
  { to: '/settings', label: '設定', icon: 'settings' },
  { to: '/logs', label: '處理紀錄', icon: 'logs', desktopOnly: true },
];

export function App() {
  const path = usePath();
  const [email, setEmail] = useState('');
  useEffect(() => {
    api<{ email: string }>('/me').then((r) => setEmail(r.email)).catch(() => {});
  }, []);

  const active = (to: string) => (to === '/' ? path === '/' : path.startsWith(to));
  let page;
  if (path.startsWith('/files')) page = <Files />;
  else if (path.startsWith('/rules')) page = <Rules />;
  else if (path.startsWith('/groups')) page = <Groups />;
  else if (path.startsWith('/settings')) page = <SettingsPage />;
  else if (path.startsWith('/logs')) page = <Logs />;
  else page = <Dashboard />;

  return (
    <div className="app">
      <nav className="sidebar" aria-label="主選單">
        <div className="brand">
          <img src="/icon.svg" alt="" />
          FileHub
        </div>
        {NAV.map((n) => (
          <Link key={n.to} to={n.to} className={active(n.to) ? 'active' : ''}>
            <Icon name={n.icon} />
            {n.label}
          </Link>
        ))}
        {email && <div className="foot">{email}</div>}
      </nav>
      <main className="main">{page}</main>
      <nav className="bottom-nav" aria-label="主選單">
        {NAV.filter((n) => !n.desktopOnly).map((n) => (
          <Link key={n.to} to={n.to} className={active(n.to) || (n.to === '/settings' && path.startsWith('/logs')) ? 'active' : ''}>
            <Icon name={n.icon} />
            {n.short ?? n.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
