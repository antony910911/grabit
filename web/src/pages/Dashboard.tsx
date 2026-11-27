import { useState } from 'react';
import { api, type Stats } from '../api';
import { Brand, Empty, ErrorBox, FileIcon, Icon, Loading, StatusBadge } from '../components';
import { FileSheet } from '../FileSheet';
import { formatBytes, formatTime, Link, useLoad, useMe } from '../lib';

export function Dashboard({ onSimulate }: { onSimulate?: () => void }) {
  const me = useMe();
  const { data, error, loading, reload } = useLoad(() => api<Stats>('/stats'), []);
  const [openId, setOpenId] = useState<number | null>(null);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            <Brand />
          </h1>
          <p>多群組檔案集中管理</p>
        </div>
        <div className="row">
          {onSimulate && (
            <button className="btn sm primary" onClick={onSimulate}>
              <Icon name="line" />
              模擬群組傳檔
            </button>
          )}
          <button className="btn sm" onClick={reload}>
            重新整理
          </button>
        </div>
      </div>
      {error && <ErrorBox message={error} onRetry={reload} />}
      {loading && !data && <Loading />}
      {data && (
        <>
          {!data.hasStorage && me?.role === 'admin' && (
            <div className="notice warn">
              <div>
                還沒有設定雲端空間，收到的檔案無法上傳。<Link to="/storages">前往雲端設定</Link>
              </div>
            </div>
          )}
          {data.hasStorage && !data.storagesReady && (
            <div className="notice warn">
              <div>
                雲端空間尚未授權。<Link to="/storages">前往授權</Link>
              </div>
            </div>
          )}
          {data.unconfiguredGroups > 0 && (
            <div className="notice info">
              <div>
                有 {data.unconfiguredGroups} 個新群組待設定（目前先存到待分類）。<Link to="/groups">前往設定</Link>
              </div>
            </div>
          )}
          {data.failed > 0 && (
            <div className="notice danger">
              <div>
                有 {data.failed} 個檔案處理失敗。<Link to="/files?status=failed">查看並重試</Link>
              </div>
            </div>
          )}
          {data.suggestions > 0 && (
            <div className="notice info">
              <div>
                系統從你的手動整理學到 {data.suggestions} 條規則建議。<Link to="/rules">看看要不要採用</Link>
              </div>
            </div>
          )}
          <div className="stats">
            <div className="card stat">
              <Link to="/files">
                <div className="label">總檔案數</div>
                <div className="value">{data.archived.toLocaleString()}</div>
              </Link>
              <div className="muted small">{data.duplicates ? `略過 ${data.duplicates} 個重複檔` : '已歸檔'}</div>
            </div>
            <div className="card stat">
              <Link to="/groups">
                <div className="label">連接群組</div>
                <div className="value">{data.groups}</div>
              </Link>
              <div className="muted small">{data.pending ? `${data.pending} 個處理中` : '運作中'}</div>
            </div>
            <div className="card stat">
              <Link to="/storages">
                <div className="label">儲存容量</div>
                <div className="value">{formatBytes(data.bytes)}</div>
              </Link>
              <div className="muted small">已歸檔檔案合計</div>
            </div>
            <div className="card stat">
              <Link to="/files?status=unsorted">
                <div className="label">待分類</div>
                <div className="value" style={{ color: data.unsorted ? 'var(--warn)' : undefined }}>
                  {data.unsorted}
                </div>
              </Link>
              <div className="muted small">
                自動分類 {data.autoRate == null ? '—' : `${Math.round(data.autoRate * 100)}%`}
                {data.byAi ? ` · AI ${data.byAi}` : ''}
              </div>
            </div>
          </div>
          <div className="card">
            <div className="card-head">
              <h2>最近收到</h2>
              <Link to="/files">全部檔案</Link>
            </div>
            {data.recent.length === 0 ? (
              <Empty title="還沒有檔案">把 GrabIt Bot 加進 LINE 群組，群組裡有人傳檔案就會出現在這裡。</Empty>
            ) : (
              <ul className="list">
                {data.recent.map((f) => (
                  <li key={f.id}>
                    <button className="item" onClick={() => setOpenId(f.id)}>
                      <FileIcon ext={f.ext} type={f.message_type} />
                      <div className="grow">
                        <div className="title">{f.stored_name ?? f.original_name}</div>
                        <div className="meta">
                          {f.group_name} · {f.status === 'failed' ? '處理失敗' : f.folder_path ?? '處理中'} · {formatTime(f.received_at)}
                        </div>
                      </div>
                      <StatusBadge file={f} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
      {openId != null && <FileSheet id={openId} folders={[]} onClose={() => setOpenId(null)} onChanged={reload} />}
    </>
  );
}
