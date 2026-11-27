import { useMemo, useState } from 'react';
import { api, type FileItem, type Storage } from '../api';
import { Empty, ErrorBox, Icon, Loading, Sheet } from '../components';
import { FileSheet, useAfterMove } from '../FileSheet';
import { FileRow } from './Files';
import { canEdit, formatBytes, useLoad, useMe, useToast } from '../lib';

interface Node {
  name: string;
  path: string;
  count: number; // 這一層與底下的檔案數
  own: number;
  children: Node[];
}

function buildTree(items: { path: string; count: number }[]): Node[] {
  const root: Node = { name: '', path: '', count: 0, own: 0, children: [] };
  for (const it of items) {
    let cur = root;
    const parts = it.path.split('/');
    parts.forEach((seg, i) => {
      const path = parts.slice(0, i + 1).join('/');
      let next = cur.children.find((c) => c.name === seg);
      if (!next) {
        next = { name: seg, path, count: 0, own: 0, children: [] };
        cur.children.push(next);
      }
      next.count += it.count;
      if (i === parts.length - 1) next.own += it.count;
      cur = next;
    });
  }
  const sort = (n: Node) => {
    n.children.sort((a, b) => (a.name.startsWith('_') ? 1 : 0) - (b.name.startsWith('_') ? 1 : 0) || a.name.localeCompare(b.name, 'zh-Hant'));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

function TreeNode({ node, depth, active, onSelect, onDrop, open, toggle }: { node: Node; depth: number; active: string; onSelect: (p: string) => void; onDrop: (p: string, id: number) => void; open: Set<string>; toggle: (p: string) => void }) {
  const [over, setOver] = useState(false);
  const isOpen = open.has(node.path);
  return (
    <li>
      <div
        className={`node ${active === node.path ? 'active' : ''} ${over ? 'drop' : ''}`}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => onSelect(node.path)}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('application/x-grabit-file')) {
            e.preventDefault();
            setOver(true);
          }
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const id = Number(e.dataTransfer.getData('application/x-grabit-file'));
          if (id) onDrop(node.path, id);
        }}
      >
        <span
          className="toggle"
          onClick={(e) => {
            e.stopPropagation();
            toggle(node.path);
          }}
        >
          {node.children.length ? (isOpen ? '▾' : '▸') : ''}
        </span>
        <Icon name="folder" />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
        <span className="n">{node.count}</span>
      </div>
      {isOpen && node.children.length > 0 && (
        <ul className="tree">
          {node.children.map((c) => (
            <TreeNode key={c.path} node={c} depth={depth + 1} active={active} onSelect={onSelect} onDrop={onDrop} open={open} toggle={toggle} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function Folders() {
  const toast = useToast();
  const me = useMe();
  const editable = canEdit(me);
  const afterMove = useAfterMove();
  const [tick, setTick] = useState(0);
  const storages = useLoad(() => api<{ items: Storage[] }>('/storages'), []);
  const [storageId, setStorageId] = useState<number | null>(null);
  const sid = storageId ?? storages.data?.items[0]?.id ?? null;
  const folders = useLoad(() => (sid ? api<{ items: { path: string; count: number; bytes: number }[] }>(`/folders?storage=${sid}`) : Promise.resolve({ items: [] })), [sid, tick]);
  const tree = useMemo(() => buildTree(folders.data?.items ?? []), [folders.data]);
  const [active, setActive] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const files = useLoad(
    () => (sid && active ? api<{ items: FileItem[] }>(`/files?status=all&storage=${sid}&folder=${encodeURIComponent(active)}&recursive=0&limit=200`) : Promise.resolve({ items: [] as FileItem[] })),
    [sid, active, tick],
  );
  const [openFile, setOpenFile] = useState<number | null>(null);
  const [rename, setRename] = useState<string | null>(null);
  const [newPath, setNewPath] = useState('');
  const refresh = () => setTick((t) => t + 1);

  const select = (p: string) => {
    setActive(p);
    setOpen((s) => new Set([...s, ...p.split('/').map((_, i, a) => a.slice(0, i + 1).join('/'))]));
  };
  const toggle = (p: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  const drop = async (folder: string, id: number) => {
    if (!editable) return;
    try {
      const r = await api<{ moved: number; batchId: string; suggestion: null }>('/files/move', { method: 'POST', json: { ids: [id], folderPath: folder } });
      afterMove(`已移到 ${folder}`, r, refresh);
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const doRename = async () => {
    if (!rename || !sid) return;
    try {
      const r = await api<{ moved: number; batchId: string }>('/folders/rename', { method: 'POST', json: { storageId: sid, from: rename, to: newPath } });
      afterMove(`資料夾已改名（${r.moved} 個檔案），相關規則已同步更新`, { batchId: r.batchId }, refresh);
      setActive(newPath);
      setRename(null);
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const activeNode = folders.data?.items.find((f) => f.path === active);
  const folderList = folders.data?.items.map((f) => f.path) ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>資料夾</h1>
          <p>雲端上的實際資料夾。電腦上可以把右邊的檔案拖到左邊的資料夾。</p>
        </div>
        {storages.data && storages.data.items.length > 1 && (
          <select className="select" style={{ width: 'auto' }} value={sid ?? ''} onChange={(e) => (setStorageId(Number(e.target.value)), setActive(''))} aria-label="雲端空間">
            {storages.data.items.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {(storages.error || folders.error) && <ErrorBox message={(storages.error || folders.error)!} />}
      <div className="grid-2" style={{ gridTemplateColumns: undefined }}>
        <div className="card card-pad" style={{ alignSelf: 'start' }}>
          {folders.loading && !folders.data ? (
            <Loading />
          ) : tree.length === 0 ? (
            <Empty title="還沒有資料夾">檔案歸檔後，資料夾會出現在這裡。</Empty>
          ) : (
            <ul className="tree">
              {tree.map((n) => (
                <TreeNode key={n.path} node={n} depth={0} active={active} onSelect={select} onDrop={drop} open={open} toggle={toggle} />
              ))}
            </ul>
          )}
        </div>
        <div className="card">
          <div className="card-head">
            <div style={{ minWidth: 0 }}>
              <h2 style={{ wordBreak: 'break-all' }}>{active || '選擇左邊的資料夾'}</h2>
              {activeNode && (
                <div className="muted small">
                  {activeNode.count} 個檔案 · {formatBytes(activeNode.bytes)}
                </div>
              )}
            </div>
            {active && editable && (
              <button
                className="btn sm"
                onClick={() => {
                  setRename(active);
                  setNewPath(active);
                }}
              >
                改名／搬移資料夾
              </button>
            )}
          </div>
          {!active ? (
            <Empty title="選擇資料夾">點選資料夾查看裡面的檔案。</Empty>
          ) : files.loading && !files.data ? (
            <Loading />
          ) : !files.data?.items.length ? (
            <Empty title="這一層沒有檔案">檔案在子資料夾裡。</Empty>
          ) : (
            <ul className="list">
              {files.data.items.map((f) => (
                <li key={f.id}>
                  <FileRow f={f} selecting={false} selected={false} onToggle={() => {}} onOpen={() => setOpenFile(f.id)} draggable={editable} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {openFile != null && <FileSheet id={openFile} folders={folderList} onClose={() => setOpenFile(null)} onChanged={refresh} />}
      {rename && (
        <Sheet
          title="資料夾改名或搬移"
          onClose={() => setRename(null)}
          actions={
            <>
              <button className="btn" onClick={() => setRename(null)}>
                取消
              </button>
              <button className="btn primary" disabled={!newPath.trim() || newPath === rename} onClick={doRename}>
                套用
              </button>
            </>
          }
        >
          <label className="field">
            <span>新路徑</span>
            <input className="input" value={newPath} onChange={(e) => setNewPath(e.target.value)} autoFocus />
            <small>例如把「會議紀錄」改成「行政/會議紀錄」就是搬到「行政」底下。雲端上的資料夾、檔案紀錄、指向這裡的規則會一起更新，之後可以復原。</small>
          </label>
        </Sheet>
      )}
    </>
  );
}
