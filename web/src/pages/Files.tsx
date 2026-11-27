import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type FileItem, type Group, type Stats } from '../api';
import { ErrorBox, FileIcon, FolderInput, Icon, Loading, Sheet, StatusBadge } from '../components';
import { formatBytes, formatTime, navigate, useLoad, useToast } from '../lib';

const TABS = [
  { key: 'all', label: '全部' },
  { key: 'unsorted', label: '待分類', count: 'unsorted' },
  { key: 'sorted', label: '已歸檔' },
  { key: 'pending', label: '處理中', count: 'pending' },
  { key: 'failed', label: '失敗', count: 'failed' },
  { key: 'duplicate', label: '重複' },
] as const;

function readQuery() {
  const p = new URLSearchParams(location.search);
  return { status: p.get('status') ?? 'all', open: p.get('open') ? Number(p.get('open')) : null, group: p.get('group') ?? '' };
}

export function Files() {
  const toast = useToast();
  const initial = useMemo(readQuery, []);
  const [status, setStatus] = useState(initial.status);
  const [group, setGroup] = useState(initial.group);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<FileItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [openId, setOpenId] = useState<number | null>(initial.open);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [batchMove, setBatchMove] = useState(false);

  const stats = useLoad(() => api<Stats>('/stats'), [tick]);
  const groups = useLoad(() => api<{ items: Group[] }>('/groups'), []);
  const folders = useLoad(() => api<{ items: { path: string }[] }>('/folders'), [tick]);
  const folderList = folders.data?.items.map((f) => f.path) ?? [];

  // 搜尋輸入延遲 300ms 再查詢
  useEffect(() => {
    const t = setTimeout(() => setQuery(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  // 同步網址，重新整理或分享連結時保留篩選
  useEffect(() => {
    const p = new URLSearchParams();
    if (status !== 'all') p.set('status', status);
    if (group) p.set('group', group);
    if (openId) p.set('open', String(openId));
    const s = p.toString();
    history.replaceState(null, '', `/files${s ? `?${s}` : ''}`);
  }, [status, group, openId]);

  const load = async (offset: number) => {
    setLoading(true);
    try {
      const p = new URLSearchParams({ status, q: query, group, offset: String(offset), limit: '50' });
      const r = await api<{ items: FileItem[]; hasMore: boolean }>(`/files?${p}`);
      setItems((prev) => (offset ? [...prev, ...r.items] : r.items));
      setHasMore(r.hasMore);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(0);
    setSelected(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, query, group, tick]);

  const refresh = () => setTick((t) => t + 1);

  const toggle = (id: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  // 長按進入多選（手機）
  const pressTimer = useRef<number | null>(null);
  const startPress = (id: number) => {
    pressTimer.current = window.setTimeout(() => {
      setSelecting(true);
      setSelected(new Set([id]));
      pressTimer.current = null;
      navigator.vibrate?.(15);
    }, 500);
  };
  const cancelPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };

  const selectedDone = items.filter((f) => selected.has(f.id) && f.status === 'done');

  const batchDelete = async () => {
    const targets = items.filter((f) => selected.has(f.id));
    if (!confirm(`確定要刪除 ${targets.length} 個檔案？雲端上的檔案會移到 Google Drive 垃圾桶（30 天內可救回）。`)) return;
    let ok = 0;
    for (const f of targets) {
      try {
        await api(`/files/${f.id}`, { method: 'DELETE' });
        ok++;
      } catch (e) {
        toast(`${f.stored_name ?? f.original_name}：${(e as Error).message}`, 'error');
      }
    }
    toast(`已刪除 ${ok} 個檔案`);
    setSelecting(false);
    refresh();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>檔案</h1>
          <p>從 LINE 群組收到的所有檔案</p>
        </div>
        <div className="row">
          <button
            className="btn sm"
            onClick={() => {
              setSelecting((v) => !v);
              setSelected(new Set());
            }}
          >
            {selecting ? '取消選取' : '選取'}
          </button>
        </div>
      </div>

      <div className="tabs" role="tablist">
        {TABS.map((t) => {
          const n = 'count' in t && stats.data ? stats.data[t.count] : 0;
          return (
            <button key={t.key} role="tab" aria-selected={status === t.key} className={`tab ${status === t.key ? 'active' : ''}`} onClick={() => setStatus(t.key)}>
              {t.label}
              {n > 0 && <span className="n">{n}</span>}
            </button>
          );
        })}
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        <div className="grow" style={{ position: 'relative', minWidth: 200 }}>
          <input className="input" type="search" placeholder="搜尋檔名、資料夾或上傳者…" value={q} onChange={(e) => setQ(e.target.value)} style={{ paddingLeft: 36 }} />
          <span style={{ position: 'absolute', left: 11, top: 11, width: 18, height: 18, color: 'var(--muted)' }}>
            <Icon name="search" />
          </span>
        </div>
        <select className="select" style={{ width: 'auto', maxWidth: '100%' }} value={group} onChange={(e) => setGroup(e.target.value)} aria-label="篩選群組">
          <option value="">所有群組</option>
          {groups.data?.items.map((g) => (
            <option key={g.id} value={g.id}>
              {g.alias || g.name || g.id.slice(0, 10)}
            </option>
          ))}
        </select>
      </div>

      {selecting && (
        <div className="selectbar">
          <span className="grow">已選 {selected.size} 個</span>
          <button className="btn sm" disabled={!selectedDone.length} onClick={() => setBatchMove(true)}>
            移動到…
          </button>
          <button className="btn sm" disabled={!selected.size} onClick={batchDelete}>
            刪除
          </button>
        </div>
      )}

      {error && <ErrorBox message={error} onRetry={refresh} />}

      <div className="card">
        {loading && !items.length ? (
          <Loading />
        ) : items.length === 0 ? (
          <div className="empty">
            <h3>{query ? '找不到符合的檔案' : status === 'unsorted' ? '沒有待分類的檔案' : '這裡還沒有檔案'}</h3>
            {status === 'unsorted' && '所有檔案都有對應的分類規則。'}
          </div>
        ) : (
          <ul className="list">
            {items.map((f) => (
              <li key={f.id}>
                <div
                  className="item"
                  role="button"
                  tabIndex={0}
                  onClick={() => (selecting ? toggle(f.id) : setOpenId(f.id))}
                  onKeyDown={(e) => e.key === 'Enter' && (selecting ? toggle(f.id) : setOpenId(f.id))}
                  onTouchStart={() => !selecting && startPress(f.id)}
                  onTouchEnd={cancelPress}
                  onTouchMove={cancelPress}
                  onContextMenu={(e) => selecting && e.preventDefault()}
                >
                  {selecting && <input type="checkbox" className="cb" checked={selected.has(f.id)} onChange={() => toggle(f.id)} onClick={(e) => e.stopPropagation()} aria-label="選取" />}
                  <FileIcon ext={f.ext} type={f.message_type} />
                  <div className="grow">
                    <div className="title">{f.stored_name ?? f.original_name}</div>
                    <div className="meta">
                      {f.group_name} · {f.status === 'failed' ? f.error : f.folder_path ?? '等待處理'} · {formatTime(f.received_at)}
                    </div>
                  </div>
                  <StatusBadge file={f} />
                </div>
              </li>
            ))}
          </ul>
        )}
        {hasMore && (
          <div style={{ padding: 12, textAlign: 'center', borderTop: '1px solid var(--border)' }}>
            <button className="btn sm" disabled={loading} onClick={() => load(items.length)}>
              {loading ? '載入中…' : '載入更多'}
            </button>
          </div>
        )}
      </div>

      {openId != null && (
        <FileDetail
          id={openId}
          folders={folderList}
          onClose={() => setOpenId(null)}
          onChanged={() => {
            refresh();
          }}
        />
      )}

      {batchMove && (
        <BatchMove
          files={selectedDone}
          folders={folderList}
          onClose={() => setBatchMove(false)}
          onDone={() => {
            setBatchMove(false);
            setSelecting(false);
            refresh();
          }}
        />
      )}
    </>
  );
}

function FileDetail({ id, folders, onClose, onChanged }: { id: number; folders: string[]; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const { data: f, error, loading, reload } = useLoad(() => api<FileItem>(`/files/${id}`), [id]);
  const [editing, setEditing] = useState(false);
  const [folder, setFolder] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (f) {
      setFolder(f.folder_path ?? '');
      setName(f.stored_name ?? f.original_name);
    }
  }, [f]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      const r = await api<{ folderPath: string; storedName: string }>(`/files/${id}`, { method: 'PATCH', json: { folderPath: folder, storedName: name } });
      toast(`已移到 ${r.folderPath}/${r.storedName}`);
      setEditing(false);
      reload();
      onChanged();
    });

  const retry = () =>
    run(async () => {
      await api(`/files/${id}/retry`, { method: 'POST' });
      toast('已重新排入處理');
      reload();
      onChanged();
    });

  const remove = () =>
    run(async () => {
      if (!confirm('確定要刪除這個檔案？雲端上的檔案會移到 Google Drive 垃圾桶（30 天內可救回）。')) return;
      await api(`/files/${id}`, { method: 'DELETE' });
      toast('已刪除');
      onChanged();
      onClose();
    });

  return (
    <Sheet title={editing ? '移動或改名' : '檔案資訊'} onClose={onClose}>
      {loading && !f && <Loading />}
      {error && <ErrorBox message={error} />}
      {f && !editing && (
        <>
          <div className="row" style={{ marginBottom: 14, flexWrap: 'nowrap' }}>
            <FileIcon ext={f.ext} type={f.message_type} />
            <div className="grow">
              <div className="path">{f.stored_name ?? f.original_name}</div>
              <StatusBadge file={f} />
            </div>
          </div>
          <dl className="kv">
            <dt>資料夾</dt>
            <dd>{f.folder_path ?? '—'}</dd>
            <dt>群組</dt>
            <dd>{f.group_name}</dd>
            <dt>上傳者</dt>
            <dd>{f.sender_name ?? '—'}</dd>
            <dt>收到時間</dt>
            <dd>{formatTime(f.received_at)}</dd>
            <dt>大小</dt>
            <dd>{formatBytes(f.size)}</dd>
            {f.stored_name && f.original_name !== f.stored_name && (
              <>
                <dt>原檔名</dt>
                <dd>{f.original_name}</dd>
              </>
            )}
            <dt>分類依據</dt>
            <dd>{f.manual ? '手動調整' : f.rule_name ? `規則「${f.rule_name}」` : f.status === 'done' ? '沒有符合的規則' : '—'}</dd>
            {f.status === 'duplicate' && (
              <>
                <dt>重複</dt>
                <dd>
                  與檔案 #{f.duplicate_of} 內容相同，已略過不重複儲存
                </dd>
              </>
            )}
            {f.error && (
              <>
                <dt>錯誤</dt>
                <dd style={{ color: 'var(--danger)' }}>{f.error}</dd>
              </>
            )}
          </dl>
          <div className="sheet-actions">
            {(f.status === 'failed' || f.status === 'pending') && (
              <button className="btn" disabled={busy} onClick={retry}>
                <Icon name="refresh" />
                重試
              </button>
            )}
            {f.status !== 'deleted' && (
              <button className="btn danger" disabled={busy} onClick={remove}>
                刪除
              </button>
            )}
            {f.status === 'duplicate' && f.duplicate_of && (
              <button className="btn" onClick={() => navigate(`/files?open=${f.duplicate_of}`)}>
                查看原檔
              </button>
            )}
            {f.status === 'done' && (
              <button className="btn" onClick={() => setEditing(true)}>
                移動／改名
              </button>
            )}
            {f.drive_link && f.status === 'done' && (
              <a className="btn primary" href={f.drive_link} target="_blank" rel="noreferrer">
                <Icon name="external" />
                在 Google Drive 開啟
              </a>
            )}
          </div>
        </>
      )}
      {f && editing && (
        <>
          <label className="field">
            <span>資料夾</span>
            <FolderInput value={folder} onChange={setFolder} folders={folders} autoFocus />
            <small>用 / 分隔層級，不存在的資料夾會自動建立</small>
          </label>
          <label className="field">
            <span>檔名</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="sheet-actions">
            <button className="btn" onClick={() => setEditing(false)}>
              取消
            </button>
            <button className="btn primary" disabled={busy || !folder.trim() || !name.trim()} onClick={save}>
              {busy ? '處理中…' : '儲存'}
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}

function BatchMove({ files, folders, onClose, onDone }: { files: FileItem[]; folders: string[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const go = async () => {
    setBusy(true);
    let ok = 0;
    for (const f of files) {
      try {
        await api(`/files/${f.id}`, { method: 'PATCH', json: { folderPath: folder } });
        ok++;
      } catch (e) {
        toast(`${f.stored_name}：${(e as Error).message}`, 'error');
      }
      setProgress((p) => p + 1);
    }
    toast(`已移動 ${ok} 個檔案到 ${folder}`);
    onDone();
  };
  return (
    <Sheet
      title={`移動 ${files.length} 個檔案`}
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn primary" disabled={busy || !folder.trim()} onClick={go}>
            {busy ? `移動中 ${progress}/${files.length}` : '移動'}
          </button>
        </>
      }
    >
      <label className="field">
        <span>目標資料夾</span>
        <FolderInput value={folder} onChange={setFolder} folders={folders} autoFocus />
        <small>只會移動已歸檔的檔案；手動移動過的檔案之後不會被規則自動搬走</small>
      </label>
    </Sheet>
  );
}
