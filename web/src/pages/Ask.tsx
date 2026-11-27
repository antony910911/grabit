import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { Icon } from '../components';
import { FileSheet } from '../FileSheet';
import { Link, useMe } from '../lib';

interface Turn {
  q: string;
  a?: string;
  files?: { id: number; name: string; folder_path: string; group_name: string }[];
  error?: string;
}

const EXAMPLES = ['上個月酵母研發群組有哪些 GC 分析結果？', '找出所有和 Farnesene 有關的期末報告', '最近一次的 BMP 實驗數據放在哪裡？', '有沒有設備採購的報價單？'];

function renderAnswer(text: string, names: Map<number, string>, open: (id: number) => void): ReactNode[] {
  return text.split(/(\[#\d+\])/g).map((part, i) => {
    const m = part.match(/^\[#(\d+)\]$/);
    if (!m) return part;
    const id = Number(m[1]);
    return (
      <button key={i} className="cite" onClick={() => open(id)} title={names.get(id)}>
        #{id}
      </button>
    );
  });
}

export function Ask() {
  const me = useMe();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns]);

  const ask = async (question: string) => {
    if (!question.trim() || busy) return;
    setInput('');
    setBusy(true);
    setTurns((t) => [...t, { q: question }]);
    try {
      const r = await api<{ answer: string; files: Turn['files'] }>('/ask', { method: 'POST', json: { question } });
      setTurns((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, a: r.answer, files: r.files } : x)));
    } catch (e) {
      setTurns((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, error: (e as Error).message } : x)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>問 AI</h1>
          <p>用一句話找檔案、問內容。只會搜尋你有權限看到的群組。</p>
        </div>
      </div>
      {me && !me.aiAvailable && (
        <div className="notice warn">
          AI 功能尚未啟用。管理員需要設定 ANTHROPIC_API_KEY，並在 <Link to="/settings">系統設定</Link> 開啟 AI。
        </div>
      )}
      <div className="chat" style={{ marginBottom: 16 }}>
        {turns.length === 0 && (
          <div className="card card-pad">
            <div className="row" style={{ marginBottom: 10, color: 'var(--accent)' }}>
              <span style={{ width: 20, height: 20 }}>
                <Icon name="ai" />
              </span>
              <strong>可以這樣問</strong>
            </div>
            <div className="examples">
              {EXAMPLES.map((e) => (
                <button key={e} className="btn sm" onClick={() => ask(e)}>
                  {e}
                </button>
              ))}
            </div>
          </div>
        )}
        {turns.map((t, i) => {
          const names = new Map((t.files ?? []).map((f) => [f.id, f.name]));
          return (
            <div key={i} className="chat">
              <div className="bubble q">{t.q}</div>
              {t.a && (
                <div className="bubble a">
                  {renderAnswer(t.a, names, setOpenId)}
                  {t.files && t.files.length > 0 && (
                    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                      {t.files.map((f) => (
                        <div key={f.id} className="small">
                          <button className="cite" onClick={() => setOpenId(f.id)}>
                            #{f.id}
                          </button>{' '}
                          {f.name} <span className="muted">· {f.folder_path}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {t.error && <div className="bubble a" style={{ color: 'var(--danger)' }}>{t.error}</div>}
              {!t.a && !t.error && (
                <div className="bubble a muted">
                  <span className="spinner" style={{ display: 'inline-block', verticalAlign: -4, marginRight: 8 }} />
                  搜尋檔案中…
                </div>
              )}
            </div>
          );
        })}
        <div ref={end} />
      </div>
      <div className="ask-bar">
        <textarea
          rows={1}
          placeholder="例如：上個月的 GC 分析結果有哪些？"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void ask(input);
            }
          }}
        />
        <button className="btn primary icon" style={{ width: 44, alignSelf: 'flex-end' }} disabled={busy || !input.trim()} onClick={() => ask(input)} aria-label="送出">
          <Icon name="send" />
        </button>
      </div>
      {openId != null && <FileSheet id={openId} folders={[]} onClose={() => setOpenId(null)} onChanged={() => {}} />}
    </>
  );
}
