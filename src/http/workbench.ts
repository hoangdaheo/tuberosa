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

    button.warn {
      border-color: var(--warn);
      color: var(--warn);
    }

    button.danger {
      border-color: var(--bad);
      color: var(--bad);
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

    .notice {
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #f8fafc;
    }

    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: end;
      margin-bottom: 10px;
    }

    .toolbar label {
      min-width: 150px;
    }

    .card-header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: start;
    }

    .card-main {
      min-width: 0;
    }

    .item-title {
      font-weight: 750;
      overflow-wrap: anywhere;
    }

    .queue-line {
      border-top: 1px solid var(--line);
      padding: 8px 0;
    }

    .queue-line:first-of-type {
      border-top: 0;
    }

    .field-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
    }

    .field {
      min-width: 0;
    }

    .field strong {
      display: block;
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 2px;
    }

    .review-controls {
      border-top: 1px solid var(--line);
      margin-top: 10px;
      padding-top: 10px;
    }

    summary {
      cursor: pointer;
      font-weight: 700;
      font-size: 13px;
      color: var(--accent-2);
      margin: 8px 0;
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
      .field-grid, .card-header { grid-template-columns: 1fr; }
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
          <section class="panel">
            <h2>Reflection Draft Queue</h2>
            <div class="notice small">
              Pending drafts are proposed memories. They do not become searchable context until a reviewer approves them.
              Use needs changes when a draft is useful but too broad, ungrounded, duplicated, or missing references.
            </div>
            <div class="toolbar" style="margin-top:10px">
              <label>Status
                <select id="draftStatus">
                  <option value="pending">pending</option>
                  <option value="needs_changes">needs changes</option>
                  <option value="rejected">rejected</option>
                  <option value="approved">approved</option>
                </select>
              </label>
              <label>Reviewer <input id="draftReviewer" autocomplete="off" placeholder="optional"></label>
              <button id="loadDrafts" type="button">Load Drafts</button>
            </div>
            <div id="draftReviewResult"></div>
          </section>
          <section class="panel">
            <h2>Knowledge Browser</h2>
            <div class="notice small">
              Knowledge is the reviewed store Tuberosa retrieves from. These cards show trust, status, provenance,
              labels, references, and content without making you read raw JSON.
            </div>
            <div class="toolbar" style="margin-top:10px">
              <label>Search <input id="knowledgeQuery" autocomplete="off" placeholder="title, summary, content"></label>
              <label>Status
                <select id="knowledgeStatus">
                  <option value="">any</option>
                  <option value="approved">approved</option>
                  <option value="needs_review">needs review</option>
                  <option value="archived">archived</option>
                  <option value="blocked">blocked</option>
                </select>
              </label>
              <label>Review filter
                <select id="knowledgeReview">
                  <option value="">none</option>
                  <option value="questionable">questionable</option>
                  <option value="risky_auto_memory">risky auto memory</option>
                  <option value="auto_memory">auto memory</option>
                  <option value="stale">stale</option>
                  <option value="rejected">rejected feedback</option>
                  <option value="irrelevant">irrelevant feedback</option>
                  <option value="low_trust">low trust</option>
                  <option value="unsafe">unsafe</option>
                  <option value="orphaned">orphaned</option>
                </select>
              </label>
              <button id="loadKnowledge" type="button">Load Knowledge</button>
            </div>
            <div id="knowledgeResult"></div>
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
      draftStatus: document.querySelector('#draftStatus'),
      draftReviewer: document.querySelector('#draftReviewer'),
      draftReviewResult: document.querySelector('#draftReviewResult'),
      loadDrafts: document.querySelector('#loadDrafts'),
      knowledgeQuery: document.querySelector('#knowledgeQuery'),
      knowledgeStatus: document.querySelector('#knowledgeStatus'),
      knowledgeReview: document.querySelector('#knowledgeReview'),
      knowledgeResult: document.querySelector('#knowledgeResult'),
      loadKnowledge: document.querySelector('#loadKnowledge'),
    };

    els.apiKey.value = localStorage.getItem('tuberosa.apiKey') || '';
    els.projectFilter.value = localStorage.getItem('tuberosa.project') || '';
    document.querySelector('#sessionProject').value = els.projectFilter.value;
    document.querySelector('#cwd').value = localStorage.getItem('tuberosa.cwd') || '';

    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => switchView(tab.dataset.view));
    });

    els.refresh.addEventListener('click', refreshCurrentView);
    els.loadDrafts.addEventListener('click', () => loadDraftQueue());
    els.draftStatus.addEventListener('change', () => loadDraftQueue());
    els.loadKnowledge.addEventListener('click', () => loadKnowledge());
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

    async function switchView(view) {
      document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === view));
      document.querySelectorAll('.view').forEach((section) => section.classList.toggle('active', section.id === view));
      if (view === 'quality' || view === 'memory') await refreshCurrentView();
    }

    async function refreshCurrentView() {
      await refreshSummary();
      if (activeView() === 'memory') {
        await loadDraftQueue({ quiet: true });
        await loadKnowledge({ quiet: true });
      }
    }

    function activeView() {
      return document.querySelector('.view.active')?.id || 'start';
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

    async function loadDraftQueue(options = {}) {
      if (!options.quiet) setBusy(true, 'Loading reflection drafts');
      try {
        const params = new URLSearchParams();
        const project = valueOf('#projectFilter');
        const status = valueOf('#draftStatus') || 'pending';
        const limit = valueOf('#limitFilter') || '10';
        if (project) params.set('project', project);
        params.set('status', status);
        params.set('limit', limit);
        const drafts = await api('/reflection-drafts?' + params.toString());
        renderDraftQueue(drafts);
        if (!options.quiet) setStatus('Loaded ' + drafts.length + ' reflection drafts');
      } catch (error) {
        els.draftReviewResult.replaceChildren(empty(error instanceof Error ? error.message : String(error)));
        if (!options.quiet) setError(error);
      } finally {
        if (!options.quiet) setBusy(false);
      }
    }

    async function reviewDraft(id, decision) {
      setBusy(true, 'Reviewing reflection draft');
      try {
        const result = await api('/reflection-drafts/' + encodeURIComponent(id) + '/review', {
          method: 'POST',
          body: JSON.stringify(compact({
            decision,
            reviewer: valueOf('#draftReviewer'),
            reviewerNote: valueOf('#draftReviewNote-' + id),
            evaluation: draftEvaluation(id),
          })),
        });
        await refreshSummary();
        await loadDraftQueue({ quiet: true });
        setStatus('Recorded ' + decision + ' for draft ' + result.id);
      } catch (error) {
        setError(error);
      } finally {
        setBusy(false);
      }
    }

    function draftEvaluation(id) {
      const evaluation = compact({
        accuracy: valueOf('#draftAccuracy-' + id),
        usefulness: valueOf('#draftUsefulness-' + id),
        scope: valueOf('#draftScope-' + id),
        privacySafety: valueOf('#draftPrivacySafety-' + id),
        labels: valueOf('#draftLabels-' + id),
        references: valueOf('#draftReferences-' + id),
        duplicateRisk: valueOf('#draftDuplicateRisk-' + id),
      });
      return Object.keys(evaluation).length ? evaluation : undefined;
    }

    async function loadKnowledge(options = {}) {
      if (!options.quiet) setBusy(true, 'Loading knowledge');
      try {
        const params = new URLSearchParams();
        const project = valueOf('#projectFilter');
        const query = valueOf('#knowledgeQuery');
        const status = valueOf('#knowledgeStatus');
        const review = valueOf('#knowledgeReview');
        const limit = valueOf('#limitFilter') || '10';
        if (project) params.set('project', project);
        if (query) params.set('q', query);
        if (status) params.set('status', status);
        if (review) params.set('review', review);
        params.set('limit', limit);
        const knowledge = await api('/knowledge?' + params.toString());
        renderKnowledge(knowledge);
        if (!options.quiet) setStatus('Loaded ' + knowledge.length + ' knowledge items');
      } catch (error) {
        els.knowledgeResult.replaceChildren(empty(error instanceof Error ? error.message : String(error)));
        if (!options.quiet) setError(error);
      } finally {
        if (!options.quiet) setBusy(false);
      }
    }

    function renderMetrics(summary) {
      const metrics = [
        ['contextQualityMatched', 'Context-quality'],
        ['pendingDrafts', 'Pending drafts'],
        ['riskyAutoMemories', 'Risky auto memories'],
        ['openGaps', 'Open gaps'],
        ['openProposals', 'Open proposals'],
        ['openConflicts', 'Open conflicts'],
        ['openErrorLogs', 'Open error logs'],
        ['activeSessions', 'Active sessions'],
      ];
      els.metrics.replaceChildren(...metrics.map(([key, label]) => node('div', { class: 'metric' }, [
        node('strong', {}, formatCount(summary, key)),
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
        ['Pending Drafts', summary.pendingDrafts, renderDraftSummary, 'Review these before they can become searchable memory.'],
        ['Risky Auto Memories', summary.riskyAutoMemories, renderKnowledgeSummary, 'Approved memories with weak trust, missing grounding, or negative feedback.'],
        ['Open Gaps', summary.openGaps, renderGapSummary, 'Evidence agents expected but could not find.'],
        ['Open Proposals', summary.openProposals, renderProposalSummary, 'Suggested label, reference, relation, supersession, or cleanup actions.'],
        ['Open Conflicts', summary.openConflicts, renderConflictSummary, 'Knowledge that may disagree or need a supersession decision.'],
        ['Open Error Logs', summary.openErrorLogs.logs, renderErrorLogSummary, 'Incidents that can become reviewed lessons after resolution.'],
      ];
      const children = [
        node('div', { class: 'notice' }, [
          node('div', { class: 'item-title' }, 'What the queues mean'),
          node('div', { class: 'small muted' }, [
            'Context-quality records explain why startup context was noisy or incomplete. ',
            'Pending drafts are proposed memories waiting for approval. ',
            'Open gaps and proposals are maintenance work for improving future retrieval.',
          ]),
        ]),
        renderActionList(summary.recommendedActions),
        ...blocks.map(([title, items, formatter, description]) => renderReviewBlock(title, items, formatter, description)),
      ];
      els.memoryResult.replaceChildren(node('div', { class: 'stack' }, children));
    }

    function renderActionList(actions) {
      if (!actions || actions.length === 0) return node('div');
      return node('div', { class: 'item' }, [
        node('div', { class: 'item-title' }, 'Recommended Actions'),
        ...actions.map((action) => node('div', { class: 'queue-line' }, [
          node('div', { class: 'row' }, [
            pill('priority ' + action.priority),
            pill(String(action.count)),
            action.href ? link(action.href, action.label) : node('span', { class: 'item-title' }, action.label),
          ]),
          node('div', { class: 'small muted' }, action.reason || ''),
        ])),
      ]);
    }

    function renderReviewBlock(title, items, formatter, description) {
      if (!items || items.length === 0) {
        return node('div', { class: 'item' }, [
          node('div', { class: 'item-title' }, title),
          node('div', { class: 'small muted' }, description),
          node('div', { class: 'small muted' }, 'No matches'),
        ]);
      }

      return node('div', { class: 'item' }, [
        node('div', { class: 'item-title' }, title),
        node('div', { class: 'small muted' }, description),
        ...items.map((item) => node('div', { class: 'queue-line' }, formatter(item))),
      ]);
    }

    function renderDraftQueue(drafts) {
      if (!drafts || drafts.length === 0) {
        els.draftReviewResult.replaceChildren(empty('No reflection drafts matched this status.'));
        return;
      }

      els.draftReviewResult.replaceChildren(node('div', { class: 'stack' }, drafts.map(renderDraftCard)));
    }

    function renderDraftCard(draft) {
      const canReview = draft.status === 'pending' || draft.status === 'needs_changes';
      return node('article', { class: 'item' }, [
        node('div', { class: 'card-header' }, [
          node('div', { class: 'card-main' }, [
            node('div', { class: 'item-title' }, draft.title),
            node('div', { class: 'small muted' }, draft.summary || 'No summary recorded.'),
          ]),
          node('div', { class: 'row' }, [
            pill(humanStatus(draft.status)),
            pill(humanStatus(draft.itemType)),
            pill(humanStatus(draft.triggerType)),
          ]),
        ]),
        node('div', { class: 'field-grid', style: 'margin-top:10px' }, [
          field('Review meaning', draftReviewMeaning(draft.status)),
          field('Created', formatDate(draft.createdAt)),
          field('Project', draft.project || 'personal'),
        ]),
        renderChipList('Suggested labels', (draft.suggestedLabels || []).map(formatLabel)),
        renderChipList('References', (draft.references || []).map(formatReference)),
        renderChipList('Duplicate candidates', (draft.duplicateCandidates || []).map(formatDuplicateCandidate)),
        node('details', {}, [
          node('summary', {}, 'Read draft content'),
          node('pre', {}, draft.content || 'No content recorded.'),
        ]),
        renderReviewControls(draft, canReview),
      ]);
    }

    function renderReviewControls(draft, canReview) {
      if (!canReview) {
        return node('div', { class: 'review-controls small muted' }, 'This draft already has a terminal review status.');
      }

      const id = draft.id;
      return node('div', { class: 'review-controls stack' }, [
        node('div', { class: 'field-grid' }, [
          node('label', {}, ['Accuracy', reviewSelect('draftAccuracy-' + id, ['pass', 'concern', 'fail'])]),
          node('label', {}, ['Usefulness', reviewSelect('draftUsefulness-' + id, ['pass', 'concern', 'fail'])]),
          node('label', {}, ['Scope', reviewSelect('draftScope-' + id, ['pass', 'concern', 'fail'])]),
          node('label', {}, ['Privacy', reviewSelect('draftPrivacySafety-' + id, ['pass', 'concern', 'fail'])]),
          node('label', {}, ['Labels', reviewSelect('draftLabels-' + id, ['pass', 'concern', 'fail'])]),
          node('label', {}, ['References', reviewSelect('draftReferences-' + id, ['pass', 'concern', 'fail'])]),
          node('label', {}, ['Duplicate risk', reviewSelect('draftDuplicateRisk-' + id, ['low', 'medium', 'high'])]),
        ]),
        node('label', {}, ['Reviewer note', node('textarea', { id: 'draftReviewNote-' + id, placeholder: 'Why this should be approved, rejected, or revised' })]),
        node('div', { class: 'row' }, [
          button('Approve', () => reviewDraft(id, 'approve'), 'primary'),
          button('Needs changes', () => reviewDraft(id, 'needs_changes'), 'warn'),
          button('Reject', () => reviewDraft(id, 'reject'), 'danger'),
        ]),
      ]);
    }

    function renderKnowledge(knowledge) {
      if (!knowledge || knowledge.length === 0) {
        els.knowledgeResult.replaceChildren(empty('No knowledge matched these filters.'));
        return;
      }

      els.knowledgeResult.replaceChildren(node('div', { class: 'stack' }, knowledge.map(renderKnowledgeCard)));
    }

    function renderKnowledgeCard(item) {
      return node('article', { class: 'item' }, [
        node('div', { class: 'card-header' }, [
          node('div', { class: 'card-main' }, [
            node('div', { class: 'item-title' }, item.title),
            node('div', { class: 'small muted' }, item.summary || 'No summary recorded.'),
          ]),
          node('div', { class: 'row' }, [
            pill(humanStatus(item.status || 'approved')),
            pill(humanStatus(item.itemType)),
            pill('trust ' + item.trustLevel),
          ]),
        ]),
        node('div', { class: 'field-grid', style: 'margin-top:10px' }, [
          field('Source', [item.sourceType, item.sourceUri].filter(Boolean).join(' / ') || 'unknown'),
          field('Freshness', item.freshnessAt ? formatDate(item.freshnessAt) : 'not set'),
          field('Updated', formatDate(item.updatedAt || item.createdAt)),
        ]),
        renderChipList('Labels', (item.labels || []).map(formatLabel)),
        renderChipList('References', (item.references || []).map(formatReference)),
        node('details', {}, [
          node('summary', {}, 'Read knowledge content'),
          node('pre', {}, item.content || 'No content recorded.'),
        ]),
        node('div', { class: 'row' }, [
          link('/knowledge/' + encodeURIComponent(item.id), 'JSON'),
          item.sourceUri ? node('span', { class: 'small muted mono' }, item.sourceUri) : node('span'),
        ]),
      ]);
    }

    function renderDraftSummary(item) {
      return summaryLine(item.title, [
        humanStatus(item.status),
        humanStatus(item.itemType),
        item.labelCount + ' labels',
        item.referenceCount + ' refs',
        item.duplicateCandidateCount + ' duplicates',
      ], item.summary);
    }

    function renderKnowledgeSummary(item) {
      return summaryLine(item.title, [
        humanStatus(item.status || 'approved'),
        humanStatus(item.itemType),
        'trust ' + item.trustLevel,
        item.labelCount + ' labels',
        item.referenceCount + ' refs',
      ], item.summary);
    }

    function renderGapSummary(item) {
      return summaryLine(item.reason || 'Knowledge gap', [
        humanStatus(item.status),
        item.missingSignalCount + ' missing signals',
      ], item.prompt, item.missingSignals);
    }

    function renderProposalSummary(item) {
      return summaryLine(humanStatus(item.proposalType), [
        humanStatus(item.status),
        item.evidenceCount + ' evidence items',
      ], item.reason, item.evidence);
    }

    function renderConflictSummary(item) {
      return summaryLine(humanStatus(item.conflictType), [
        humanStatus(item.status),
        item.sharedEvidenceCount + ' shared evidence',
      ], item.reason, [item.leftKnowledgeId, item.rightKnowledgeId]);
    }

    function renderErrorLogSummary(item) {
      return summaryLine(item.title, [
        humanStatus(item.status),
        humanStatus(item.severity),
        humanStatus(item.category || 'error'),
      ], item.summary || item.command || 'No summary recorded.');
    }

    function summaryLine(title, badges, description, extra = []) {
      return [
        node('div', { class: 'row' }, [
          node('span', { class: 'item-title' }, title || 'Untitled'),
          ...badges.filter(Boolean).map(pill),
        ]),
        description ? node('div', { class: 'small muted' }, description) : node('div'),
        extra && extra.length ? node('div', { class: 'small mono muted' }, extra.join(' | ')) : node('div'),
      ];
    }

    function field(label, value) {
      return node('div', { class: 'field small' }, [
        node('strong', {}, label),
        node('span', {}, value || 'None'),
      ]);
    }

    function renderChipList(title, values) {
      if (!values || values.length === 0) return renderList(title, []);
      return node('div', {}, [
        node('h3', {}, title),
        node('div', { class: 'row' }, values.slice(0, 16).map((value) => pill(value))),
      ]);
    }

    function reviewSelect(id, values) {
      return node('select', { id }, [
        node('option', { value: '' }, 'not checked'),
        ...values.map((value) => node('option', { value }, humanStatus(value))),
      ]);
    }

    function formatLabel(label) {
      if (!label) return '';
      return humanStatus(label.type || 'label') + ': ' + String(label.value || '');
    }

    function formatReference(reference) {
      if (!reference) return '';
      const lines = reference.lineStart ? ':' + reference.lineStart + (reference.lineEnd ? '-' + reference.lineEnd : '') : '';
      return humanStatus(reference.type || 'ref') + ': ' + String(reference.uri || '') + lines;
    }

    function formatDuplicateCandidate(candidate) {
      if (!candidate) return '';
      const title = candidate.title || candidate.knowledgeId || candidate.id || 'candidate';
      const value = typeof candidate.score === 'number' ? ' ' + score(candidate.score) : '';
      return String(title) + value;
    }

    function draftReviewMeaning(status) {
      if (status === 'pending') return 'Not searchable until approved.';
      if (status === 'needs_changes') return 'Reviewer asked for edits before approval.';
      if (status === 'approved') return 'Approved and eligible to become memory.';
      if (status === 'rejected') return 'Rejected and should not become memory.';
      return humanStatus(status);
    }

    function humanStatus(value) {
      return String(value || '').replace(/_/g, ' ');
    }

    function formatDate(value) {
      return value ? new Date(value).toLocaleString() : 'unknown';
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

    function formatCount(summary, key) {
      const value = summary.counts?.[key] ?? 0;
      return summary.countMetadata?.capped?.[key] ? String(value) + '+' : String(value);
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
