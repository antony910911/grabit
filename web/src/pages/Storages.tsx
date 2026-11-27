import { useEffect, useMemo, useState } from 'react';
import { api, type Storage } from '../api';
import { Empty, ErrorBox, Icon, Loading, Sheet } from '../components';
import { ask, currentUrl, formatBytes, replaceUrl, useLoad, useMe, useToast } from '../lib';

const LOGO: Record<string, [string, string]> = {
  gdrive: ['#1a73e8', 'G'],
  onedrive: ['#0364b8', 'OD'],
  dropbox: ['#0061fe', 'DB'],
  webdav: ['#5b6472', 'NAS'],
  demo: ['#6a4a97', 'DEMO'],
};

interface Resp {
  items: Storage[];
  types: { type: Storage['type']; label: string; configured: boolean }[];
  redirectBase: string;
}

export function Storages() {
  const toast = useToast();
  const me = useMe();
  const admin = me?.role === 'admin';
  const { data, error, loading, reload } = useLoad(() => api<Resp>('/storages'), []);
  const [adding, setAdding] = useState(false);
  const [edit, setEdit] = useState<Storage | null>(null);
  const flash = useMemo(() => currentUrl().searchParams, []);

  useEffect(() => {
    if (flash.get('connected')) toast('雲端空間連接成功');
    if (flash.get('error')) toast(`連接失敗：${flash.get('error')}`, 'error');
    if (flash.toString()) replaceUrl('/storages');
  }, [flash, toast]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>雲端設定</h1>
          <p>可以同時連接多個雲端空間，每個群組指定要存到哪一個</p>
        </div>
        {admin && (
          <button className="btn sm primary" onClick={() => setAdding(true)}>
            <Icon name="plus" />
            新增空間
          </button>
        )}
      </div>
      {error && <ErrorBox message={error} onRetry={reload} />}
      {loading && !data ? (
        <Loading />
      ) : !data?.items.length ? (
        <div className="card">
          <Empty title="還沒有雲端空間">新增一個空間後，收到的檔案才能自動上傳。</Empty>
        </div>
      ) : (
        <div className="stack">
          {data.items.map((s) => (
            <div key={s.id} className="card storage-card">
              <div className="storage-logo" style={{ background: LOGO[s.type]?.[0] }}>
                {LOGO[s.type]?.[1]}
              </div>
              <div className="grow">
                <div className="row" style={{ gap: 6 }}>
                  <strong>{s.name}</strong>
                  <span className="badge muted">{s.typeLabel}</span>
                  {s.is_default ? <span className="badge info">預設</span> : null}
                  {s.ready ? <span className="badge ok">已連接</span> : <span className="badge warn">尚未授權</span>}
                </div>
                <div className="muted small" style={{ marginTop: 4 }}>
                  {s.account ?? s.config.url ?? ''} · 根目錄「{s.root_folder}」 · {s.files} 個檔案 · {formatBytes(s.bytes)}
                </div>
              </div>
              {admin && (
                <div className="row">
                  {s.type !== 'webdav' && s.type !== 'demo' && (
                    <a className="btn sm" href={`/oauth/${s.type}/start?storage=${s.id}`}>
                      {s.ready ? '重新授權' : '授權連接'}
                    </a>
                  )}
                  <button className="btn sm" onClick={() => setEdit(s)}>
                    設定
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="muted small" style={{ marginTop: 14 }}>
        iCloud Drive 沒有提供伺服器可以使用的上傳 API，所以不支援直接串接；如果一定要用 iCloud，可以讓一台常開的 Mac 同步 Google Drive 或 NAS 的資料夾。
      </p>
      {adding && data && <AddStorage types={data.types} redirectBase={data.redirectBase} onClose={() => setAdding(false)} onDone={reload} />}
      {edit && (
        <EditStorage
          storage={edit}
          onClose={() => setEdit(null)}
          onDone={() => {
            setEdit(null);
            reload();
          }}
        />
      )}
    </>
  );
}

function AddStorage({ types, redirectBase, onClose, onDone }: { types: Resp['types']; redirectBase: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [type, setType] = useState<Storage['type']>('gdrive');
  const [name, setName] = useState('');
  const [root, setRoot] = useState('GrabIt');
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const t = types.find((x) => x.type === type);

  const create = async () => {
    setBusy(true);
    try {
      const r = await api<{ id: number; authorizeUrl: string | null }>('/storages', { method: 'POST', json: { type, name, root_folder: root, url, username, password } });
      if (r.authorizeUrl) {
        location.href = r.authorizeUrl;
        return;
      }
      toast('已新增');
      onDone();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      title="新增雲端空間"
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy || (t && !t.configured) || (type === 'webdav' && !url)} onClick={create}>
            {type === 'webdav' ? '新增' : '新增並前往授權'}
          </button>
        </>
      }
    >
      <div className="checks" style={{ gridTemplateColumns: 'repeat(2, 1fr)', marginBottom: 14 }}>
        {types.map((x) => (
          <button key={x.type} type="button" className={`btn ${type === x.type ? 'primary' : ''}`} onClick={() => setType(x.type)} style={{ height: 48 }}>
            {x.label}
          </button>
        ))}
      </div>
      {t && !t.configured && (
        <div className="notice warn">
          伺服器還沒有設定 {t.label} 的 OAuth 用戶端。請依 README 建立應用程式，重新導向網址填：
          <br />
          <code>{`${redirectBase}/oauth/${type}/callback`}</code>
        </div>
      )}
      <label className="field">
        <span>顯示名稱</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={type === 'onedrive' ? '例：公司 OneDrive' : type === 'webdav' ? '例：實驗室 NAS' : '例：個人 Google Drive'} />
      </label>
      <label className="field">
        <span>根目錄名稱</span>
        <input className="input" value={root} onChange={(e) => setRoot(e.target.value)} />
        <small>所有檔案都會放在這個資料夾底下</small>
      </label>
      {type === 'webdav' && (
        <>
          <label className="field">
            <span>WebDAV 網址</span>
            <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://nas.example.com:5006/home" />
            <small>Synology：套件中心安裝 WebDAV Server，開啟 HTTPS；QNAP、Nextcloud 也支援</small>
          </label>
          <label className="field">
            <span>帳號</span>
            <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
          </label>
          <label className="field">
            <span>密碼</span>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            <small>建議在 NAS 建立一個只能寫入這個資料夾的專用帳號</small>
          </label>
        </>
      )}
    </Sheet>
  );
}

function EditStorage({ storage, onClose, onDone }: { storage: Storage; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(storage.name);
  const [root, setRoot] = useState(storage.root_folder);
  const [password, setPassword] = useState('');
  const save = async (extra: Record<string, unknown> = {}) => {
    try {
      await api(`/storages/${storage.id}`, { method: 'PATCH', json: { name, root_folder: root, ...(password ? { password } : {}), ...extra } });
      toast('已儲存');
      onDone();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const remove = async () => {
    if (!(await ask(`移除「${storage.name}」？雲端上的檔案不會被刪除。`))) return;
    try {
      await api(`/storages/${storage.id}`, { method: 'DELETE' });
      onDone();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <Sheet
      title={`設定：${storage.name}`}
      onClose={onClose}
      actions={
        <>
          <button className="btn danger" style={{ marginRight: 'auto' }} onClick={remove}>
            移除
          </button>
          {!storage.is_default && (
            <button className="btn" onClick={() => save({ is_default: true })}>
              設為預設
            </button>
          )}
          <button className="btn primary" onClick={() => save()}>
            儲存
          </button>
        </>
      }
    >
      <label className="field">
        <span>顯示名稱</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span>根目錄名稱</span>
        <input className="input" value={root} onChange={(e) => setRoot(e.target.value)} />
        <small>只影響之後的新檔案，已歸檔的檔案不會移動</small>
      </label>
      {storage.type === 'webdav' && (
        <label className="field">
          <span>更新密碼</span>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="留空 = 不變" autoComplete="new-password" />
        </label>
      )}
    </Sheet>
  );
}
