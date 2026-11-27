// 設定（只有管理員）：一般、雲端空間、成員與權限 合在同一頁，用分頁切換
import { useState } from 'react';
import { currentUrl, replaceUrl } from '../lib';
import { SettingsPage } from './Settings';
import { Storages } from './Storages';
import { Users } from './Users';
import { PermissionTable } from './Account';

type Tab = 'general' | 'storages' | 'members';
const TABS: { key: Tab; label: string }[] = [
  { key: 'general', label: '一般' },
  { key: 'storages', label: '雲端空間' },
  { key: 'members', label: '成員與權限' },
];

function initialTab(): Tab {
  const u = currentUrl();
  if (u.pathname.startsWith('/storages')) return 'storages';
  if (u.pathname.startsWith('/users')) return 'members';
  const t = u.searchParams.get('tab');
  return t === 'storages' || t === 'members' ? t : 'general';
}

export function AdminSettings() {
  const [tab, setTab] = useState<Tab>(initialTab);
  const pick = (t: Tab) => {
    setTab(t);
    replaceUrl(`/settings?tab=${t}`);
  };
  return (
    <>
      <div className="page-head">
        <div>
          <h1>設定</h1>
          <p>只有管理員看得到這一頁</p>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} className={`tab ${tab === t.key ? 'active' : ''}`} onClick={() => pick(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="embedded">
        {tab === 'general' && <SettingsPage />}
        {tab === 'storages' && <Storages />}
        {tab === 'members' && (
          <>
            <Users />
            <section className="card card-pad" style={{ marginTop: 14 }}>
              <h2>各角色可以做的事</h2>
              <p className="muted small" style={{ margin: '4px 0 12px' }}>
                檢視者與編輯者只看得到被授權的群組；在「群組」的設定裡可以指定每個群組給哪些成員看。
              </p>
              <PermissionTable />
            </section>
          </>
        )}
      </div>
    </>
  );
}
