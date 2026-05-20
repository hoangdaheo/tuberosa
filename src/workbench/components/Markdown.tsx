interface Props {
  text: string;
}

export function Markdown({ text }: Props) {
  const lines = text.split('\n');
  const blocks: Array<{ kind: 'p' | 'h' | 'li' | 'code'; content: string; level?: number }> = [];
  let inCode = false;
  let codeBuffer: string[] = [];

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith('```')) {
      if (inCode) {
        blocks.push({ kind: 'code', content: codeBuffer.join('\n') });
        codeBuffer = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuffer.push(line);
      continue;
    }
    if (line.startsWith('#')) {
      const match = /^(#{1,4})\s+(.*)$/.exec(line);
      if (match) {
        blocks.push({ kind: 'h', content: match[2], level: match[1].length });
        continue;
      }
    }
    if (/^[-*]\s+/.test(line)) {
      blocks.push({ kind: 'li', content: line.replace(/^[-*]\s+/, '') });
      continue;
    }
    if (line.trim()) {
      blocks.push({ kind: 'p', content: line });
    }
  }
  if (inCode && codeBuffer.length) {
    blocks.push({ kind: 'code', content: codeBuffer.join('\n') });
  }

  return (
    <div class="markdown">
      {blocks.map((b, i) => {
        if (b.kind === 'code') return <pre key={i}><code>{b.content}</code></pre>;
        if (b.kind === 'h') {
          const level = Math.min(4, Math.max(2, b.level ?? 2));
          if (level === 2) return <h2 key={i}>{renderInline(b.content)}</h2>;
          if (level === 3) return <h3 key={i}>{renderInline(b.content)}</h3>;
          return <h4 key={i}>{renderInline(b.content)}</h4>;
        }
        if (b.kind === 'li') return <li key={i}>{renderInline(b.content)}</li>;
        return <p key={i}>{renderInline(b.content)}</p>;
      })}
    </div>
  );
}

function renderInline(text: string) {
  const parts: Array<string | { code: string }> = [];
  const regex = /`([^`]+)`/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push({ code: match[1] });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.map((p, i) =>
    typeof p === 'string' ? <span key={i}>{p}</span> : <code key={i}>{p.code}</code>,
  );
}
