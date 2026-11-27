// 分類規則：用白話描述「什麼檔案 → 放到哪裡」，編輯時一步一步問
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { api, type Group, type Project, type Rule, type Suggestion } from '../api';
import { Empty, ErrorBox, Icon, Loading, ProjectBadge, Sheet, Switch, TagChip } from '../components';
import { ask, canEdit, useLoad, useMe, useToast } from '../lib';

// ---------------------------------------------------------------- 規則 ↔ 白話

const FILE_TYPES: { key: string; label: string; exts: string[] }[] = [
  { key: 'pdf', label: 'PDF', exts: ['pdf'] },
  { key: 'word', label: 'Word', exts: ['doc', 'docx'] },
  { key: 'excel', label: 'Excel／CSV', exts: ['xls', 'xlsx', 'csv'] },
  { key: 'ppt', label: '簡報', exts: ['ppt', 'pptx'] },
  { key: 'image', label: '照片', exts: ['jpg', 'jpeg', 'png', 'heic'] },
  { key: 'video', label: '影片', exts: ['mp4', 'mov'] },
  { key: 'zip', label: '壓縮檔', exts: ['zip', 'rar', '7z'] },
];

type Split = 'none' | 'year' | 'month' | 'group' | 'sender' | 'custom';
const SPLITS: { key: Split; label: string; suffix: string; example: (g: string) => string }[] = [
  { key: 'none', label: '不用', suffix: '', example: () => '' },
  { key: 'year', label: '每年一個資料夾', suffix: '{yyyy}', example: () => String(new Date().getFullYear()) },
  { key: 'month', label: '每個月一個資料夾', suffix: '{yyyy}-{MM}', example: () => `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}` },
  { key: 'group', label: '每個群組一個資料夾', suffix: '{group}', example: (g) => g || '群組名稱' },
  { key: 'sender', label: '每個傳送者一個資料夾', suffix: '{sender}', example: () => '傳送者' },
];

type Rename = 'keep' | 'date' | 'date_sender' | 'custom';
const RENAMES: { key: Rename; label: string; template: string | null; example: string }[] = [
  { key: 'keep', label: '保留原本的檔名', template: null, example: '報告.pdf' },
  { key: 'date', label: '前面加上收到的日期', template: '{yyyyMMdd}_{name}', example: '20261127_報告.pdf' },
  { key: 'date_sender', label: '前面加上日期與傳送者', template: '{yyyyMMdd}_{sender}_{name}', example: '20261127_小明_報告.pdf' },
];

const splitList = (s: string | null | undefined) =>
  (s ?? '')
    .split(/[,，、;；\n]+/)
    .map((x) => x.trim())
    .filter(Boolean);

function parseTarget(path: string): { base: string; split: Split } {
  for (const s of SPLITS) {
    if (s.suffix && path.endsWith(`/${s.suffix}`)) {
      const base = path.slice(0, -s.suffix.length - 1);
      if (!base.includes('{')) return { base, split: s.key };
    }
  }
  return path.includes('{') ? { base: path, split: 'custom' } : { base: path, split: 'none' };
}

function typesFromPattern(pattern: string): string[] {
  const exts = splitList(pattern).map((e) => e.replace(/^\./, '').toLowerCase());
  return FILE_TYPES.filter((t) => t.exts.some((e) => exts.includes(e))).map((t) => t.key);
}

const pretty = (path: string) => path.split('/').filter(Boolean).join(' › ');

function describeTarget(path: string): string {
  const { base, split } = parseTarget(path);
  if (split === 'custom') return pretty(path.replace(/\{yyyy\}/g, '年份').replace(/\{MM\}/g, '月份').replace(/\{group\}/g, '群組').replace(/\{sender\}/g, '傳送者').replace(/\{dd\}/g, '日'));
  const s = SPLITS.find((x) => x.key === split)!;
  return `${pretty(base)}${s.suffix ? `（${s.label}）` : ''}`;
}

function describeMatch(r: Pick<Rule, 'match_type' | 'pattern'>): string {
  if (r.match_type === 'any') return '所有檔案';
  if (r.match_type === 'regex') return `檔名符合進階條件「${r.pattern}」`;
  if (r.match_type === 'extension') {
    const types = typesFromPattern(r.pattern);
    return types.length ? `${types.map((k) => FILE_TYPES.find((t) => t.key === k)!.label).join('、')} 檔案` : `副檔名是 ${r.pattern}`;
  }
  const words = splitList(r.pattern);
  return `檔名有${words.map((w) => `「${w}」`).join('或')}`;
}

// ---------------------------------------------------------------- 小元件

/** 輸入文字後按 Enter 或逗號變成一顆一顆的標籤 */
function ChipInput({ values, onChange, placeholder }: { values: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [text, setText] = useState('');
  const commit = () => {
    const add = splitList(text).filter((w) => !values.includes(w));
    if (add.length) onChange([...values, ...add]);
    setText('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Backspace' && !text && values.length) onChange(values.slice(0, -1));
  };
  return (
    <div className="chip-input" onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement)?.focus()}>
      {values.map((v) => (
        <TagChip key={v} tag={{ name: v }} onRemove={() => onChange(values.filter((x) => x !== v))} />
      ))}
      <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} onBlur={commit} placeholder={values.length ? '' : placeholder} />
    </div>
  );
}

function Choice<T extends string>({ value, options, onChange }: { value: T; options: { key: T; label: string; hint?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="choices">
      {options.map((o) => (
        <button type="button" key={o.key} className={`choice ${value === o.key ? 'on' : ''}`} onClick={() => onChange(o.key)} aria-pressed={value === o.key}>
          <strong>{o.label}</strong>
          {o.hint && <span>{o.hint}</span>}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- 頁面

export function Rules() {
  const toast = useToast();
  const me = useMe();
  const editable = canEdit(me);
  const rules = useLoad(() => api<{ items: Rule[] }>('/rules'), []);
  const groups = useLoad(() => api<{ items: Group[] }>('/groups'), []);
  const projects = useLoad(() => api<{ items: Project[] }>('/projects'), []);
  const [editing, setEditing] = useState<Partial<Rule> | null>(null);
  const [reapply, setReapply] = useState(false);
  const list = rules.data?.items ?? [];
  const groupName = (id: string | null) => {
    const g = groups.data?.items.find((x) => x.id === id);
    return g ? g.alias || g.name : '（已移除的群組）';
  };

  const move = async (i: number, dir: -1 | 1) => {
    const next = [...list];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    rules.setData({ items: next });
    await api('/rules/reorder', { method: 'POST', json: { ids: next.map((r) => r.id) } }).catch((e: Error) => toast(e.message, 'error'));
    rules.reload();
  };
  const toggle = async (r: Rule, enabled: boolean) => {
    await api(`/rules/${r.id}`, { method: 'PUT', json: { ...r, enabled } }).catch((e: Error) => toast(e.message, 'error'));
    rules.reload();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>分類規則</h1>
          <p>告訴 GrabIt「什麼樣的檔案要放到哪裡」，之後收到的檔案就會自動歸位</p>
        </div>
        {editable && (
          <div className="row">
            <button className="btn sm" onClick={() => setReapply(true)}>
              套用到舊檔案
            </button>
            <button className="btn sm primary" onClick={() => setEditing({})}>
              <Icon name="plus" />
              新增規則
            </button>
          </div>
        )}
      </div>

      <div className="flow">
        <div>
          <b>1</b>收到檔案
        </div>
        <i>→</i>
        <div>
          <b>2</b>由上往下比對規則，<strong>第一條符合的</strong>決定放哪裡
        </div>
        <i>→</i>
        <div>
          <b>3</b>都不符合：有開 AI 就讀內容判斷，否則放「待分類」
        </div>
      </div>

      {editable && <Suggestions onAccepted={rules.reload} />}

      <div className="grid-2">
        <div>
          {rules.error && <ErrorBox message={rules.error} onRetry={rules.reload} />}
          {rules.loading && !rules.data ? (
            <Loading />
          ) : list.length === 0 ? (
            <div className="card">
              <Empty title="還沒有規則">
                例如：「檔名有『報價』的，放到 行政 › 採購」。
                {editable && (
                  <div style={{ marginTop: 14 }}>
                    <button className="btn primary sm" onClick={() => setEditing({})}>
                      建立第一條規則
                    </button>
                  </div>
                )}
              </Empty>
            </div>
          ) : (
            <ol className="rule-list">
              {list.map((r, i) => {
                const project = projects.data?.items.find((p) => p.id === r.project_id);
                return (
                  <li key={r.id} className={`rule-card ${r.enabled ? '' : 'off'}`}>
                    <span className="rule-no">{i + 1}</span>
                    <button className="rule-body" onClick={() => editable && setEditing(r)} disabled={!editable}>
                      <span className="rule-name">{r.name}</span>
                      <span className="rule-sentence">
                        <em>如果</em> {describeMatch(r)}
                        {r.group_id ? `，而且來自「${groupName(r.group_id)}」` : ''}
                      </span>
                      <span className="rule-sentence">
                        <em>就放到</em> <strong>{describeTarget(r.target_path)}</strong>
                      </span>
                      {(project || r.tags || r.rename_template) && (
                        <span className="tags" style={{ marginTop: 4 }}>
                          {project && <ProjectBadge name={project.name} color={project.color} />}
                          {splitList(r.tags).map((t) => (
                            <TagChip key={t} tag={{ name: t }} />
                          ))}
                          {r.rename_template && <span className="muted small">・自動改檔名</span>}
                        </span>
                      )}
                    </button>
                    {editable && (
                      <div className="rule-tools">
                        <Switch checked={!!r.enabled} onChange={(v) => toggle(r, v)} label={`啟用「${r.name}」`} />
                        <div className="order">
                          <button className="btn ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="往上移（更優先）" title="往上移（更優先）">
                            <Icon name="up" />
                          </button>
                          <button className="btn ghost" disabled={i === list.length - 1} onClick={() => move(i, 1)} aria-label="往下移" title="往下移">
                            <Icon name="down" />
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
              <li className="rule-card fallback">
                <span className="rule-no">…</span>
                <span className="rule-body">
                  <span className="rule-sentence">
                    <em>都不符合</em> 放到「待分類 › 群組名稱」，或群組設定的資料夾
                  </span>
                </span>
              </li>
            </ol>
          )}
        </div>
        <Simulator groups={groups.data?.items ?? []} />
      </div>

      {editing && (
        <RuleEditor
          rule={editing}
          groups={groups.data?.items ?? []}
          projects={projects.data?.items ?? []}
          nextPriority={(list.length + 1) * 10}
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
                檔名有「<strong>{s.pattern}</strong>」的，放到 <strong>{describeTarget(s.target_path)}</strong>
              </div>
              <div className="muted small">
                因為你手動把 {s.support} 個這樣的檔案搬到那裡：{s.examples.slice(0, 3).join('、')}
              </div>
            </div>
            <button className="btn sm" onClick={() => act(s, 'dismiss')}>
              不用
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

interface TestResult {
  rule: { id: number; name: string } | null;
  fullPath: string;
  folderPath: string;
  storedName: string;
  unsorted: boolean;
  storage: string;
  project: string | null;
  tags: string[];
}

function Simulator({ groups, draft, compact, fixedGroupId }: { groups: Group[]; draft?: Omit<Partial<Rule>, "enabled"> & { enabled?: boolean }; compact?: boolean; fixedGroupId?: string | null }) {
  const [picked, setPicked] = useState('');
  const groupId = compact ? fixedGroupId ?? '' : picked;
  const [fileName, setFileName] = useState('20261127_Farnesene_GC分析結果.xlsx');
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!fileName.trim()) return setResult(null);
    const t = setTimeout(() => {
      api<TestResult>('/rules/test', { method: 'POST', json: { fileName, groupId, draft } })
        .then((r) => (setResult(r), setError(null)))
        .catch((e: Error) => (setResult(null), setError(e.message)));
    }, 250);
    return () => clearTimeout(t);
  }, [fileName, groupId, draft]);

  const body = (
    <>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <input className="input grow" value={fileName} onChange={(e) => setFileName(e.target.value)} aria-label="試試看的檔名" placeholder="輸入一個檔名試試看" />
        {!compact && (
          <select className="select" style={{ width: 'auto', maxWidth: 150 }} value={picked} onChange={(e) => setPicked(e.target.value)} aria-label="來自哪個群組">
            <option value="">任何群組</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.alias || g.name || g.id.slice(0, 8)}
              </option>
            ))}
          </select>
        )}
      </div>
      {error && !compact && <div className="result" style={{ color: 'var(--danger)' }}>{error}</div>}
      {result && (
        <div className={`result ${result.unsorted ? 'warn' : 'ok'}`}>
          <div className="small muted">{result.unsorted ? '沒有規則符合，會放到' : `符合「${result.rule?.name}」，會放到`}</div>
          <div className="path">{pretty(result.folderPath)}</div>
          <div className="small">
            檔名：{result.storedName}
            {result.project ? `・專案：${result.project}` : ''}
            {result.tags.length ? `・標籤：${result.tags.join('、')}` : ''}
          </div>
        </div>
      )}
    </>
  );
  if (compact) return body;
  return (
    <div className="card card-pad" style={{ alignSelf: 'start' }}>
      <h2>試試看</h2>
      <p className="muted small" style={{ margin: '4px 0 12px' }}>
        輸入一個檔名，看看會被放到哪裡（不會真的搬動檔案）
      </p>
      {body}
    </div>
  );
}

function RuleEditor({ rule, groups, projects, nextPriority, onClose, onSaved }: { rule: Partial<Rule>; groups: Group[]; projects: Project[]; nextPriority: number; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const folders = useLoad(() => api<{ items: { path: string }[] }>('/folders'), []);
  const folderOptions = useMemo(() => [...new Set((folders.data?.items ?? []).map((f) => f.path).filter((p) => !p.startsWith('待分類') && !p.startsWith('_')))], [folders.data]);

  const initialTarget = parseTarget(rule.target_path ?? '');
  const initialRename = RENAMES.find((r) => r.template === (rule.rename_template ?? null))?.key ?? (rule.rename_template ? 'custom' : 'keep');
  const [kind, setKind] = useState<'keywords' | 'types' | 'all' | 'regex'>(
    rule.match_type === 'extension' ? 'types' : rule.match_type === 'any' ? 'all' : rule.match_type === 'regex' ? 'regex' : 'keywords',
  );
  const [words, setWords] = useState<string[]>(rule.match_type === 'keywords' || !rule.match_type ? splitList(rule.pattern) : []);
  const [types, setTypes] = useState<string[]>(rule.match_type === 'extension' ? typesFromPattern(rule.pattern ?? '') : []);
  const [regex, setRegex] = useState(rule.match_type === 'regex' ? rule.pattern ?? '' : '');
  const [groupId, setGroupId] = useState<string>(rule.group_id ?? '');
  const [base, setBase] = useState(initialTarget.base);
  const [split, setSplit] = useState<Split>(initialTarget.split);
  const [rename, setRename] = useState<Rename>(initialRename);
  const [customRename, setCustomRename] = useState(rule.rename_template ?? '');
  const [projectId, setProjectId] = useState<number | null>(rule.project_id ?? null);
  const [tags, setTags] = useState<string[]>(splitList(rule.tags));
  const [name, setName] = useState(rule.name ?? '');
  const [enabled, setEnabled] = useState(rule.enabled === undefined ? true : !!rule.enabled);
  const [showMore, setShowMore] = useState(!!(rule.rename_template || rule.project_id || rule.tags || initialTarget.split === 'custom'));
  const [busy, setBusy] = useState(false);

  const groupLabel = groups.find((g) => g.id === groupId);
  const target = split === 'custom' ? base.trim() : [base.trim().replace(/^\/+|\/+$/g, ''), SPLITS.find((s) => s.key === split)!.suffix].filter(Boolean).join('/');
  const pattern = kind === 'keywords' ? words.join(', ') : kind === 'types' ? types.flatMap((k) => FILE_TYPES.find((t) => t.key === k)!.exts).join(', ') : kind === 'regex' ? regex : '';
  const matchType: Rule['match_type'] = kind === 'types' ? 'extension' : kind === 'all' ? 'any' : kind;
  const renameTemplate = rename === 'custom' ? customRename.trim() || null : RENAMES.find((r) => r.key === rename)!.template;
  const autoName = (kind === 'keywords' && words.length ? words.slice(0, 2).join('、') : kind === 'types' && types.length ? types.map((k) => FILE_TYPES.find((t) => t.key === k)!.label).join('、') : kind === 'all' && groupLabel ? groupLabel.alias || groupLabel.name : '新規則') + (base ? ` → ${base.split('/').pop()}` : '');

  const problem =
    kind === 'keywords' && !words.length
      ? '請至少輸入一個關鍵字'
      : kind === 'types' && !types.length
        ? '請選擇檔案類型'
        : kind === 'regex' && !regex.trim()
          ? '請輸入進階條件'
          : kind === 'all' && !groupId
            ? '「所有檔案」需要指定群組'
            : !base.trim()
              ? '請選擇或輸入要放的資料夾'
              : null;

  const draft = useMemo(
    () => (problem ? undefined : { id: rule.id, name: name || autoName, priority: rule.priority ?? nextPriority, match_type: matchType, pattern, group_id: groupId || null, target_path: target, rename_template: renameTemplate, project_id: projectId, tags: tags.join(', '), enabled }),
    [problem, rule.id, name, autoName, rule.priority, nextPriority, matchType, pattern, groupId, target, renameTemplate, projectId, tags, enabled],
  );
  const [testDraft, setTestDraft] = useState(draft);
  useEffect(() => {
    const t = setTimeout(() => setTestDraft(draft), 300);
    return () => clearTimeout(t);
  }, [draft]);

  const save = async () => {
    if (!draft) return toast(problem!, 'error');
    setBusy(true);
    try {
      if (rule.id) await api(`/rules/${rule.id}`, { method: 'PUT', json: draft });
      else await api('/rules', { method: 'POST', json: draft });
      toast('規則已儲存。之前的檔案可以按「套用到舊檔案」重新整理。');
      onSaved();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!rule.id || !(await ask(`刪除規則「${rule.name}」？已經歸檔的檔案不會被搬動。`, '刪除規則'))) return;
    await api(`/rules/${rule.id}`, { method: 'DELETE' });
    onSaved();
  };

  const splitExample = SPLITS.find((s) => s.key === split)?.example(groupLabel?.alias || groupLabel?.name || '') ?? '';
  return (
    <Sheet
      title={rule.id ? '編輯規則' : '新增規則'}
      onClose={onClose}
      actions={
        <>
          {rule.id && (
            <button className="btn danger" onClick={remove} style={{ marginRight: 'auto' }}>
              刪除
            </button>
          )}
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy || !!problem} onClick={save} title={problem ?? ''}>
            {busy ? '儲存中…' : '儲存規則'}
          </button>
        </>
      }
    >
      <ol className="steps">
        <li>
          <h3>哪些檔案？</h3>
          <Choice
            value={kind}
            onChange={setKind}
            options={[
              { key: 'keywords', label: '檔名有某些字', hint: '最常用' },
              { key: 'types', label: '某種檔案類型', hint: '例如所有 PDF' },
              { key: 'all', label: '某個群組的所有檔案' },
            ]}
          />
          {kind === 'keywords' && (
            <div className="field">
              <ChipInput values={words} onChange={setWords} placeholder="輸入關鍵字後按 Enter，例如 GC、報價" />
              <small>檔名只要有其中一個字就算符合，不分大小寫</small>
            </div>
          )}
          {kind === 'types' && (
            <div className="checks" style={{ marginTop: 10 }}>
              {FILE_TYPES.map((t) => (
                <label key={t.key} className="check">
                  <input type="checkbox" className="cb" checked={types.includes(t.key)} onChange={() => setTypes(types.includes(t.key) ? types.filter((x) => x !== t.key) : [...types, t.key])} />
                  {t.label}
                </label>
              ))}
            </div>
          )}
          {kind === 'regex' && (
            <div className="field">
              <input className="input" value={regex} onChange={(e) => setRegex(e.target.value)} placeholder="例：^INV-\d+" />
              <small>進階：正規表示式，不分大小寫</small>
            </div>
          )}
          {kind !== 'regex' && (
            <button type="button" className="link-btn small" style={{ marginTop: 8 }} onClick={() => setKind('regex')}>
              需要更複雜的條件？
            </button>
          )}
        </li>

        <li>
          <h3>只限某個群組嗎？</h3>
          <select className="select" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">不限，任何群組都適用</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                只限「{g.alias || g.name || g.id.slice(0, 8)}」
              </option>
            ))}
          </select>
        </li>

        <li>
          <h3>放到哪個資料夾？</h3>
          <input className="input" list="rule-folders" value={base} onChange={(e) => setBase(e.target.value)} placeholder="例：Farnesene/分析數據" />
          <datalist id="rule-folders">
            {folderOptions.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
          <small className="muted" style={{ display: 'block', marginTop: 5 }}>
            可以選現有的資料夾，或打一個新的名稱（用 / 分層），沒有的會自動建立
          </small>
          {split !== 'custom' && (
            <>
              <div className="small" style={{ margin: '12px 0 6px', fontWeight: 600 }}>
                裡面要再自動分子資料夾嗎？
              </div>
              <Choice value={split} onChange={setSplit} options={SPLITS.map((s) => ({ key: s.key, label: s.label }))} />
            </>
          )}
          {base.trim() && (
            <div className="result" style={{ marginTop: 10 }}>
              <span className="muted small">例如會放到：</span>
              <div className="path">{pretty([split === 'custom' ? base : base.trim(), split === 'custom' ? '' : splitExample].filter(Boolean).join('/'))}</div>
            </div>
          )}
        </li>

        <li>
          <button type="button" className="link-btn" onClick={() => setShowMore(!showMore)}>
            {showMore ? '▾' : '▸'} 自動改檔名、加入專案、加上標籤（選填）
          </button>
          {showMore && (
            <div style={{ marginTop: 10 }}>
              <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>
                檔名
              </div>
              <Choice
                value={rename}
                onChange={setRename}
                options={[...RENAMES.map((r) => ({ key: r.key, label: r.label, hint: r.example })), { key: 'custom' as Rename, label: '自訂', hint: '{yyyyMMdd} {name} {sender} {group}' }]}
              />
              {rename === 'custom' && <input className="input" style={{ marginTop: 8 }} value={customRename} onChange={(e) => setCustomRename(e.target.value)} placeholder="{yyyyMMdd}_{name}" />}
              <label className="field" style={{ marginTop: 14 }}>
                <span>同時加入專案</span>
                <select className="select" value={projectId ?? ''} onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">不指定</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="field">
                <span>同時加上標籤</span>
                <ChipInput values={tags} onChange={setTags} placeholder="輸入標籤後按 Enter" />
              </div>
              {split === 'custom' && (
                <label className="field">
                  <span>自訂資料夾路徑</span>
                  <input className="input" value={base} onChange={(e) => setBase(e.target.value)} />
                  <small>可用變數：{'{yyyy} {MM} {dd} {group} {sender}'}</small>
                </label>
              )}
            </div>
          )}
        </li>

        <li>
          <h3>確認一下</h3>
          <label className="field">
            <span>規則名稱</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={autoName} />
          </label>
          <label className="check" style={{ marginTop: 10 }}>
            <Switch checked={enabled} onChange={setEnabled} label="啟用" />
            啟用這條規則
          </label>
          <div className="field" style={{ marginTop: 12 }}>
            <span>試試看</span>
            <Simulator groups={groups} draft={testDraft} compact fixedGroupId={groupId || null} />
          </div>
        </li>
      </ol>
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
      toast(r.errors.length ? `搬移 ${r.moved} 個，${r.errors.length} 個失敗` : `已整理 ${r.moved} 個檔案，可以在「歸檔紀錄」復原`, r.errors.length ? 'error' : 'ok');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      title="把規則套用到舊檔案"
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy || !changes?.length} onClick={apply}>
            {busy ? '整理中…' : `搬移 ${changes?.length ?? 0} 個檔案`}
          </button>
        </>
      }
    >
      <p className="muted small" style={{ marginTop: 0 }}>
        規則只會自動套用在之後收到的檔案。這裡可以把之前的檔案也照現在的規則重新整理（連同專案、標籤）。先看清單，確認後才會搬動；你手動整理過的檔案不會動，也可以在「歸檔紀錄」復原。
      </p>
      <div className="tabs">
        <button className={`tab ${scope === 'unsorted' ? 'active' : ''}`} onClick={() => setScope('unsorted')}>
          只整理「待分類」
        </button>
        <button className={`tab ${scope === 'all' ? 'active' : ''}`} onClick={() => setScope('all')}>
          所有檔案
        </button>
      </div>
      {changes === null ? (
        <Loading />
      ) : changes.length === 0 ? (
        <div className="empty">目前的檔案都已經在對的位置</div>
      ) : (
        <ul className="list card" style={{ maxHeight: '40dvh', overflow: 'auto' }}>
          {changes.map((c) => (
            <li key={c.id} style={{ padding: '10px 14px' }}>
              <div style={{ fontWeight: 600, wordBreak: 'break-all' }}>{c.name}</div>
              <div className="small muted" style={{ wordBreak: 'break-all' }}>
                {pretty(c.from)} → <span style={{ color: 'var(--text)' }}>{pretty(c.to)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}
