import { useState } from 'react';
import { api } from '../api';
import { Empty, ErrorBox, Icon, Loading } from '../components';
import { canEdit, formatTime, Link, useLoad, useMe, useToast } from '../lib';

interface LogRow {
  id: number;
  level: 'info' | 'warn' | 'error';
  action: string;
  file_id: number | null;
  message: string;
  created_at: string;
}

interface Op {
  batch_id: string;
  description: string;
  user_email: string;
  count: number;
  created_at: string;
  undone: number;
}

const LEVEL = { info: ['ok', '紀錄'], warn: ['warn', '警告'], error: ['danger', '錯誤'] } as const;

export function Logs() {
  const toast = useToast();
  const me = useMe();
  const [tab, setTab] = useState<'logs' | 'ops'>('logs');
  const [level, setLevel] = useState('');
  const logs = useLoad(() => api<{ items: LogRow[] }>(`/logs${level ? `?level=${level}` : ''}`), [level]);
  const ops = useLoad(() => (tab === 'ops' ? api<{ items: Op[] }>('/operations') : Promise.resolve({ items: [] as Op[] })), [tab]);

  const undo = async (op: Op) => {
    if (!confirm(`復原「${op.description}」？`)) return;
    try {
      const r = await api<{ undone: number; errors: string[] }>(`/operations/${op.batch_id}/undo`, { method: 'POST', json: {} });
      toast(r.errors.length ? `復原 ${r.undone} 個，${r.errors.length} 個失敗：${r.errors[0]}` : `已復原 ${r.undone} 個操作`, r.errors.length ? 'error' : 'ok');
      ops.reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>歸檔紀錄</h1>
          <p>歸檔歷史、失敗原因，以及可以復原的搬移操作</p>
        </div>
        <button className="btn sm" onClick={() => (tab === 'logs' ? logs.reload() : ops.reload())}>
          重新整理
        </button>
      </div>
      <div className="tabs">
        <button className={`tab ${tab === 'logs' ? 'active' : ''}`} onClick={() => setTab('logs')}>
          處理紀錄
        </button>
        {canEdit(me) && (
          <button className={`tab ${tab === 'ops' ? 'active' : ''}`} onClick={() => setTab('ops')}>
            搬移與復原
          </button>
        )}
        {tab === 'logs' &&
          [
            ['error', '只看錯誤'],
            ['warn', '只看警告'],
          ].map(([k, label]) => (
            <button key={k} className={`tab ${level === k ? 'active' : ''}`} onClick={() => setLevel(level === k ? '' : k!)}>
              {label}
            </button>
          ))}
      </div>
      {tab === 'logs' && (
        <>
          {logs.error && <ErrorBox message={logs.error} onRetry={logs.reload} />}
          <div className="card">
            {logs.loading && !logs.data ? (
              <Loading />
            ) : !logs.data?.items.length ? (
              <Empty title="沒有紀錄" />
            ) : (
              <ul className="list">
                {logs.data.items.map((l) => (
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
      )}
      {tab === 'ops' && (
        <div className="card">
          {ops.loading && !ops.data ? (
            <Loading />
          ) : !ops.data?.items.length ? (
            <Empty title="還沒有搬移紀錄">手動搬移、批次搬移、重新套用規則、資料夾改名都會記錄在這裡，可以一鍵復原。</Empty>
          ) : (
            <ul className="list">
              {ops.data.items.map((op) => (
                <li key={op.batch_id} className="rule-line">
                  <div className="grow">
                    <div className="title">{op.description}</div>
                    <div className="meta">
                      {op.user_email} · {formatTime(op.created_at)}
                      {op.count > 1 ? ` · ${op.count} 個檔案` : ''}
                    </div>
                  </div>
                  {op.undone ? (
                    <span className="badge muted">已復原</span>
                  ) : (
                    <button className="btn sm" onClick={() => undo(op)}>
                      <Icon name="undo" />
                      復原
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
