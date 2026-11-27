import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type FileItem, type Project, type Sources, type Stats, type Uploader } from '../api';
import { Empty, ErrorBox, FileIcon, FolderInput, Icon, Loading, ProjectBadge, Sheet, SourceIcon, StatusBadge, Switch, TagChip } from '../components';
import { FileSheet, useAfterMove } from '../FileSheet';
import { ask, canEdit, currentUrl, formatTime, replaceUrl, useLoad, useMe, useToast } from '../lib';

const TABS = [
  { key: 'all', label: '全部' },
  { key: 'unsorted', label: '待分類', count: 'unsorted' },
  { key: 'sorted', label: '已歸檔' },
  { key: 'ai_review', label: 'AI 待確認', count: 'aiReview' },
  { key: 'ai', label: 'AI 歸檔', count: 'byAi' },
  { key: 'pending', label: '處理中', count: 'pending' },
  { key: 'failed', label: '失敗', count: 'failed' },
  { key: 'duplicate', label: '重複', count: 'duplicates' },
  { key: 'skipped', label: '略過' },
] as const;

const TYPES: [string, string][] = [
  ['', '所有類型'],
  ['pdf', 'PDF'],
  ['document', '文件'],
  ['spreadsheet', '試算表'],
  ['presentation', '簡報'],
  ['image', '照片'],
  ['video', '影片'],
  ['audio', '錄音'],
  ['archive', '壓縮檔'],
];

interface Filters {
  status: string;
  group: string;
  project: string;
  tag: string;
  year: string;
  type: string;
  uploader: string;
  latest: boolean;
}

const EMPTY: Filters = { status: 'all', group: '', project: '', tag: '', year: '', type: '', uploader: '', latest: false };

function readQuery(): Filters & { open: number | null } {
  const p = currentUrl().searchParams;
  return {
    status: p.get('status') ?? 'all',
    group: p.get('group') ?? '',
    project: p.get('project') ?? '',
    tag: p.get('tag') ?? '',
    year: p.get('year') ?? '',
    type: p.get('type') ?? '',
    uploader: p.get('uploader') ?? '',
    latest: p.get('latest') === '1',
    open: p.get('open') ? Number(p.get('open')) : null,
  };
}

type UploaderList = { items: Uploader[]; unknown: number };
const SOURCE_LABEL: Record<string, string> = { line: 'LINE', email: 'Email', user: '手動上傳' };

function readPref(key: string, d: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v == null ? d : v === '1';
  } catch {
    return d;
  }
}

/** 上傳者清單：可以搜尋、釘選，依看得到的檔案數排序；同名的人會顯示來源與 ID 尾碼區分 */
function UploaderSection({ data, active, pick, onPin }: { data: UploaderList | null; active: string; pick: (key: string) => void; onPin: (u: Uploader) => void }) {
  const [open, setOpen] = useState(() => readPref('grabit-uploaders-open', true));
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  if (!data || (!data.items.length && !data.unknown)) return null;
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem('grabit-uploaders-open', open ? '0' : '1');
    } catch {
      // 隱私模式
    }
  };
  const names = new Map<string, number>();
  for (const u of data.items) names.set(u.name, (names.get(u.name) ?? 0) + 1);
  const kw = q.trim().toLowerCase();
  const list = data.items.filter((u) => !kw || u.name.toLowerCase().includes(kw) || (u.display_name ?? '').toLowerCase().includes(kw));
  const LIMIT = 8;
  const shown = kw || all ? list : list.slice(0, Math.max(LIMIT, data.items.filter((u) => u.pinned).length));
  return (
    <>
      <button className="src-head" onClick={toggle} aria-expanded={open}>
        <h4>上傳者</h4>
        <Icon name={open ? 'up' : 'down'} />
      </button>
      {open && (
        <>
          {data.items.length > LIMIT && <input className="input src-search" type="search" placeholder="搜尋上傳者" value={q} onChange={(e) => setQ(e.target.value)} aria-label="搜尋上傳者" />}
          {shown.map((u) => (
            <div key={u.key} className={`src src-row ${active === u.key ? 'active' : ''}`}>
              <button className="src-main" onClick={() => pick(active === u.key ? '' : u.key)}>
                <span className="src-name">
                  {u.name}
                  {(names.get(u.name) ?? 0) > 1 && (
                    <small>
                      {SOURCE_LABEL[u.source] ?? u.source}・…{u.key.slice(-4)}
                    </small>
                  )}
                </span>
              </button>
              <button className={`src-pin ${u.pinned ? 'on' : ''}`} onClick={() => onPin(u)} aria-label={u.pinned ? `取消釘選 ${u.name}` : `釘選 ${u.name}`} title={u.pinned ? '取消釘選' : '釘選到最上面'}>
                {u.pinned ? '★' : '☆'}
              </button>
              <span className="n">{u.count}</span>
            </div>
          ))}
          {!kw && list.length > shown.length && (
            <button className="src src-more" onClick={() => setAll(true)}>
              顯示全部 {list.length} 位
            </button>
          )}
          {kw && !list.length && <div className="muted small" style={{ padding: '4px 10px' }}>找不到符合的上傳者</div>}
          {!kw && data.unknown > 0 && (
            <button className={`src ${active === 'unknown' ? 'active' : ''}`} onClick={() => pick(active === 'unknown' ? '' : 'unknown')}>
              <span className="muted">未知上傳者</span>
              <span className="n">{data.unknown}</span>
            </button>
          )}
        </>
      )}
    </>
  );
}

export function SourcePanel({
  sources,
  total,
  filters,
  set,
  uploaders,
  onPin,
}: {
  sources: Sources | null;
  total: number;
  filters: Filters;
  set: (f: Partial<Filters>) => void;
  uploaders: UploaderList | null;
  onPin: (u: Uploader) => void;
}) {
  if (!sources) return <Loading />;
  const item = (active: boolean, onClick: () => void, label: ReactNode, n: number, key: string) => (
    <button key={key} className={`src ${active ? 'active' : ''}`} onClick={onClick}>
      {label}
      <span className="n">{n}</span>
    </button>
  );
  // 各個篩選條件可以疊加，從上方的標記單獨清除
  const none = !filters.group && !filters.project && !filters.tag && !filters.year && !filters.uploader;
  return (
    <>
      <h4>檔案來源</h4>
      {item(none, () => set({ group: '', project: '', tag: '', year: '', uploader: '' }), '全部檔案', total, 'all')}
      {sources.groups.map((g) =>
        item(
          filters.group === g.id,
          () => set({ group: filters.group === g.id ? '' : g.id }),
          <>
            <SourceIcon type={g.source_type} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.name || '（未命名）'}</span>
          </>,
          g.count,
          g.id,
        ),
      )}
      <UploaderSection data={uploaders} active={filters.uploader} pick={(key) => set({ uploader: key })} onPin={onPin} />
      {sources.projects.length > 0 && <h4>專案</h4>}
      {sources.projects.map((p) => item(filters.project === String(p.id), () => set({ project: filters.project === String(p.id) ? '' : String(p.id) }), <ProjectBadge name={p.name} color={p.color} />, p.count, `p${p.id}`))}
      {sources.tags.length > 0 && <h4>標籤</h4>}
      {sources.tags
        .filter((t) => (t.count ?? 0) > 0)
        .slice(0, 20)
        .map((t) => item(filters.tag === String(t.id), () => set({ tag: filters.tag === String(t.id) ? '' : String(t.id) }), `# ${t.name}`, t.count ?? 0, `t${t.id}`))}
      {sources.years.length > 1 && <h4>年度</h4>}
      {sources.years.length > 1 && sources.years.map((y) => item(filters.year === y.year, () => set({ year: filters.year === y.year ? '' : y.year }), `${y.year} 年`, y.count, `y${y.year}`))}
    </>
  );
}

export function FileRow({ f, selecting, selected, onToggle, onOpen, draggable }: { f: FileItem; selecting: boolean; selected: boolean; onToggle: () => void; onOpen: () => void; draggable?: boolean }) {
  const press = useRef<number | null>(null);
  return (
    <div
      className="item"
      role="button"
      tabIndex={0}
      draggable={draggable && f.status === 'done'}
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-grabit-file', String(f.id));
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={() => (selecting ? onToggle() : onOpen())}
      onKeyDown={(e) => e.key === 'Enter' && (selecting ? onToggle() : onOpen())}
      onTouchStart={() => {
        if (selecting) return;
        press.current = window.setTimeout(() => {
          onToggle();
          navigator.vibrate?.(15);
          press.current = null;
        }, 500);
      }}
      onTouchEnd={() => press.current && clearTimeout(press.current)}
      onTouchMove={() => press.current && clearTimeout(press.current)}
    >
      {selecting && <input type="checkbox" className="cb" checked={selected} onChange={onToggle} onClick={(e) => e.stopPropagation()} aria-label="選取" />}
      <FileIcon ext={f.ext} type={f.message_type} />
      <div className="grow">
        <div className="title">{f.stored_name ?? f.original_name}</div>
        <div className="meta">
          <SourceIcon type={f.source} /> {f.group_name}
          {f.uploader_name ? ` · ${f.uploader_name}` : ''} · {f.status === 'failed' ? f.error : f.folder_path ?? '等待處理'} · {formatTime(f.received_at)}
        </div>
        {(f.project_name || f.tags.length > 0 || f.version_label) && (
          <div className="sub">
            {f.version_label && <span className="version-pill">{f.version_label}{f.version_count > 1 ? ` · 共 ${f.version_count} 版` : ''}</span>}
            {f.project_name && <ProjectBadge name={f.project_name} color={f.project_color} />}
            {f.tags.slice(0, 4).map((t) => (
              <TagChip key={t.id} tag={t} />
            ))}
          </div>
        )}
      </div>
      <StatusBadge file={f} />
    </div>
  );
}

export function Files() {
  const toast = useToast();
  const me = useMe();
  const editable = canEdit(me);
  const afterMove = useAfterMove();
  const initial = useMemo(readQuery, []);
  const [filters, setFilters] = useState<Filters>(initial);
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
  const [bulkLabel, setBulkLabel] = useState(false);
  const [filterSheet, setFilterSheet] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [aliasDraft, setAliasDraft] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const stats = useLoad(() => api<Stats>('/stats'), [tick]);
  const sources = useLoad(() => api<Sources>('/sources'), [tick]);
  const uploaders = useLoad(() => api<UploaderList>('/uploaders'), [tick]);
  const folders = useLoad(() => api<{ items: { path: string }[] }>('/folders'), [tick]);
  const folderList = [...new Set(folders.data?.items.map((f) => f.path) ?? [])];
  const set = (f: Partial<Filters>) => setFilters((cur) => ({ ...cur, ...f }));

  // 從別的地方連進來（例如檔案資訊的「看這個人的所有檔案」）時，套用網址上的篩選
  useEffect(() => {
    const onNav = () => {
      if (!currentUrl().pathname.startsWith('/files')) return;
      const { open, ...next } = readQuery();
      setFilters(next);
      setOpenId(open);
    };
    window.addEventListener('grabit-nav', onNav);
    window.addEventListener('popstate', onNav);
    return () => {
      window.removeEventListener('grabit-nav', onNav);
      window.removeEventListener('popstate', onNav);
    };
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setQuery(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v && v !== 'all') p.set(k, v === true ? '1' : String(v));
    if (openId) p.set('open', String(openId));
    const s = p.toString();
    replaceUrl(`/files${s ? `?${s}` : ''}`);
  }, [filters, openId]);

  const load = async (offset: number) => {
    setLoading(true);
    try {
      const p = new URLSearchParams({ status: filters.status, q: query, offset: String(offset), limit: '50' });
      for (const k of ['group', 'project', 'tag', 'year', 'type', 'uploader'] as const) if (filters[k]) p.set(k, filters[k]);
      if (filters.latest) p.set('latest', '1');
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
  }, [filters, query, tick]);

  const refresh = () => setTick((t) => t + 1);
  const toggle = (id: number) => {
    setSelecting(true);
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const batchDelete = async () => {
    if (!(await ask(`確定要刪除 ${selected.size} 個檔案？雲端上的檔案會移到垃圾桶（可以救回）。`))) return;
    try {
      const r = await api<{ deleted: number }>('/files/delete', { method: 'POST', json: { ids: [...selected] } });
      toast(`已刪除 ${r.deleted} 個檔案`);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
    setSelecting(false);
    refresh();
  };

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setUploading(true);
    let ok = 0;
    for (const file of Array.from(list)) {
      const fd = new FormData();
      fd.append('file', file);
      try {
        const r = await api<{ status: string; folder: string; error?: string }>('/upload', { method: 'POST', body: fd });
        if (r.status === 'failed') toast(`${file.name}：${r.error}`, 'error');
        else ok++;
      } catch (e) {
        toast(`${file.name}：${(e as Error).message}`, 'error');
      }
    }
    setUploading(false);
    if (ok) toast(`已上傳並歸檔 ${ok} 個檔案`);
    refresh();
  };

  const activeChips: { label: string; clear: () => void }[] = [];
  const g = sources.data?.groups.find((x) => x.id === filters.group);
  if (g) activeChips.push({ label: g.name, clear: () => set({ group: '' }) });
  const p = sources.data?.projects.find((x) => String(x.id) === filters.project);
  if (p) activeChips.push({ label: `專案：${p.name}`, clear: () => set({ project: '' }) });
  const t = sources.data?.tags.find((x) => String(x.id) === filters.tag);
  if (t) activeChips.push({ label: `#${t.name}`, clear: () => set({ tag: '' }) });
  if (filters.year) activeChips.push({ label: `${filters.year} 年`, clear: () => set({ year: '' }) });
  const up = filters.uploader === 'unknown' ? null : uploaders.data?.items.find((x) => x.key === filters.uploader);
  if (filters.uploader) activeChips.push({ label: `上傳者：${filters.uploader === 'unknown' ? '未知' : (up?.name ?? '…')}`, clear: () => set({ uploader: '' }) });
  if (filters.type) activeChips.push({ label: TYPES.find(([k]) => k === filters.type)?.[1] ?? filters.type, clear: () => set({ type: '' }) });

  const pin = async (u: Uploader) => {
    try {
      await api(`/uploaders/${encodeURIComponent(u.key)}/pin`, { method: 'PUT', json: { pinned: !u.pinned } });
      uploaders.reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const saveAlias = async (u: Uploader) => {
    try {
      await api(`/uploaders/${encodeURIComponent(u.key)}`, { method: 'PATCH', json: { alias: aliasDraft ?? '' } });
      toast('已更新顯示名稱，舊檔案也會跟著顯示新名稱');
      setAliasDraft(null);
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>檔案</h1>
          <p>所有群組、Email 與手動上傳的檔案集中管理</p>
        </div>
        <div className="row">
          {editable && (
            <>
              <input ref={fileInput} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
              <button className="btn sm" disabled={uploading} onClick={() => fileInput.current?.click()}>
                <Icon name="upload" />
                {uploading ? '上傳中…' : '上傳'}
              </button>
              <button
                className="btn sm"
                onClick={() => {
                  setSelecting((v) => !v);
                  setSelected(new Set());
                }}
              >
                {selecting ? '取消選取' : '選取'}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="files-layout">
        <aside className="source-panel card card-pad">
          <SourcePanel sources={sources.data} total={stats.data?.archived ?? 0} filters={filters} set={set} uploaders={uploaders.data} onPin={pin} />
        </aside>
        <div>
          <div className="tabs" role="tablist">
            {TABS.map((tab) => {
              const n = 'count' in tab && stats.data ? (stats.data[tab.count] as number) : 0;
              return (
                <button key={tab.key} role="tab" aria-selected={filters.status === tab.key} className={`tab ${filters.status === tab.key ? 'active' : ''}`} onClick={() => set({ status: tab.key })}>
                  {tab.label}
                  {n > 0 && <span className="n">{n}</span>}
                </button>
              );
            })}
          </div>
          <div className="row" style={{ marginBottom: 10 }}>
            <div className="grow" style={{ position: 'relative', minWidth: 180 }}>
              <input className="input" type="search" placeholder={me?.fullText ? '搜尋檔名、內文、摘要、標籤…' : '搜尋檔名、資料夾、標籤…'} value={q} onChange={(e) => setQ(e.target.value)} style={{ paddingLeft: 36 }} />
              <span style={{ position: 'absolute', left: 11, top: 11, width: 18, height: 18, color: 'var(--muted)' }}>
                <Icon name="search" />
              </span>
            </div>
            <button className="btn filter-button" onClick={() => setFilterSheet(true)}>
              <Icon name="filter" />
              來源
            </button>
            <select className="select" style={{ width: 'auto' }} value={filters.type} onChange={(e) => set({ type: e.target.value })} aria-label="檔案類型">
              {TYPES.map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <label className="check small">
              <Switch checked={filters.latest} onChange={(v) => set({ latest: v })} label="只顯示最新版本" />
              只看最新版本
            </label>
          </div>
          {filters.uploader && (
            <div className="uploader-head card card-pad">
              <div className="grow">
                {aliasDraft != null && up ? (
                  <form
                    className="row"
                    style={{ gap: 6, flexWrap: 'nowrap', marginBottom: 6 }}
                    onSubmit={(e) => {
                      e.preventDefault();
                      void saveAlias(up);
                    }}
                  >
                    <input className="input" value={aliasDraft} onChange={(e) => setAliasDraft(e.target.value)} placeholder={up.display_name ?? '顯示名稱'} maxLength={40} autoFocus aria-label="顯示名稱" />
                    <button className="btn sm primary" type="submit">
                      儲存
                    </button>
                    <button className="btn sm" type="button" onClick={() => setAliasDraft(null)}>
                      取消
                    </button>
                  </form>
                ) : (
                  <h2>{filters.uploader === 'unknown' ? '未知上傳者的檔案' : `${up?.name ?? '…'} 的檔案`}</h2>
                )}
                <p className="muted small">
                  {filters.uploader === 'unknown'
                    ? `${uploaders.data?.unknown ?? 0} 份檔案 · 舊的檔案或來源沒有提供身分，不會依名稱合併`
                    : up
                      ? `${up.count} 份檔案 · 跨 ${up.groups} 個群組${up.projects ? `、${up.projects} 個專案` : ''} · ${SOURCE_LABEL[up.source] ?? up.source}${up.alias && up.display_name ? ` · 原名「${up.display_name}」` : ''}`
                      : ''}
                </p>
              </div>
              {up && (
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn sm" onClick={() => pin(up)}>
                    {up.pinned ? '★ 已釘選' : '☆ 釘選'}
                  </button>
                  {editable && aliasDraft == null && (
                    <button className="btn sm" onClick={() => setAliasDraft(up.alias ?? '')}>
                      改顯示名稱
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          {activeChips.length > 0 && (
            <div className="active-filters">
              {activeChips.map((c) => (
                <TagChip key={c.label} tag={{ name: c.label }} onRemove={c.clear} />
              ))}
            </div>
          )}

          {selecting && (
            <div className="selectbar">
              <span className="grow">已選 {selected.size} 個</span>
              <button className="btn sm" disabled={!selected.size} onClick={() => setBatchMove(true)}>
                移動到…
              </button>
              <button className="btn sm" disabled={!selected.size} onClick={() => setBulkLabel(true)}>
                專案／標籤…
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
              <Empty title={query ? '找不到符合的檔案' : filters.status === 'unsorted' ? '沒有待分類的檔案' : '這裡還沒有檔案'}>
                {query && !me?.fullText && '試試別的關鍵字。'}
              </Empty>
            ) : (
              <ul className="list">
                {items.map((f) => (
                  <li key={f.id}>
                    <FileRow f={f} selecting={selecting} selected={selected.has(f.id)} onToggle={() => toggle(f.id)} onOpen={() => setOpenId(f.id)} />
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
        </div>
      </div>

      {openId != null && <FileSheet id={openId} folders={folderList} onClose={() => setOpenId(null)} onChanged={refresh} />}
      {filterSheet && (
        <Sheet title="篩選來源" onClose={() => setFilterSheet(false)}>
          <div className="filter-sheet">
            <SourcePanel
              sources={sources.data}
              total={stats.data?.archived ?? 0}
              filters={filters}
              set={(f) => {
                set(f);
                setFilterSheet(false);
              }}
              uploaders={uploaders.data}
              onPin={pin}
            />
          </div>
        </Sheet>
      )}
      {bulkLabel && (
        <BulkLabel
          ids={[...selected]}
          onClose={() => setBulkLabel(false)}
          onDone={(msg) => {
            setBulkLabel(false);
            setSelecting(false);
            toast(msg);
            refresh();
          }}
        />
      )}
      {batchMove && (
        <BatchMove
          ids={[...selected]}
          folders={folderList}
          onClose={() => setBatchMove(false)}
          onDone={(r) => {
            setBatchMove(false);
            setSelecting(false);
            afterMove(`已移動 ${r.moved} 個檔案`, r, refresh);
            refresh();
          }}
        />
      )}
    </>
  );
}

export function BatchMove({ ids, folders, onClose, onDone }: { ids: number[]; folders: string[]; onClose: () => void; onDone: (r: { moved: number; batchId: string; suggestion: null }) => void }) {
  const toast = useToast();
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const projects = useLoad(() => api<{ items: Project[] }>('/projects'), []);
  const go = async () => {
    setBusy(true);
    try {
      const r = await api<{ moved: number; errors: string[]; batchId: string; suggestion: null }>('/files/move', { method: 'POST', json: { ids, folderPath: folder } });
      if (r.errors.length) toast(`${r.errors.length} 個檔案移動失敗：${r.errors[0]}`, 'error');
      onDone(r);
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };
  return (
    <Sheet
      title={`移動 ${ids.length} 個檔案`}
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn primary" disabled={busy || !folder.trim()} onClick={go}>
            {busy ? '移動中…' : '移動'}
          </button>
        </>
      }
    >
      <label className="field">
        <span>目標資料夾</span>
        <FolderInput value={folder} onChange={setFolder} folders={folders} autoFocus />
        <small>只會移動已歸檔的檔案。手動移動過的檔案，之後重新套用規則時不會被搬走。</small>
      </label>
      {projects.data && projects.data.items.length > 0 && <p className="muted small">要設定專案或標籤，請打開個別檔案。</p>}
    </Sheet>
  );
}

/** 多選後一次設定專案或加標籤 */
export function BulkLabel({ ids, onClose, onDone }: { ids: number[]; onClose: () => void; onDone: (msg: string) => void }) {
  const toast = useToast();
  const projects = useLoad(() => api<{ items: Project[] }>('/projects'), []);
  const [project, setProject] = useState<string>('keep');
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);
  const addTags = tags
    .split(/[,，、]/)
    .map((t) => t.trim())
    .filter(Boolean);
  const go = async () => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { ids };
      if (project !== 'keep') body.projectId = project === 'none' ? null : Number(project);
      if (addTags.length) body.addTags = addTags;
      const r = await api<{ updated: number }>('/files/bulk', { method: 'POST', json: body });
      onDone(`已更新 ${r.updated} 個檔案`);
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };
  return (
    <Sheet
      title={`設定 ${ids.length} 個檔案的專案與標籤`}
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy || (project === 'keep' && !addTags.length)} onClick={go}>
            套用
          </button>
        </>
      }
    >
      <label className="field">
        <span>專案</span>
        <select className="select" value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="keep">不變</option>
          <option value="none">移出專案</option>
          {projects.data?.items.map((p) => (
            <option key={p.id} value={p.id}>
              加入「{p.name}」
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>加上標籤</span>
        <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="例：期末報告, FY115" />
        <small>多個用逗號分隔；原本的標籤會保留</small>
      </label>
    </Sheet>
  );
}
