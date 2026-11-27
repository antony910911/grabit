import { useEffect, useState } from 'react';
import { api, type Group, type Project, type Rule, type Suggestion } from '../api';
import { ErrorBox, Icon, Loading, Sheet, Switch } from '../components';
import { ask, canEdit, useLoad, useMe, useToast } from '../lib';

const MATCH_LABEL: Record<Rule['match_type'], string> = {
  keywords: '檔名包含關鍵字',
  extension: '副檔名',
  regex: '正規表示式',
  any: '不限檔名（只看群組）',
};

const PATH_VARS = ['{group}', '{yyyy}', '{MM}', '{dd}', '{sender}', '{ext}'];
const NAME_VARS = ['{yyyyMMdd}', '{name}', '{sender}', '{group}', '{HHmmss}'];

type Draft = Omit<Rule, 'id' | 'enabled'> & { id?: number; enabled: boolean };

const EMPTY: Draft = { name: '', priority: 100, match_type: 'keywords', pattern: '', group_id: null, target_path: '', rename_template: null, enabled: true, project_id: null, tags: null };

function Suggestions({ onAccepted }: { onAccepted: () => void }) {
  const toast = useToast();
  const { data, reload } = useLoad(() => api<{ items: Suggestion[] }>('/suggestions'), []);
  if (!data?.items.length) return null;
  const act = async (s: Suggestion, kind: 'accept' | 'dismiss') => {
    try {
      await api(`/suggestions/${s.id}/${kind}`, { method: 'POST', json: {} });
      toast(kind === 'accept' ? '已建立規則' : '已略過');
      reload();
      if (kind === 'accept') onAccepted();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-head">
        <h2>
          <span style={{ display: 'inline-block', width: 18, height: 18, verticalAlign: -3, color: 'var(--accent)' }}>
            <Icon name="ai" />
          </span>{' '}
          從你的整理學到的規則
        </h2>
      </div>
      <ul className="list">
        {data.items.map((s) => (
          <li key={s.id} className="rule-line">
            <div className="grow">
              <div>
                檔名含「<strong>{s.pattern}</strong>」→ <strong>{s.target_path}</strong>
              </div>
              <div className="muted small">
                依據你手動搬移的 {s.support} 個檔案{s.conflicts ? `（另有 ${s.conflicts} 個放在別處）` : ''}：{s.examples.slice(0, 3).join('、')}
              </div>
            </div>
            <button className="btn sm" onClick={() => act(s, 'dismiss')}>
              略過
            </button>
            <button className="btn sm primary" onClick={() => act(s, 'accept')}>
              建立規則
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function groupLabel(groups: Group[] | undefined, id: string | null) {
  if (!id) return '不限群組';
  const g = groups?.find((x) => x.id === id);
  return g ? g.alias || g.name || id.slice(0, 10) : '（已移除的群組）';
}

export function Rules() {
  const toast = useToast();
  const me = useMe();
  const editable = canEdit(me);
  const rules = useLoad(() => api<{ items: Rule[] }>('/rules'), []);
  const groups = useLoad(() => api<{ items: Group[] }>('/groups'), []);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [reapply, setReapply] = useState(false);
  const list = rules.data?.items ?? [];

  const move = async (i: number, dir: -1 | 1) => {
    const next = [...list];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    rules.setData({ items: next });
    try {
      await api('/rules/reorder', { method: 'POST', json: { ids: next.map((r) => r.id) } });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
    rules.reload();
  };

  const toggle = async (r: Rule, enabled: boolean) => {
    try {
      await api(`/rules/${r.id}`, { method: 'PUT', json: { ...r, enabled } });
      rules.reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>分類規則</h1>
          <p>由上而下比對，第一條符合的規則決定存放位置</p>
        </div>
        {editable && <div className="row">
          <button className="btn sm" onClick={() => setReapply(true)}>
            重新套用規則
          </button>
          <button className="btn sm primary" onClick={() => setEditing({ ...EMPTY, priority: (list.length + 1) * 10 })}>
            <Icon name="plus" />
            新增規則
          </button>
        </div>}
      </div>
      {editable && <Suggestions onAccepted={rules.reload} />}

      <div className="grid-2">
        <div className="card">
          {rules.error && <ErrorBox message={rules.error} onRetry={rules.reload} />}
          {rules.loading && !rules.data ? (
            <Loading />
          ) : list.length === 0 ? (
            <div className="empty">
              <h3>還沒有規則</h3>
              沒有規則時，所有檔案都會放到「待分類/群組名稱」。
              <div style={{ marginTop: 14 }}>
                <button className="btn primary sm" onClick={() => setEditing({ ...EMPTY, priority: 10 })}>
                  建立第一條規則
                </button>
              </div>
            </div>
          ) : (
            <ul className="list">
              {list.map((r, i) => (
                <li key={r.id} className="rule-line" style={{ opacity: r.enabled ? 1 : 0.55 }}>
                  <div className="order">
                    <button className="btn ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="上移">
                      <Icon name="up" />
                    </button>
                    <button className="btn ghost" disabled={i === list.length - 1} onClick={() => move(i, 1)} aria-label="下移">
                      <Icon name="down" />
                    </button>
                  </div>
                  <button className="item grow" style={{ padding: 0, background: 'none' }} onClick={() => setEditing({ ...r, enabled: !!r.enabled })}>
                    <div className="grow">
                      <div className="title">{r.name}</div>
                      <div className="meta">
                        {r.match_type === 'any' ? MATCH_LABEL.any : `${MATCH_LABEL[r.match_type]}：${r.pattern}`}
                        {r.group_id ? ` · ${groupLabel(groups.data?.items, r.group_id)}` : ''}
                      </div>
                      <div className="meta">
                        → {r.target_path}
                        {r.tags ? ` · #${r.tags}` : ''}
                      </div>
                    </div>
                  </button>
                  <Switch checked={!!r.enabled} onChange={(v) => toggle(r, v)} label={`啟用「${r.name}」`} />
                </li>
              ))}
              <li className="rule-line muted small">
                <div className="grow">沒有符合任何規則 → 待分類/{'{group}'}</div>
              </li>
            </ul>
          )}
        </div>
        <Simulator groups={groups.data?.items ?? []} />
      </div>

      {editing && (
        <RuleEditor
          draft={editing}
          groups={groups.data?.items ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            rules.reload();
          }}
        />
      )}
      {reapply && <Reapply onClose={() => setReapply(false)} />}
    </>
  );
}

interface TestResult {
  rule: { id: number; name: string } | null;
  fullPath: string;
  unsorted: boolean;
  storage: string;
  project: string | null;
  tags: string[];
}

function Simulator({ groups, draft, compact, fixedGroupId }: { groups: Group[]; draft?: Draft; compact?: boolean; fixedGroupId?: string | null }) {
  const [pickedGroup, setGroupId] = useState('');
  const groupId = compact ? fixedGroupId ?? '' : pickedGroup;
  const [fileName, setFileName] = useState('20261127_Farnesene_GC分析結果.xlsx');
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!fileName.trim()) return setResult(null);
    const t = setTimeout(() => {
      api<TestResult>('/rules/test', { method: 'POST', json: { fileName, groupId, draft } })
        .then((r) => (setResult(r), setError(null)))
        .catch((e: Error) => setError(e.message));
    }, 250);
    return () => clearTimeout(t);
  }, [fileName, groupId, draft]);

  return (
    <div className={compact ? '' : 'card card-pad'}>
      {!compact && (
        <>
          <h2>規則模擬器</h2>
          <p className="muted small" style={{ margin: '4px 0 14px' }}>
            輸入檔名，看看會被分到哪裡（不會真的搬移檔案）
          </p>
          <label className="field">
            <span>來源群組</span>
            <select className="select" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              <option value="">（任一群組）</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.alias || g.name || g.id.slice(0, 10)}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <label className="field">
        <span>{compact ? '試試看：輸入檔名' : '原始檔名'}</span>
        <input className="input" value={fileName} onChange={(e) => setFileName(e.target.value)} />
      </label>
      {error && <div className="result" style={{ color: 'var(--danger)' }}>{error}</div>}
      {result && !error && (
        <div className="result">
          <div className="row" style={{ marginBottom: 6 }}>
            <strong>分類結果</strong>
            {result.unsorted ? <span className="badge warn">沒有規則符合</span> : <span className="badge ok">成功比對</span>}
          </div>
          <div className="path">{result.fullPath}</div>
          <div className="muted small" style={{ marginTop: 4 }}>
            空間：{result.storage}
            {result.rule ? ` · 觸發規則：${result.rule.name}` : ''}
            {result.project ? ` · 專案：${result.project}` : ''}
            {result.tags.length ? ` · 標籤：${result.tags.join('、')}` : ''}
          </div>
          {result.unsorted && <div className="muted small">若有啟用 AI，實際收到檔案時會再讀取內容判斷</div>}
        </div>
      )}
    </div>
  );
}

function RuleEditor({ draft, groups, onClose, onSaved }: { draft: Draft; groups: Group[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const projects = useLoad(() => api<{ items: Project[] }>('/projects'), []);
  const [d, setD] = useState<Draft>(draft);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const [testDraft, setTestDraft] = useState<Draft | undefined>(undefined);

  // 規則內容有變時，延遲更新模擬器（避免每打一個字就送出）
  useEffect(() => {
    const valid = d.name.trim() && d.target_path.trim() && (d.match_type === 'any' || d.pattern.trim());
    const t = setTimeout(() => setTestDraft(valid ? d : undefined), 300);
    return () => clearTimeout(t);
  }, [d]);

  const save = async () => {
    setBusy(true);
    try {
      if (d.id) await api(`/rules/${d.id}`, { method: 'PUT', json: d });
      else await api('/rules', { method: 'POST', json: d });
      toast('規則已儲存');
      onSaved();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!d.id || !(await ask(`確定刪除規則「${d.name}」？已歸檔的檔案不會被移動。`))) return;
    try {
      await api(`/rules/${d.id}`, { method: 'DELETE' });
      toast('規則已刪除');
      onSaved();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const insert = (k: 'target_path' | 'rename_template', v: string) => set(k, `${d[k] ?? ''}${v}`);
  const placeholder: Record<Rule['match_type'], string> = {
    keywords: 'Farnesene, GC, HPLC',
    extension: 'pdf, docx',
    regex: '^INV-\\d+',
    any: '',
  };

  return (
    <Sheet
      title={d.id ? '編輯規則' : '新增規則'}
      onClose={onClose}
      actions={
        <>
          {d.id && (
            <button className="btn danger" onClick={remove} style={{ marginRight: 'auto' }}>
              刪除
            </button>
          )}
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy} onClick={save}>
            {busy ? '儲存中…' : '儲存'}
          </button>
        </>
      }
    >
      <label className="field">
        <span>規則名稱</span>
        <input className="input" value={d.name} onChange={(e) => set('name', e.target.value)} placeholder="例：分析數據" autoFocus />
      </label>
      <label className="field">
        <span>比對方式</span>
        <select className="select" value={d.match_type} onChange={(e) => set('match_type', e.target.value as Rule['match_type'])}>
          {Object.entries(MATCH_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      {d.match_type !== 'any' && (
        <label className="field">
          <span>{d.match_type === 'keywords' ? '關鍵字' : d.match_type === 'extension' ? '副檔名' : '正規表示式'}</span>
          <input className="input" value={d.pattern} onChange={(e) => set('pattern', e.target.value)} placeholder={placeholder[d.match_type]} />
          <small>{d.match_type === 'regex' ? '不分大小寫，比對完整檔名' : '多個用逗號或頓號分隔，符合任一個即可；不分大小寫'}</small>
        </label>
      )}
      <label className="field">
        <span>來源群組</span>
        <select className="select" value={d.group_id ?? ''} onChange={(e) => set('group_id', e.target.value || null)}>
          <option value="">不限群組</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.alias || g.name || g.id.slice(0, 10)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>存到資料夾</span>
        <input className="input" value={d.target_path} onChange={(e) => set('target_path', e.target.value)} placeholder="Farnesene/分析數據/{yyyy}" />
        <div className="chips">
          {PATH_VARS.map((v) => (
            <button type="button" key={v} className="chip" onClick={() => insert('target_path', v)}>
              {v}
            </button>
          ))}
        </div>
      </label>
      <label className="field">
        <span>自動改名（選填）</span>
        <input className="input" value={d.rename_template ?? ''} onChange={(e) => set('rename_template', e.target.value || null)} placeholder="留空 = 保留原檔名，例：{yyyyMMdd}_{name}" />
        <div className="chips">
          {NAME_VARS.map((v) => (
            <button type="button" key={v} className="chip" onClick={() => insert('rename_template', v)}>
              {v}
            </button>
          ))}
        </div>
        <small>副檔名會自動補上</small>
      </label>
      <label className="field">
        <span>歸入專案（選填）</span>
        <select className="select" value={d.project_id ?? ''} onChange={(e) => set('project_id', e.target.value ? Number(e.target.value) : null)}>
          <option value="">不指定</option>
          {projects.data?.items.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>加上標籤（選填）</span>
        <input className="input" value={d.tags ?? ''} onChange={(e) => set('tags', e.target.value || null)} placeholder="例：GC 分析, 數據" />
        <small>多個用逗號分隔</small>
      </label>
      <label className="field check" style={{ marginTop: 16 }}>
        <Switch checked={d.enabled} onChange={(v) => set('enabled', v)} label="啟用" />
        啟用這條規則
      </label>
      <div className="field" style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
        <Simulator groups={groups} draft={testDraft} compact fixedGroupId={d.group_id} />
      </div>
    </Sheet>
  );
}

interface Change {
  id: number;
  name: string;
  from: string;
  to: string;
  rule: string | null;
}

function Reapply({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [scope, setScope] = useState<'unsorted' | 'all'>('unsorted');
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setChanges(null);
    api<{ changes: Change[] }>('/files/reapply', { method: 'POST', json: { scope, dryRun: true } })
      .then((r) => setChanges(r.changes))
      .catch((e: Error) => toast(e.message, 'error'));
  }, [scope, toast]);

  const apply = async () => {
    setBusy(true);
    try {
      const r = await api<{ moved: number; errors: string[] }>('/files/reapply', { method: 'POST', json: { scope, dryRun: false } });
      toast(r.errors.length ? `搬移 ${r.moved} 個，${r.errors.length} 個失敗` : `已搬移 ${r.moved} 個檔案`, r.errors.length ? 'error' : 'ok');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      title="重新套用規則"
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy || !changes?.length} onClick={apply}>
            {busy ? '搬移中…' : `確認搬移 ${changes?.length ?? 0} 個檔案`}
          </button>
        </>
      }
    >
      <p className="muted small" style={{ marginTop: 0 }}>
        修改規則後，可以把舊檔案依新規則重新整理。先預覽，確認後才會實際搬移。手動調整過的檔案不會被搬動。
      </p>
      <div className="tabs">
        <button className={`tab ${scope === 'unsorted' ? 'active' : ''}`} onClick={() => setScope('unsorted')}>
          只處理待分類
        </button>
        <button className={`tab ${scope === 'all' ? 'active' : ''}`} onClick={() => setScope('all')}>
          所有已歸檔檔案
        </button>
      </div>
      {changes === null ? (
        <Loading />
      ) : changes.length === 0 ? (
        <div className="empty">沒有需要搬移的檔案</div>
      ) : (
        <ul className="list card" style={{ maxHeight: '40dvh', overflow: 'auto' }}>
          {changes.map((c) => (
            <li key={c.id} style={{ padding: '10px 14px' }}>
              <div className="title" style={{ fontWeight: 600, wordBreak: 'break-all' }}>{c.name}</div>
              <div className="small muted" style={{ wordBreak: 'break-all' }}>
                {c.from} → <span style={{ color: 'var(--text)' }}>{c.to}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}
