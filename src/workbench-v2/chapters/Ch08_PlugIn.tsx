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
    <section id="ch8" class="chapter" data-numeral="08" ref={ref}>
      <span class="overline">Plug in</span>
      <h2 style="margin-top:var(--space-4)">One snippet per editor.</h2>
      <p class="lead">Click any card to reveal the snippet, then copy.</p>
      <div class="split-2" style="margin-top:var(--space-4)">
        {SNIPPETS.map((s) => {
          const open = expanded === s.id;
          return (
            <div key={s.id} class="card" style="padding:0;overflow:hidden">
              <button
                style="width:100%;text-align:left;border:0;cursor:pointer;background:transparent;color:var(--paper-0);padding:14px 16px;font-family:var(--font-sans)"
                onClick={() => setExpanded(open ? null : s.id)}
              >
                <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px">
                  <strong
                    style="font-family:var(--font-display);font-weight:500;font-size:18px"
                  >
                    {s.name}
                  </strong>
                  <span style="color:var(--paper-3);font-family:var(--font-mono);font-size:11px">
                    {open ? '−' : '+'}
                  </span>
                </div>
                <div style="color:var(--paper-3);font-size:var(--fs-overline);margin-top:4px;letter-spacing:0.08em">
                  <span class="code">{s.configPath}</span>
                </div>
              </button>
              {open && (
                <div style="padding:0 16px 14px">
                  <pre>{s.body}</pre>
                  <button
                    class="primary"
                    style="margin-top:var(--space-3)"
                    onClick={() => {
                      navigator.clipboard
                        .writeText(s.body)
                        .then(() => pushToast(`Copied ${s.name} snippet`, 'good'))
                        .catch(() => pushToast('Copy failed', 'bad'));
                    }}
                  >
                    Copy snippet
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
