import { useEffect, useRef, useState } from 'preact/hooks';
import { observeChapter } from '../state/scrollController.js';
import { pushToast } from '../state/store.js';

interface Snippet {
  id: string;
  name: string;
  configPath: string;
  body: string;
}

const SNIPPETS: Snippet[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    configPath: 'project-scoped CLI',
    body:
      'claude mcp add --transport stdio --scope project tuberosa -- \\\n  pnpm --silent --dir <repo-path> run mcp',
  },
  {
    id: 'codex',
    name: 'Codex',
    configPath: '~/.codex/config.toml',
    body: `[mcp_servers.tuberosa]
command = "npx"
args    = ["tuberosa", "mcp"]`,
  },
  {
    id: 'cursor',
    name: 'Cursor',
    configPath: '~/.cursor/mcp.json',
    body: `{
  "mcpServers": {
    "tuberosa": {
      "command": "pnpm",
      "args": ["--dir", "<repo-path>", "run", "mcp"]
    }
  }
}`,
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    configPath: '.vscode/mcp.json',
    body: `{
  "servers": {
    "tuberosa": {
      "type": "stdio",
      "command": "pnpm",
      "args": ["--dir", "<repo-path>", "run", "mcp"]
    }
  }
}`,
  },
];

export default function Ch08_PlugIn() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => (ref.current ? observeChapter(ref.current, 8) : undefined), []);
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <section id="ch8" class="chapter" ref={ref}>
      <h2>Plug into your agent</h2>
      <p class="lead">One snippet per editor. Click a card to expand.</p>
      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:16px">
        {SNIPPETS.map((s) => {
          const open = expanded === s.id;
          return (
            <div key={s.id} class="card">
              <button
                class="ghost"
                style="width:100%;text-align:left;border:0;padding:0;cursor:pointer;background:transparent"
                onClick={() => setExpanded(open ? null : s.id)}
              >
                <strong>{s.name}</strong>
                <div style="color:var(--fg-muted);font-size:12px;margin-top:2px">
                  <span class="code">{s.configPath}</span>
                </div>
              </button>
              {open && (
                <>
                  <pre style="margin-top:8px;padding:8px;background:rgba(0,0,0,0.25);border-radius:6px;overflow:auto;font-family:var(--font-mono);font-size:12px;color:var(--fg)">
                    {s.body}
                  </pre>
                  <button
                    class="primary"
                    style="margin-top:8px"
                    onClick={() => {
                      navigator.clipboard
                        .writeText(s.body)
                        .then(() => pushToast(`Copied ${s.name} snippet`, 'good'))
                        .catch(() => pushToast('Copy failed', 'bad'));
                    }}
                  >
                    Copy
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
