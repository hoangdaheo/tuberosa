export function workbenchHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tuberosa Workbench</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f4;
      --ink: #1e2420;
      --muted: #62706a;
      --line: #d7ddd4;
      --panel: #ffffff;
      --accent: #0f766e;
      --accent-2: #334155;
      --warn: #b45309;
      --bad: #b91c1c;
      --good: #166534;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background: var(--bg);
      letter-spacing: 0;
    }

    header {
      border-bottom: 1px solid var(--line);
      background: #fbfcfa;
    }

    .shell {
      width: min(1480px, calc(100vw - 32px));
      margin: 0 auto;
    }

    .topbar {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) auto;
      gap: 16px;
      align-items: end;
      padding: 16px 0;
    }

    h1 {
      margin: 0;
      font-size: 22px;
      line-height: 1.2;
      font-weight: 700;
    }

    .subtitle {
      margin: 4px 0 0;
      color: var(--muted);
      font-size: 13px;
    }

    .controls {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: flex-end;
      align-items: end;
    }

    label {
      display: grid;
      gap: 4px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
    }

    input, textarea, select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 8px 10px;
      font: inherit;
      font-size: 14px;
      background: #fff;
      color: var(--ink);
    }

    textarea {
      min-height: 112px;
      resize: vertical;
      line-height: 1.45;
    }

    button {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 8px 12px;
      font: inherit;
      font-size: 14px;
      font-weight: 700;
      background: #fff;
      color: var(--ink);
      cursor: pointer;
    }

    button.primary {
      border-color: var(--accent);
      background: var(--accent);
      color: #fff;
    }

    button:disabled {
      opacity: 0.55;
      cursor: wait;
    }

    nav {
      display: flex;
      gap: 4px;
      padding-bottom: 10px;
    }

    .tab {
      border-color: transparent;
      background: transparent;
      color: var(--muted);
    }

    .tab.active {
      border-color: var(--accent);
      background: #e6f4f1;
      color: #0f4f48;
    }

    main {
      display: grid;
      grid-template-columns: 280px minmax(0, 1fr);
      gap: 16px;
      padding: 16px 0 28px;
    }

    aside, section.panel, .item, .result {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }

    aside {
      padding: 14px;
      align-self: start;
      position: sticky;
      top: 12px;
    }

    .view { display: none; }
    .view.active { display: block; }

    section.panel {
      padding: 16px;
      margin-bottom: 14px;
    }

    h2, h3 {
      margin: 0 0 12px;
      line-height: 1.25;
    }

    h2 { font-size: 18px; }
    h3 { font-size: 15px; }

    .grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
    }

    .grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .span-2 { grid-column: span 2; }
    .span-4 { grid-column: 1 / -1; }

    .stack {
      display: grid;
      gap: 10px;
    }

    .row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }

    .result {
      padding: 12px;
      margin-top: 12px;
    }

    .item {
      padding: 10px;
      margin: 8px 0;
    }

    .item-title {
      font-weight: 750;
      overflow-wrap: anywhere;
    }

    .muted { color: var(--muted); }
    .small { font-size: 12px; }
    .mono {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 12px;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: #f8fafc;
      font-size: 12px;
      font-weight: 700;
      color: var(--accent-2);
    }

    .ready { color: var(--good); }
    .warn { color: var(--warn); }
    .bad { color: var(--bad); }

    .metric {
      border-top: 1px solid var(--line);
      padding: 9px 0;
    }

    .metric:first-child { border-top: 0; padding-top: 0; }
    .metric strong { display: block; font-size: 20px; line-height: 1.1; }
    .metric span { color: var(--muted); font-size: 12px; }

    pre {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      margin: 0;
      padding: 10px;
      border-radius: 6px;
      border: 1px solid var(--line);
      background: #f8fafc;
      font-size: 12px;
      line-height: 1.4;
    }

    a { color: #0f766e; text-decoration: none; }
    a:hover { text-decoration: underline; }

    @media (max-width: 900px) {
      .topbar, main { grid-template-columns: 1fr; }
      aside { position: static; }
      .controls { justify-content: flex-start; }
      .grid, .grid.two { grid-template-columns: 1fr; }
      .span-2, .span-4 { grid-column: auto; }
    }
  </style>
</head>
<body>
  <header>
    <div class="shell">
      <div class="topbar">
        <div>
          <h1>Tuberosa Workbench</h1>
          <p class="subtitle">Local control plane for context fit, review queues, and session memory.</p>
        </div>
        <div class="controls">
          <label>Project <input id="projectFilter" autocomplete="off" placeholder="all"></label>
          <label>Limit <input id="limitFilter" type="number" min="1" max="100" value="10"></label>
          <label>API key <input id="apiKey" type="password" autocomplete="off" placeholder="optional"></label>
          <button id="refresh" class="primary" type="button">Refresh</button>
        </div>
      </div>
      <nav>
        <button class="tab active" data-view="start" type="button">Start Session</button>
        <button class="tab" data-view="quality" type="button">Context Quality Review</button>
        <button class="tab" data-view="memory" type="button">Memory Review</button>
      </nav>
    </div>
  </header>

  <div class="shell">
    <main>
      <aside>
        <h2>Summary</h2>
        <div id="status" class="small muted">Idle</div>
        <div id="metrics" class="stack" style="margin-top:12px"></div>
      </aside>

      <div>
        <section id="start" class="view active">
          <section class="panel">
            <h2>Start Session</h2>
            <form id="sessionForm" class="grid">
              <label class="span-4">Prompt <textarea id="prompt" required></textarea></label>
              <label>Project <input id="sessionProject" autocomplete="off"></label>
              <label>CWD <input id="cwd" autocomplete="off" placeholder="/home/nash/tuberosa"></label>
              <label>Task type
                <select id="taskType">
                  <option value="unknown">unknown</option>
                  <option value="implementation">implementation</option>
                  <option value="debugging">debugging</option>
                  <option value="refactor">refactor</option>
                  <option value="review">review</option>
                  <option value="planning">planning</option>
                  <option value="exploration">exploration</option>
                  <option value="testing">testing</option>
                </select>
              </label>
              <label>Noise
                <select id="noiseTolerance">
                  <option value="balanced">balanced</option>
                  <option value="strict">strict</option>
                </select>
              </label>
              <label>Context mode
                <select id="contextMode">
                  <option value="layered">layered</option>
                  <option value="compact">compact</option>
                </select>
              </label>
              <label>Deep context
                <select id="includeDeepContext">
                  <option value="true">include</option>
                  <option value="false">skip</option>
                </select>
              </label>
              <div class="span-2 row" style="align-self:end">
                <button class="primary" type="submit">Start</button>
              </div>
            </form>
            <div id="sessionResult"></div>
          </section>
        </section>

        <section id="quality" class="view">
          <section class="panel">
            <h2>Context Quality Review</h2>
            <div id="qualityResult"></div>
          </section>
        </section>

        <section id="memory" class="view">
          <section class="panel">
            <h2>Memory Review</h2>
            <div id="memoryResult"></div>
          </section>
        </section>
      </div>
    </main>
  </div>

  <script type="module">
    const state = {
      summary: null,
      session: null,
      contextPack: null,
    };

    const els = {
      apiKey: document.querySelector('#apiKey'),
      projectFilter: document.querySelector('#projectFilter'),
      limitFilter: document.querySelector('#limitFilter'),
      refresh: document.querySelector('#refresh'),
      status: document.querySelector('#status'),
      metrics: document.querySelector('#metrics'),
      sessionForm: document.querySelector('#sessionForm'),
      sessionResult: document.querySelector('#sessionResult'),
      qualityResult: document.querySelector('#qualityResult'),
      memoryResult: document.querySelector('#memoryResult'),
    };

    els.apiKey.value = localStorage.getItem('tuberosa.apiKey') || '';
    els.projectFilter.value = localStorage.getItem('tuberosa.project') || '';
    document.querySelector('#sessionProject').value = els.projectFilter.value;
    document.querySelector('#cwd').value = localStorage.getItem('tuberosa.cwd') || '';

    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => switchView(tab.dataset.view));
    });

    els.refresh.addEventListener('click', refreshSummary);
    els.apiKey.addEventListener('input', () => localStorage.setItem('tuberosa.apiKey', els.apiKey.value));
    els.projectFilter.addEventListener('input', () => {
      localStorage.setItem('tuberosa.project', els.projectFilter.value);
      document.querySelector('#sessionProject').value = els.projectFilter.value;
    });

    els.sessionForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      await startSession();
    });

    refreshSummary();

    function switchView(view) {
      document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === view));
      document.querySelectorAll('.view').forEach((section) => section.classList.toggle('active', section.id === view));
      if (view === 'quality' || view === 'memory') refreshSummary();
    }

    async function refreshSummary() {
      setBusy(true, 'Loading summary');
      try {
        const params = new URLSearchParams();
        const project = valueOf('#projectFilter');
        const limit = valueOf('#limitFilter') || '10';
        if (project) params.set('project', project);
        params.set('limit', limit);
        state.summary = await api('/operations/workbench/summary?' + params.toString());
        renderMetrics(state.summary);
        renderQuality(state.summary.contextQuality);
        renderMemory(state.summary);
        setStatus('Summary loaded at ' + new Date(state.summary.generatedAt).toLocaleString());
      } catch (error) {
        setError(error);
      } finally {
        setBusy(false);
      }
    }

    async function startSession() {
      setBusy(true, 'Starting session');
      try {
        const body = compact({
          prompt: valueOf('#prompt'),
          project: valueOf('#sessionProject'),
          cwd: valueOf('#cwd'),
          taskType: valueOf('#taskType'),
          noiseTolerance: valueOf('#noiseTolerance'),
          contextMode: valueOf('#contextMode'),
          includeDeepContext: valueOf('#includeDeepContext') === 'true',
        });
        localStorage.setItem('tuberosa.cwd', body.cwd || '');
        const result = await api('/agent-sessions', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        state.session = result.session;
        state.contextPack = result.contextPack;
        renderSessionResult(result);
        setStatus('Started session ' + result.session.id);
        await refreshSummary();
      } catch (error) {
        setError(error);
      } finally {
        setBusy(false);
      }
    }

    async function recordDecision(feedbackType) {
      if (!state.session || !state.contextPack) return;
      setBusy(true, 'Recording context decision');
      try {
        const result = await api('/agent-sessions/' + encodeURIComponent(state.session.id) + '/context-decision', {
          method: 'POST',
          body: JSON.stringify(compact({
            contextPackId: state.contextPack.id,
            feedbackType,
            reason: valueOf('#decisionReason'),
          })),
        });
        renderDecisionResult(result);
        setStatus('Recorded ' + feedbackType + ' for session ' + state.session.id);
        await refreshSummary();
      } catch (error) {
        setError(error);
      } finally {
        setBusy(false);
      }
    }

    async function finishSession() {
      if (!state.session) return;
      setBusy(true, 'Finishing session');
      try {
        const result = await api('/agent-sessions/' + encodeURIComponent(state.session.id) + '/finish', {
          method: 'POST',
          body: JSON.stringify(compact({
            outcome: valueOf('#finishOutcome') || 'completed',
            summary: valueOf('#finishSummary'),
            agentOutputSummary: valueOf('#finishSummary'),
          })),
        });
        renderFinishResult(result);
        setStatus('Finished session ' + state.session.id);
        await refreshSummary();
      } catch (error) {
        setError(error);
      } finally {
        setBusy(false);
      }
    }

    function renderMetrics(summary) {
      const metrics = [
        ['Context-quality', summary.counts.contextQualityMatched],
        ['Pending drafts', summary.counts.pendingDrafts],
        ['Risky auto memories', summary.counts.riskyAutoMemories],
        ['Open gaps', summary.counts.openGaps],
        ['Open proposals', summary.counts.openProposals],
        ['Open conflicts', summary.counts.openConflicts],
        ['Open error logs', summary.counts.openErrorLogs],
        ['Active sessions', summary.counts.activeSessions],
      ];
      els.metrics.replaceChildren(...metrics.map(([label, value]) => node('div', { class: 'metric' }, [
        node('strong', {}, String(value)),
        node('span', {}, label),
      ])));
    }

    function renderSessionResult(result) {
      const context = result.contextPack;
      const fit = context.contextFit || {};
      const direct = evidenceItems(context, 'directTaskEvidence');
      const adjacent = evidenceItems(context, 'adjacentContext');
      const verification = context.orientation?.verificationCommands || [];
      const missing = context.contextFit?.missingSignals || [];
      const actions = context.taskBrief?.actionItems || [];

      els.sessionResult.replaceChildren(node('div', { class: 'result stack' }, [
        node('div', { class: 'row' }, [
          pill(result.policy?.action || 'policy'),
          pill(fit.fitStatus || 'fit pending'),
          node('span', { class: statusClass(fit.fitStatus) }, typeof fit.fitScore === 'number' ? score(fit.fitScore) : ''),
          node('span', { class: 'small muted mono' }, result.session.id),
        ]),
        node('div', { class: 'grid two' }, [
          renderList('Task Brief', actions.map((item) => item.label + (item.reason ? ' - ' + item.reason : ''))),
          renderList('Verification Commands', verification),
        ]),
        renderList('Missing Signals', missing),
        renderItems('Direct Evidence', direct),
        renderItems('Adjacent Context', adjacent),
        node('div', { class: 'grid' }, [
          node('label', { class: 'span-4' }, ['Decision reason', node('textarea', { id: 'decisionReason' })]),
          decisionButton('selected'),
          decisionButton('selected_but_noisy'),
          decisionButton('rejected'),
          decisionButton('missing_context'),
        ]),
        node('div', { class: 'grid two' }, [
          node('label', {}, ['Outcome', select('finishOutcome', ['completed', 'failed', 'blocked', 'cancelled'])]),
          node('label', {}, ['Finish summary', node('input', { id: 'finishSummary' })]),
          node('div', { class: 'span-2 row' }, [
            button('Finish Session', finishSession, 'primary'),
          ]),
        ]),
        node('div', { id: 'decisionResult' }),
        node('div', { id: 'finishResult' }),
      ]));
    }

    function renderDecisionResult(result) {
      document.querySelector('#decisionResult')?.replaceChildren(node('pre', {}, JSON.stringify({
        decision: result.decision,
        policy: result.policy,
      }, null, 2)));
    }

    function renderFinishResult(result) {
      document.querySelector('#finishResult')?.replaceChildren(node('pre', {}, JSON.stringify({
        session: result.session,
        learningDecision: result.learningDecision,
        compliance: result.compliance,
      }, null, 2)));
    }

    function renderQuality(report) {
      if (!report || report.records.length === 0) {
        els.qualityResult.replaceChildren(empty('No context-quality feedback matched.'));
        return;
      }
      els.qualityResult.replaceChildren(node('div', { class: 'stack' }, [
        node('div', { class: 'row' }, [
          pill('matched ' + report.totalMatched),
          pill('showing ' + report.records.length),
        ]),
        ...report.records.map((record) => node('div', { class: 'item' }, [
          node('div', { class: 'item-title' }, record.feedback.feedbackType + ' - ' + record.feedback.id),
          node('div', { class: 'small muted' }, record.feedback.reason || 'No reason recorded'),
          renderList('Missing signals', record.missingSignals),
          renderItems('Noisy or adjacent items', record.adjacentItems.map((item) => ({
            title: item.title,
            knowledgeId: item.knowledgeId,
            score: item.score,
            reasons: item.reasons,
            evidenceCategory: item.evidenceCategory,
            evidenceStrength: item.evidenceStrength,
          }))),
          renderList('Suggested review', record.suggestedReviewActions),
          renderLinks(record),
        ])),
      ]));
    }

    function renderMemory(summary) {
      const blocks = [
        ['Pending Drafts', summary.pendingDrafts, (item) => item.title + ' - ' + item.status],
        ['Risky Auto Memories', summary.riskyAutoMemories, (item) => item.title + ' - ' + (item.status || 'approved')],
        ['Open Gaps', summary.openGaps, (item) => item.id + ' - ' + (item.reason || item.missingSignals.join(', '))],
        ['Open Proposals', summary.openProposals, (item) => item.proposalType + ' - ' + item.reason],
        ['Open Conflicts', summary.openConflicts, (item) => item.conflictType + ' - ' + item.reason],
        ['Open Error Logs', summary.openErrorLogs.logs, (item) => item.title + ' - ' + item.status + '/' + item.severity],
      ];
      const children = [
        node('div', { class: 'row' }, summary.recommendedActions.map((action) => pill(action.label + ' ' + action.count))),
        ...blocks.map(([title, items, formatter]) => renderReviewBlock(title, items, formatter)),
      ];
      els.memoryResult.replaceChildren(node('div', { class: 'stack' }, children));
    }

    function renderReviewBlock(title, items, formatter) {
      if (!items || items.length === 0) return node('div', { class: 'item' }, [node('div', { class: 'item-title' }, title), node('div', { class: 'small muted' }, 'No matches')]);
      return node('div', { class: 'item' }, [
        node('div', { class: 'item-title' }, title),
        ...items.map((item) => node('div', { class: 'small' }, formatter(item))),
      ]);
    }

    function renderLinks(record) {
      const links = [];
      if (record.contextPack) links.push(link('/context/packs/' + encodeURIComponent(record.contextPack.id), 'Context pack'));
      if (record.session) links.push(link('/agent-sessions/' + encodeURIComponent(record.session.id), 'Session'));
      record.openKnowledgeGaps.forEach((gap) => links.push(link('/operations/knowledge-gaps/' + encodeURIComponent(gap.id), 'Gap ' + gap.id)));
      record.openLearningProposals.forEach((proposal) => links.push(link('/operations/learning-proposals/' + encodeURIComponent(proposal.id), 'Proposal ' + proposal.id)));
      return links.length ? node('div', { class: 'row' }, links) : node('div');
    }

    function evidenceItems(context, category) {
      return (context.sections || [])
        .flatMap((section) => section.items || [])
        .filter((item) => item.evidenceCategory === category);
    }

    function renderItems(title, items) {
      if (!items || items.length === 0) return renderList(title, []);
      return node('div', {}, [
        node('h3', {}, title),
        ...items.map((item) => node('div', { class: 'item' }, [
          node('div', { class: 'item-title' }, item.title + ' (' + item.knowledgeId + ')'),
          node('div', { class: 'small muted' }, [item.evidenceCategory, item.evidenceStrength, score(item.score ?? item.finalScore)].filter(Boolean).join(' | ')),
          item.usefulnessReason ? node('div', { class: 'small' }, item.usefulnessReason) : node('div'),
          renderList('Reasons', item.reasons || []),
        ])),
      ]);
    }

    function renderList(title, values) {
      return node('div', {}, [
        node('h3', {}, title),
        values && values.length
          ? node('ul', {}, values.slice(0, 10).map((value) => node('li', { class: 'small' }, String(value))))
          : node('div', { class: 'small muted' }, 'None'),
      ]);
    }

    function decisionButton(type) {
      return button(type, () => recordDecision(type));
    }

    async function api(path, options = {}) {
      const headers = new Headers(options.headers || {});
      if (options.body) headers.set('content-type', 'application/json');
      if (els.apiKey.value.trim()) headers.set('x-tuberosa-api-key', els.apiKey.value.trim());
      const response = await fetch(path, { ...options, headers });
      const text = await response.text();
      const data = text ? JSON.parse(text) : null;
      if (!response.ok) {
        throw new Error(data?.error || data?.message || response.statusText);
      }
      return data;
    }

    function node(tag, attrs = {}, children = []) {
      const el = document.createElement(tag);
      for (const [key, value] of Object.entries(attrs)) {
        if (key === 'class') el.className = value;
        else if (key === 'id') el.id = value;
        else if (key === 'for') el.htmlFor = value;
        else if (value !== undefined && value !== null) el.setAttribute(key, String(value));
      }
      const list = Array.isArray(children) ? children : [children];
      for (const child of list.flat()) {
        if (child === undefined || child === null) continue;
        el.append(child instanceof Node ? child : document.createTextNode(String(child)));
      }
      return el;
    }

    function button(text, onClick, className) {
      const el = node('button', { type: 'button', class: className || '' }, text);
      el.addEventListener('click', onClick);
      return el;
    }

    function select(id, values) {
      return node('select', { id }, values.map((value) => node('option', { value }, value)));
    }

    function link(path, text) {
      return node('a', { href: path, target: '_blank', rel: 'noreferrer' }, text);
    }

    function pill(text) {
      return node('span', { class: 'pill' }, text);
    }

    function empty(text) {
      return node('div', { class: 'result small muted' }, text);
    }

    function statusClass(status) {
      if (status === 'ready') return 'ready';
      if (status === 'insufficient') return 'bad';
      return 'warn';
    }

    function score(value) {
      return typeof value === 'number' ? value.toFixed(3) : '';
    }

    function valueOf(selector) {
      return document.querySelector(selector)?.value?.trim() || '';
    }

    function compact(value) {
      return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== ''));
    }

    function setBusy(busy, message) {
      document.querySelectorAll('button').forEach((button) => { button.disabled = busy; });
      if (busy && message) setStatus(message);
    }

    function setStatus(message) {
      els.status.textContent = message;
      els.status.className = 'small muted';
    }

    function setError(error) {
      els.status.textContent = error instanceof Error ? error.message : String(error);
      els.status.className = 'small bad';
    }
  </script>
</body>
</html>`;
}
