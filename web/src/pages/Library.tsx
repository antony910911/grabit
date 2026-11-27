// 「整理」：資料夾、專案、標籤三種模式，同一批檔案用不同方式整理
import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from 'react';
import { api, type FileItem, type Project, type Storage, type Tag } from '../api';
import { Empty, ErrorBox, FileIcon, Icon, Loading, Sheet, TagChip } from '../components';
import { FileSheet, useAfterMove } from '../FileSheet';
import { Files } from './Files';
import { ask, canEdit, currentUrl, formatBytes, formatTime, replaceUrl, useLoad, useMe, useToast } from '../lib';

type Mode = 'list' | 'folders' | 'projects' | 'tags';
const DRAG = 'application/x-grabit-file';

const MODES: { key: Mode; label: string; icon: string; hint: string }[] = [
  { key: 'list', label: '全部', icon: 'files', hint: '所有群組、Email 與上傳的檔案，可以依來源、專案、標籤篩選' },
  { key: 'folders', label: '資料夾', icon: 'folder', hint: '雲端硬碟上的實際位置' },
  { key: 'projects', label: '專案', icon: 'layers', hint: '跨群組、跨資料夾的研究專案' },
  { key: 'tags', label: '標籤', icon: 'tag', hint: '一個檔案可以有很多標籤' },
];

function readMode(): Mode {
  const u = currentUrl();
  if (u.pathname.startsWith('/labels')) return 'projects';
  if (u.pathname.startsWith('/folders')) return 'folders';
  if (u.pathname.startsWith('/files')) return 'list';
  const m = u.searchParams.get('mode');
  return m === 'projects' || m === 'tags' || m === 'folders' ? m : 'list';
}

/** 讓元素可以接收拖進來的檔案 */
function useDrop(onDrop: (id: number) => void, enabled = true) {
  const [over, setOver] = useState(false);
  return {
    over,
    props: enabled
      ? {
          onDragOver: (e: DragEvent) => {
            if (e.dataTransfer.types.includes(DRAG)) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setOver(true);
            }
          },
          onDragLeave: () => setOver(false),
          onDrop: (e: DragEvent) => {
            e.preventDefault();
            setOver(false);
            const id = Number(e.dataTransfer.getData(DRAG));
            if (id) onDrop(id);
          },
        }
      : {},
  };
}

const dragProps = (f: FileItem, enabled: boolean) =>
  enabled && f.status === 'done'
    ? {
        draggable: true,
        onDragStart: (e: DragEvent) => {
          e.dataTransfer.setData(DRAG, String(f.id));
          e.dataTransfer.effectAllowed = 'move';
        },
      }
    : {};

export function Library() {
  const me = useMe();
  const [mode, setMode] = useState<Mode>(readMode);
  const [openId, setOpenId] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);

  useEffect(() => {
    // 「全部」用 /files（檔案清單自己會把篩選條件寫進網址），其他模式用 /library?mode=
    if (mode === 'list') {
      if (!currentUrl().pathname.startsWith('/files')) replaceUrl('/files');
      return;
    }
    const p = currentUrl().pathname.startsWith('/library') ? currentUrl().searchParams : new URLSearchParams();
    p.set('mode', mode);
    replaceUrl(`/library?${p}`);
  }, [mode]);

  return (
    <div className="library">
      <div className="lib-head">
        <div>
          <h1>檔案</h1>
          <p className="muted small">{MODES.find((m) => m.key === mode)!.hint}</p>
        </div>
        <div className="segmented" role="tablist" aria-label="整理方式">
          {MODES.map((m) => (
            <button key={m.key} role="tab" aria-selected={mode === m.key} className={mode === m.key ? 'on' : ''} onClick={() => setMode(m.key)}>
              <Icon name={m.icon} />
              {m.label}
            </button>
          ))}
        </div>
      </div>
      {mode === 'list' && (
        <div className="embedded">
          <Files />
        </div>
      )}
      {mode === 'folders' && <FolderMode tick={tick} editable={canEdit(me)} onOpen={setOpenId} refresh={refresh} />}
      {mode === 'projects' && <ProjectMode tick={tick} editable={canEdit(me)} onOpen={setOpenId} refresh={refresh} />}
      {mode === 'tags' && <TagMode tick={tick} editable={canEdit(me)} onOpen={setOpenId} refresh={refresh} />}
      {openId != null && mode !== 'list' && <FileSheet id={openId} folders={[]} onClose={() => setOpenId(null)} onChanged={refresh} />}
    </div>
  );
}

interface ModeProps {
  tick: number;
  editable: boolean;
  onOpen: (id: number) => void;
  refresh: () => void;
}

// ---------------------------------------------------------------- 資料夾（Finder 風格）

interface FolderStat {
  path: string;
  count: number;
  bytes: number;
}

interface Child {
  name: string;
  path: string;
  count: number;
  bytes: number;
}

/** 由所有檔案的資料夾路徑，算出某一層底下的子資料夾（含中間層） */
function childrenOf(stats: FolderStat[], parent: string): Child[] {
  const map = new Map<string, Child>();
  const prefix = parent ? `${parent}/` : '';
  for (const s of stats) {
    if (parent && !s.path.startsWith(prefix)) continue;
    const rest = s.path.slice(prefix.length);
    if (!rest) continue;
    const name = rest.split('/')[0]!;
    const path = prefix + name;
    const c = map.get(path) ?? { name, path, count: 0, bytes: 0 };
    c.count += s.count;
    c.bytes += s.bytes;
    map.set(path, c);
  }
  return [...map.values()].sort((a, b) => Number(a.name.startsWith('_')) - Number(b.name.startsWith('_')) || a.name.localeCompare(b.name, 'zh-Hant'));
}

function TreeItem({ node, stats, depth, current, go, onDrop, editable }: { node: Child; stats: FolderStat[]; depth: number; current: string; go: (p: string) => void; onDrop: (p: string, id: number) => void; editable: boolean }) {
  const kids = useMemo(() => childrenOf(stats, node.path), [stats, node.path]);
  const inside = current === node.path || current.startsWith(`${node.path}/`);
  const [open, setOpen] = useState(inside);
  useEffect(() => {
    if (inside) setOpen(true);
  }, [inside]);
  const drop = useDrop((id) => onDrop(node.path, id), editable);
  return (
    <li>
      <div className={`tree-row ${current === node.path ? 'active' : ''} ${drop.over ? 'drop' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => go(node.path)} {...drop.props}>
        <button
          className="disclosure"
          aria-label={open ? '收合' : '展開'}
          style={{ visibility: kids.length ? 'visible' : 'hidden' }}
          onClick={(e) => {
            e.stopPropagation();
            setOpen(!open);
          }}
        >
          <svg viewBox="0 0 10 10" style={{ transform: open ? 'rotate(90deg)' : 'none' }}>
            <path d="M3 1.5 7 5 3 8.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        <span className="tree-icon">
          <Icon name="folder" />
        </span>
        <span className="tree-name">{node.name}</span>
      </div>
      {open && kids.length > 0 && (
        <ul>
          {kids.map((k) => (
            <TreeItem key={k.path} node={k} stats={stats} depth={depth + 1} current={current} go={go} onDrop={onDrop} editable={editable} />
          ))}
        </ul>
      )}
    </li>
  );
}

function FolderRow({ c, go, onDrop, editable }: { c: Child; go: (p: string) => void; onDrop: (p: string, id: number) => void; editable: boolean }) {
  const drop = useDrop((id) => onDrop(c.path, id), editable);
  return (
    <div className={`f-row ${drop.over ? 'drop' : ''}`} role="button" tabIndex={0} onClick={() => go(c.path)} onKeyDown={(e) => e.key === 'Enter' && go(c.path)} {...drop.props}>
      <span className="f-icon folder">
        <Icon name="folder" />
      </span>
      <span className="f-name">{c.name}</span>
      <span className="f-meta">{c.count} 個檔案</span>
      <span className="f-size">{formatBytes(c.bytes)}</span>
      <span className="f-chev">›</span>
    </div>
  );
}

function FileLine({ f, onOpen, editable, extra }: { f: FileItem; onOpen: (id: number) => void; editable: boolean; extra?: ReactNode }) {
  return (
    <div className="f-row" role="button" tabIndex={0} onClick={() => onOpen(f.id)} onKeyDown={(e) => e.key === 'Enter' && onOpen(f.id)} {...dragProps(f, editable)}>
      <span className="f-icon">
        <FileIcon ext={f.ext} type={f.message_type} />
      </span>
      <span className="f-name">
        <span className="f-title">{f.stored_name ?? f.original_name}</span>
        {extra ?? (f.tags.length > 0 && (
          <span className="tags f-tags">
            {f.tags.slice(0, 3).map((t) => (
              <TagChip key={t.id} tag={t} />
            ))}
          </span>
        ))}
      </span>
      <span className="f-meta">{formatTime(f.received_at)}</span>
      <span className="f-size">{formatBytes(f.size)}</span>
      <span className="f-chev" />
    </div>
  );
}

function FolderMode({ tick, editable, onOpen, refresh }: ModeProps) {
  const toast = useToast();
  const afterMove = useAfterMove();
  const storages = useLoad(() => api<{ items: Storage[] }>('/storages'), []);
  const [storageId, setStorageId] = useState<number | null>(null);
  const sid = storageId ?? storages.data?.items[0]?.id ?? null;
  const [path, setPath] = useState(() => currentUrl().searchParams.get('path') ?? '');
  const stats = useLoad(() => (sid ? api<{ items: FolderStat[] }>(`/folders?storage=${sid}`) : Promise.resolve({ items: [] })), [sid, tick]);
  const files = useLoad(
    () => (sid && path ? api<{ items: FileItem[] }>(`/files?status=all&storage=${sid}&folder=${encodeURIComponent(path)}&recursive=0&limit=200`) : Promise.resolve({ items: [] as FileItem[] })),
    [sid, path, tick],
  );
  const [rename, setRename] = useState<string | null>(null);
  const all = stats.data?.items ?? [];
  const top = useMemo(() => childrenOf(all, ''), [all]);
  const kids = useMemo(() => childrenOf(all, path), [all, path]);
  const crumbs = path ? path.split('/') : [];
  const rootName = storages.data?.items.find((s) => s.id === sid)?.root_folder ?? 'GrabIt';

  const go = (p: string) => {
    setPath(p);
    const q = currentUrl().searchParams;
    if (p) q.set('path', p);
    else q.delete('path');
    replaceUrl(`/library?${q}`);
  };
  const drop = async (folder: string, id: number) => {
    try {
      const r = await api<{ moved: number; batchId: string; suggestion: null }>('/files/move', { method: 'POST', json: { ids: [id], folderPath: folder } });
      if (!r.moved) return;
      afterMove(`已移到 ${folder.split('/').join(' › ')}`, r, refresh);
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  if (storages.error || stats.error) return <ErrorBox message={(storages.error || stats.error)!} />;
  return (
    <div className="finder">
      <aside className="finder-side">
        {storages.data && storages.data.items.length > 1 && (
          <select className="select side-select" value={sid ?? ''} onChange={(e) => (setStorageId(Number(e.target.value)), go(''))} aria-label="雲端空間">
            {storages.data.items.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        <div className={`tree-row ${path === '' ? 'active' : ''}`} onClick={() => go('')}>
          <span className="disclosure" />
          <span className="tree-icon">
            <Icon name="cloud" />
          </span>
          <span className="tree-name">{rootName}</span>
        </div>
        {stats.loading && !stats.data ? (
          <Loading />
        ) : (
          <ul className="tree-list">
            {top.map((n) => (
              <TreeItem key={n.path} node={n} stats={all} depth={0} current={path} go={go} onDrop={drop} editable={editable} />
            ))}
          </ul>
        )}
      </aside>
      <section className="finder-main">
        <div className="finder-bar">
          <button className="btn icon ghost" disabled={!path} onClick={() => go(crumbs.slice(0, -1).join('/'))} aria-label="上一層">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
          <nav className="crumbs" aria-label="目前位置">
            <button onClick={() => go('')}>{rootName}</button>
            {crumbs.map((c, i) => (
              <span key={i}>
                <i>›</i>
                <button onClick={() => go(crumbs.slice(0, i + 1).join('/'))} className={i === crumbs.length - 1 ? 'here' : ''}>
                  {c}
                </button>
              </span>
            ))}
          </nav>
          {path && editable && (
            <button className="btn sm" onClick={() => setRename(path)}>
              改名／搬移
            </button>
          )}
        </div>
        <div className="f-list">
          <div className="f-row f-head" aria-hidden="true">
            <span className="f-icon" />
            <span className="f-name">名稱</span>
            <span className="f-meta">日期／內容</span>
            <span className="f-size">大小</span>
            <span className="f-chev" />
          </div>
          {kids.map((c) => (
            <FolderRow key={c.path} c={c} go={go} onDrop={drop} editable={editable} />
          ))}
          {files.data?.items.map((f) => (
            <FileLine key={f.id} f={f} onOpen={onOpen} editable={editable} />
          ))}
          {!stats.loading && !files.loading && !kids.length && !files.data?.items.length && (
            <Empty title={path ? '這個資料夾是空的' : '還沒有檔案'}>{path ? '' : '檔案歸檔後會出現在這裡。'}</Empty>
          )}
          {files.loading && path && !files.data && <Loading />}
        </div>
        {editable && <p className="finder-tip muted small">在電腦上可以把檔案拖到左邊或清單裡的資料夾；手機上請點檔案 →「移動／改名」。</p>}
      </section>
      {rename && sid && <RenameFolder storageId={sid} from={rename} onClose={() => setRename(null)} onDone={(to) => (setRename(null), go(to), refresh())} />}
    </div>
  );
}

function RenameFolder({ storageId, from, onClose, onDone }: { storageId: number; from: string; onClose: () => void; onDone: (to: string) => void }) {
  const toast = useToast();
  const afterMove = useAfterMove();
  const [to, setTo] = useState(from);
  const apply = async () => {
    try {
      const r = await api<{ moved: number; batchId: string }>('/folders/rename', { method: 'POST', json: { storageId, from, to } });
      afterMove(`資料夾已更新（${r.moved} 個檔案），指向這裡的規則也一起改好了`, { batchId: r.batchId }, () => onDone(from));
      onDone(to);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <Sheet
      title="資料夾改名或搬移"
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={!to.trim() || to === from} onClick={apply}>
            套用
          </button>
        </>
      }
    >
      <label className="field">
        <span>新的位置</span>
        <input className="input" value={to} onChange={(e) => setTo(e.target.value)} autoFocus />
        <small>只改最後一段就是改名；改前面的路徑就是搬到別的資料夾底下（例如「會議紀錄」改成「行政/會議紀錄」）。可以復原。</small>
      </label>
    </Sheet>
  );
}

// ---------------------------------------------------------------- 專案（看板）

const COLORS = ['#4a6fa5', '#2c7a52', '#a75a1d', '#a2382f', '#6a4a97', '#2f8a8a', '#8a6d1f', '#697181'];

function Column({ title, color, count, projectId, tick, editable, onOpen, refresh, onEdit }: { title: string; color: string; count?: number; projectId: number | 'none'; tick: number; editable: boolean; onOpen: (id: number) => void; refresh: () => void; onEdit?: () => void }) {
  const toast = useToast();
  const files = useLoad(() => api<{ items: FileItem[]; hasMore: boolean }>(`/files?project=${projectId}&limit=60`), [projectId, tick]);
  const drop = useDrop(async (id) => {
    try {
      await api('/files/bulk', { method: 'POST', json: { ids: [id], projectId: projectId === 'none' ? null : projectId } });
      toast(projectId === 'none' ? '已移出專案' : `已加入「${title}」`);
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }, editable);
  return (
    <section className={`kanban-col ${drop.over ? 'drop' : ''}`} {...drop.props}>
      <header>
        <i style={{ background: color }} />
        <strong>{title}</strong>
        <span className="muted small">{count ?? (files.data ? `${files.data.items.length}${files.data.hasMore ? '+' : ''}` : '')}</span>
        {onEdit && editable && (
          <button className="btn ghost icon sm" onClick={onEdit} aria-label={`編輯專案 ${title}`}>
            <Icon name="settings" />
          </button>
        )}
      </header>
      <div className="kanban-cards">
        {files.loading && !files.data && <Loading />}
        {files.data?.items.map((f) => (
          <article key={f.id} className="kcard" onClick={() => onOpen(f.id)} {...dragProps(f, editable)}>
            <div className="kcard-top">
              <FileIcon ext={f.ext} type={f.message_type} />
              <div className="kcard-name">{f.stored_name ?? f.original_name}</div>
            </div>
            <div className="muted small">
              {f.group_name} · {formatTime(f.received_at)}
            </div>
            {f.tags.length > 0 && (
              <div className="tags">
                {f.tags.slice(0, 3).map((t) => (
                  <TagChip key={t.id} tag={t} />
                ))}
              </div>
            )}
          </article>
        ))}
        {files.data && !files.data.items.length && <div className="kanban-empty">{editable ? '把檔案拖到這裡' : '沒有檔案'}</div>}
        {files.data?.hasMore && <div className="kanban-empty">只顯示最近 60 個</div>}
      </div>
    </section>
  );
}

function ProjectMode({ tick, editable, onOpen, refresh }: ModeProps) {
  const projects = useLoad(() => api<{ items: Project[] }>('/projects'), [tick]);
  const [edit, setEdit] = useState<Partial<Project> | null>(null);
  if (projects.error) return <ErrorBox message={projects.error} />;
  return (
    <>
      <p className="muted small board-tip">
        每一欄是一個專案。{editable ? '在電腦上把卡片拖到別的欄就能換專案；手機上點卡片，在檔案資訊裡選專案。' : ''}
      </p>
      <div className="kanban">
        <Column title="未分專案" color="var(--border)" projectId="none" tick={tick} editable={editable} onOpen={onOpen} refresh={refresh} />
        {projects.data?.items.map((p) => (
          <Column key={p.id} title={p.name} color={p.color} count={p.count} projectId={p.id} tick={tick} editable={editable} onOpen={onOpen} refresh={refresh} onEdit={() => setEdit(p)} />
        ))}
        {editable && (
          <button className="kanban-add" onClick={() => setEdit({ name: '', color: COLORS[(projects.data?.items.length ?? 0) % COLORS.length], description: '' })}>
            <Icon name="plus" />
            新增專案
          </button>
        )}
      </div>
      {edit && (
        <ProjectSheet
          p={edit}
          onClose={() => setEdit(null)}
          onDone={() => {
            setEdit(null);
            refresh();
          }}
        />
      )}
    </>
  );
}

function ProjectSheet({ p, onClose, onDone }: { p: Partial<Project>; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [v, setV] = useState(p);
  const save = async () => {
    try {
      if (v.id) await api(`/projects/${v.id}`, { method: 'PUT', json: v });
      else await api('/projects', { method: 'POST', json: v });
      onDone();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const remove = async () => {
    if (!v.id || !(await ask(`刪除專案「${v.name}」？檔案不會被刪除，只會回到「未分專案」。`, '刪除專案'))) return;
    await api(`/projects/${v.id}`, { method: 'DELETE' });
    onDone();
  };
  return (
    <Sheet
      title={v.id ? '編輯專案' : '新增專案'}
      onClose={onClose}
      actions={
        <>
          {v.id && (
            <button className="btn danger" style={{ marginRight: 'auto' }} onClick={remove}>
              刪除
            </button>
          )}
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={!v.name?.trim()} onClick={save}>
            儲存
          </button>
        </>
      }
    >
      <label className="field">
        <span>專案名稱</span>
        <input className="input" value={v.name ?? ''} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="例：Farnesene、FY115 計畫" autoFocus />
      </label>
      <label className="field">
        <span>說明（選填）</span>
        <input className="input" value={v.description ?? ''} onChange={(e) => setV({ ...v, description: e.target.value })} />
      </label>
      <div className="field">
        <span>顏色</span>
        <div className="swatches">
          {COLORS.map((c) => (
            <button key={c} type="button" className={v.color === c ? 'on' : ''} style={{ background: c }} onClick={() => setV({ ...v, color: c })} aria-label={c} />
          ))}
        </div>
      </div>
      <p className="muted small">想讓某個群組的檔案自動進這個專案：到「群組設定」設定預設專案，或在分類規則裡指定專案。</p>
    </Sheet>
  );
}

// ---------------------------------------------------------------- 標籤

function TagItem({ t, active, onClick, onDrop, editable }: { t: Tag; active: boolean; onClick: () => void; onDrop: (id: number) => void; editable: boolean }) {
  const drop = useDrop(onDrop, editable);
  return (
    <div className={`tree-row ${active ? 'active' : ''} ${drop.over ? 'drop' : ''}`} onClick={onClick} {...drop.props}>
      <span className="tag-dot" style={{ background: t.color }} />
      <span className="tree-name">{t.name}</span>
      <span className="tree-count">{t.count}</span>
    </div>
  );
}

function TagMode({ tick, editable, onOpen, refresh }: ModeProps) {
  const toast = useToast();
  const tags = useLoad(() => api<{ items: Tag[] }>('/tags'), [tick]);
  const [sel, setSel] = useState<string>(() => currentUrl().searchParams.get('tag') ?? '');
  const files = useLoad(() => (sel ? api<{ items: FileItem[] }>(`/files?tag=${sel}&limit=200`) : Promise.resolve({ items: [] as FileItem[] })), [sel, tick]);
  const [edit, setEdit] = useState<Tag | null>(null);
  const list = tags.data?.items ?? [];
  useEffect(() => {
    if (!sel && list.length) setSel(String(list[0]!.id));
  }, [sel, list]);
  const current = list.find((t) => String(t.id) === sel);

  const addTag = async (t: Tag, id: number) => {
    try {
      await api('/files/bulk', { method: 'POST', json: { ids: [id], addTags: [t.name] } });
      toast(`已加上標籤「${t.name}」`);
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const removeTag = async (f: FileItem) => {
    if (!current) return;
    await api('/files/bulk', { method: 'POST', json: { ids: [f.id], removeTags: [current.name] } });
    refresh();
  };

  return (
    <div className="finder lib-tags">
      <aside className="finder-side">
        <div className={`tree-row ${sel === 'none' ? 'active' : ''}`} onClick={() => setSel('none')}>
          <span className="tag-dot" style={{ background: 'transparent', border: '1px dashed var(--muted)' }} />
          <span className="tree-name">還沒有標籤的檔案</span>
        </div>
        {tags.loading && !tags.data ? <Loading /> : list.map((t) => <TagItem key={t.id} t={t} active={String(t.id) === sel} onClick={() => setSel(String(t.id))} onDrop={(id) => addTag(t, id)} editable={editable} />)}
        {!tags.loading && !list.length && <p className="muted small" style={{ padding: 8 }}>還沒有標籤。在檔案資訊裡可以加標籤，規則與 AI 也會自動加上。</p>}
      </aside>
      <section className="finder-main">
        <div className="finder-bar">
          <nav className="crumbs">
            <button className="here">{sel === 'none' ? '還沒有標籤的檔案' : current ? `# ${current.name}` : '標籤'}</button>
          </nav>
          {current && editable && (
            <button className="btn sm" onClick={() => setEdit(current)}>
              編輯標籤
            </button>
          )}
        </div>
        <div className="f-list">
          {files.loading && !files.data && <Loading />}
          {files.data?.items.map((f) => (
            <FileLine
              key={f.id}
              f={f}
              onOpen={onOpen}
              editable={editable}
              extra={
                current && editable ? (
                  <button
                    className="link-btn small"
                    onClick={(e) => {
                      e.stopPropagation();
                      void removeTag(f);
                    }}
                  >
                    移除這個標籤
                  </button>
                ) : undefined
              }
            />
          ))}
          {files.data && !files.data.items.length && <Empty title="沒有檔案">{editable ? '在電腦上可以把檔案拖到左邊的標籤上。' : ''}</Empty>}
        </div>
      </section>
      {edit && <TagSheet t={edit} onClose={() => setEdit(null)} onDone={() => (setEdit(null), setSel(''), refresh())} />}
    </div>
  );
}

function TagSheet({ t, onClose, onDone }: { t: Tag; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [v, setV] = useState(t);
  const save = async () => {
    try {
      const r = await api<{ mergedInto?: number }>(`/tags/${v.id}`, { method: 'PUT', json: v });
      if (r.mergedInto) toast('已合併到同名的標籤');
      onDone();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const remove = async () => {
    if (!(await ask(`刪除標籤「${v.name}」？檔案不會被刪除。`, '刪除標籤'))) return;
    await api(`/tags/${v.id}`, { method: 'DELETE' });
    onDone();
  };
  return (
    <Sheet
      title="編輯標籤"
      onClose={onClose}
      actions={
        <>
          <button className="btn danger" style={{ marginRight: 'auto' }} onClick={remove}>
            刪除
          </button>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={save}>
            儲存
          </button>
        </>
      }
    >
      <label className="field">
        <span>標籤名稱</span>
        <input className="input" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} autoFocus />
        <small>改成已經存在的標籤名稱，就會把兩個標籤合併。</small>
      </label>
      <div className="field">
        <span>顏色</span>
        <div className="swatches">
          {COLORS.map((c) => (
            <button key={c} type="button" className={v.color === c ? 'on' : ''} style={{ background: c }} onClick={() => setV({ ...v, color: c })} aria-label={c} />
          ))}
        </div>
      </div>
    </Sheet>
  );
}
