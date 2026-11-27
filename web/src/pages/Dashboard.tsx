import { api, type Stats } from '../api';
import { ErrorBox, FileIcon, Loading, StatusBadge } from '../components';
import { formatBytes, formatTime, Link, useLoad } from '../lib';

export function Dashboard() {
  const { data, error, loading, reload } = useLoad(() => api<Stats>('/stats'), []);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>FileHub</h1>
          <p>LINE 群組檔案自動歸檔</p>
        </div>
        <button className="btn sm" onClick={reload}>
          重新整理
        </button>
      </div>
      {error && <ErrorBox message={error} onRetry={reload} />}
      {loading && !data && <Loading />}
      {data && (
        <>
          {!data.driveConnected && (
            <div className="notice warn">
              <div>
                還沒連接 Google Drive，收到的檔案會停在「處理中」。<Link to="/settings">前往設定</Link>
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
          <div className="stats">
            <div className="card stat">
              <div className="label">累計歸檔</div>
              <div className="value">{data.archived.toLocaleString()}</div>
              <div className="muted small">{formatBytes(data.bytes)}</div>
            </div>
            <div className="card stat">
              <Link to="/groups">
                <div className="label">連接群組</div>
                <div className="value">{data.groups}</div>
              </Link>
              <div className="muted small">{data.pending ? `${data.pending} 個處理中` : '運作中'}</div>
            </div>
            <div className="card stat">
              <Link to="/files?status=unsorted">
                <div className="label">待分類</div>
                <div className="value" style={{ color: data.unsorted ? 'var(--warn)' : undefined }}>
                  {data.unsorted}
                </div>
              </Link>
              <div className="muted small">沒有規則符合</div>
            </div>
            <div className="card stat">
              <div className="label">自動分類率</div>
              <div className="value">{data.autoRate == null ? '—' : `${(data.autoRate * 100).toFixed(1)}%`}</div>
              <div className="muted small">{data.duplicates ? `略過 ${data.duplicates} 個重複檔` : '依規則自動歸檔'}</div>
            </div>
          </div>
          <div className="card">
            <div className="card-head">
              <h2>最近收到</h2>
              <Link to="/files">全部檔案</Link>
            </div>
            {data.recent.length === 0 ? (
              <div className="empty">
                <h3>還沒有檔案</h3>
                把 LINE Bot 加進群組，群組裡有人傳檔案就會出現在這裡。
              </div>
            ) : (
              <ul className="list">
                {data.recent.map((f) => {
                  const name = f.stored_name ?? f.original_name;
                  const ext = name.includes('.') ? name.split('.').pop()! : '';
                  return (
                    <li key={f.id}>
                      <Link to={`/files?open=${f.id}`} className="item">
                        <FileIcon ext={ext} />
                        <div className="grow">
                          <div className="title">{name}</div>
                          <div className="meta">
                            {f.group_name} · {f.folder_path ?? '—'} · {formatTime(f.received_at)}
                          </div>
                        </div>
                        <StatusBadge file={f} />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </>
  );
}
