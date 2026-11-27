import { useState } from 'react';
import { api } from '../api';
import { ErrorBox, Loading } from '../components';
import { formatTime, Link, useLoad } from '../lib';

interface LogRow {
  id: number;
  level: 'info' | 'warn' | 'error';
  action: string;
  file_id: number | null;
  message: string;
  created_at: string;
}

const LEVEL = { info: ['ok', '紀錄'], warn: ['warn', '警告'], error: ['danger', '錯誤'] } as const;

export function Logs() {
  const [level, setLevel] = useState('');
  const { data, error, loading, reload } = useLoad(() => api<{ items: LogRow[] }>(`/logs${level ? `?level=${level}` : ''}`), [level]);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>處理紀錄</h1>
          <p>歸檔、失敗與手動操作的歷史</p>
        </div>
        <button className="btn sm" onClick={reload}>
          重新整理
        </button>
      </div>
      <div className="tabs">
        {[
          ['', '全部'],
          ['error', '錯誤'],
          ['warn', '警告'],
          ['info', '一般'],
        ].map(([k, label]) => (
          <button key={k} className={`tab ${level === k ? 'active' : ''}`} onClick={() => setLevel(k!)}>
            {label}
          </button>
        ))}
      </div>
      {error && <ErrorBox message={error} onRetry={reload} />}
      <div className="card">
        {loading && !data ? (
          <Loading />
        ) : !data?.items.length ? (
          <div className="empty">沒有紀錄</div>
        ) : (
          <ul className="list">
            {data.items.map((l) => (
              <li key={l.id} style={{ padding: '11px 16px' }}>
                <div className="row" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                  <span className={`badge ${LEVEL[l.level][0]}`}>{LEVEL[l.level][1]}</span>
                  <div className="grow" style={{ wordBreak: 'break-word' }}>
                    {l.message}
                    <div className="muted small">
                      {formatTime(l.created_at)}
                      {l.file_id ? (
                        <>
                          {' · '}
                          <Link to={`/files?open=${l.file_id}`}>查看檔案</Link>
                        </>
                      ) : null}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
