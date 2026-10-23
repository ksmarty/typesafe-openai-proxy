/**
 * Dashboard. The settings view is generated from the schema the server serves, so a setting
 * only ever has to be described once — in src/schema.ts.
 */

const $ = (id) => document.getElementById(id);

const ROUTE_LABEL = {
  tool: 'tool call',
  confirm: 'needs confirmation',
  clarify: 'asks a question',
  text: 'speaks',
  forward: 'forwarded to the model',
};

const MASK = '\u2022\u2022\u2022\u2022\u2022\u2022';

const state = {
  schema: { groups: [], defaults: {}, envOverrides: [] },
  config: {},
  values: new Map(),
  templates: new Map(),
  showAdvanced: readPref('show-advanced') === '1',
};

function readPref(key) {
  try {
    return localStorage.getItem(`trp.${key}`);
  } catch {
    return null;
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(`trp.${key}`, value);
  } catch {
    /* storage unavailable — the preference just will not persist */
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

function getPath(source, key) {
  return key.split('.').reduce((value, part) => {
    if (value === null || typeof value !== 'object') return undefined;
    return value[part];
  }, source);
}

function setPath(target, key, value) {
  const parts = key.split('.');
  const last = parts.pop();
  let cursor = target;
  for (const part of parts) {
    if (cursor[part] === null || typeof cursor[part] !== 'object') cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[last] = value;
}

async function api(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) {
    let detail = `${response.status}`;
    try {
      const parsed = await response.json();
      detail = parsed.error?.message ?? parsed.error ?? detail;
    } catch { /* not JSON */ }
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  return response.json();
}

/* ---------------------------------------------------------------- monitor view */

function gatesMarkup(gates) {
  if (!gates || gates.length === 0) return '';
  const rows = gates
    .map((gate) => {
      const probability = gate.probability ?? gate.confidence ?? 0;
      const percent = Math.max(0, Math.min(100, Math.round(probability * 100)));
      const threshold = Math.round((gate.threshold ?? 0) * 100);
      const status = gate.passed ? 'pass' : 'fail';
      return `
        <div class="gate">
          <span class="name">${escapeHtml(gate.question)}</span>
          <span class="bar">
            <i class="${status}" style="width:${percent}%"></i>
            <b style="left:${Math.max(0, Math.min(99, threshold))}%"></b>
          </span>
          <span class="num ${status}">${percent}%<span class="choice">${gate.choice ? ` ${escapeHtml(String(gate.choice).slice(0, 14))}` : ''}</span></span>
        </div>`;
    })
    .join('');
  return `<div class="gates">${rows}</div>`;
}

function planMarkup(plan) {
  if (!plan) return '';
  const rows = [];
  if (plan.tool) {
    rows.push(`<dt>tool</dt><dd>${escapeHtml(plan.tool)}</dd>`);
    rows.push(`<dt>args</dt><dd>${escapeHtml(JSON.stringify(plan.args))}</dd>`);
  }
  if (plan.kind === 'clarify' || plan.kind === 'confirm' || plan.kind === 'text') {
    rows.push(`<dt>says</dt><dd>${escapeHtml(plan.text)}</dd>`);
  }
  if (plan.kind === 'confirm' && plan.pending) {
    rows.push(`<dt>would run</dt><dd>${escapeHtml(plan.pending.tool)} ${escapeHtml(JSON.stringify(plan.pending.args))}</dd>`);
  }
  if (plan.kind === 'forward') rows.push(`<dt>forward</dt><dd>${escapeHtml(plan.reason)}</dd>`);
  return rows.length ? `<dl class="kv">${rows.join('')}</dl>` : '';
}

function renderProbe(result) {
  const target = $('probe-result');
  const trace = result.trace ?? {};
  const plan = result.route?.plan;
  if (!plan) {
    target.className = 'probe-result empty';
    target.textContent = 'No decision returned.';
    return;
  }
  target.className = 'probe-result';
  const badge = `<span class="badge ${escapeHtml(plan.kind)}">${escapeHtml(ROUTE_LABEL[plan.kind] ?? plan.kind)}</span>`;
  const note = result.fastPath && !result.fastPath.ready
    ? `<div class="note warn">The live fast path is off (${escapeHtml(result.fastPath.reason)}), so a real request would be forwarded unchanged. This probe decided anyway, using the ${escapeHtml(result.probeBackend ?? 'built-in')} backend.</div>`
    : '';
  const meta = [
    trace.backend ? `${trace.backend}` : '',
    trace.totalMs != null ? `${trace.totalMs} ms` : '',
    trace.catalogSource ? `${trace.catalogSource} · ${trace.entities ?? 0} entities` : '',
  ].filter(Boolean).join(' · ');
  target.innerHTML = `
    ${note}
    <div class="verdict">${badge}<span class="reason">${escapeHtml(result.route.reason ?? '')}</span></div>
    ${planMarkup(plan)}
    <div class="reason" style="margin-top:10px">${escapeHtml(meta)}</div>
    ${gatesMarkup(trace.gates)}
  `;
}

function renderTrace(items) {
  const list = $('trace-list');
  if (!items.length) {
    list.innerHTML = '<p class="empty">No turns yet. Send something to Home Assistant, or try a request above.</p>';
    return;
  }
  list.innerHTML = items
    .map((entry) => {
      const when = new Date(entry.at).toLocaleTimeString();
      const ms = entry.totalMs ?? entry.decisionMs ?? 0;
      const detail = `
        ${planMarkup({
          ...(entry.args ? { kind: 'tool', tool: entry.tool, args: entry.args } : {}),
          ...(entry.clarification ? { kind: 'clarify', text: entry.clarification } : {}),
          ...(entry.route === 'forward' ? { kind: 'forward', reason: entry.reason } : {}),
        })}
        <div class="reason" style="margin-top:8px">
          ${escapeHtml([entry.backend, entry.model, entry.catalogSource ? `${entry.catalogSource} · ${entry.entities ?? 0}` : '', entry.inputTokens ? `${entry.inputTokens} tokens` : '', entry.language ?? ''].filter(Boolean).join(' · '))}
        </div>
        ${gatesMarkup(entry.gates)}`;
      return `
        <details class="entry">
          <summary>
            <span class="utterance">${escapeHtml(entry.utterance)}</span>
            <span class="meta"><span class="badge ${escapeHtml(entry.backend === 'off' ? 'bypass' : entry.route)}">${escapeHtml(entry.backend === 'off' ? 'pass-through' : entry.route)}</span> ${ms} ms · ${escapeHtml(when)}</span>
          </summary>
          <div class="reason" style="margin-top:8px">${escapeHtml(entry.reason ?? '')}</div>
          ${detail}
        </details>`;
    })
    .join('');
}

async function refreshStatus() {
  try {
    const status = await api('api/status');
    $('health-dot').className = 'dot ok';
    const fast = status.decision.fastPath ?? { ready: false, reason: 'unknown' };
    $('pill-backend').textContent = fast.ready
      ? `deciding · ${status.decision.backend} · ${status.decision.averageMs} ms avg`
      : 'pass-through';
    $('pill-catalog').textContent = `catalog ${status.catalog.source} · ${status.catalog.entities} entities`;
    $('pill-uptime').textContent = `up ${Math.floor(status.uptimeSeconds / 60)}m`;

    for (const key of ['requests', 'toolCalls', 'forwarded', 'bypassed', 'clarifications', 'confirmations', 'errors']) {
      $(`stat-${key}`).textContent = String(status.stats[key] ?? 0);
    }
    $('stat-avg').textContent = `${status.decision.averageMs} ms`;

    const breaker = status.decision.breaker ?? {};
    const node = $('breaker');
    if (breaker.open) {
      node.className = 'breaker warn';
      node.textContent = `decision backend circuit open — ${breaker.failures} failures, retrying in ${Math.max(0, Math.round((breaker.until - Date.now()) / 1000))}s`;
    } else {
      node.className = fast.ready ? 'breaker' : 'breaker warn';
      node.textContent = fast.ready
        ? `fast path on — ${fast.reason}${status.decision.autoStart ? '' : ` · only requests naming the model "${status.routerModel}" are decided`}`
        : `fast path off — ${fast.reason}. Every request is forwarded unchanged.`;
    }
    return status;
  } catch {
    $('health-dot').className = 'dot bad';
    $('pill-uptime').textContent = 'unreachable';
    return null;
  }
}

async function refreshTrace() {
  if (!$('auto-refresh').checked) return;
  try {
    const data = await api('api/trace?limit=40');
    renderTrace(data.items ?? []);
  } catch { /* the next tick will try again */ }
}

async function runProbe(text) {
  const value = (text ?? $('probe-input').value ?? '').trim();
  if (!value) return;
  $('probe-input').value = value;
  $('probe-result').className = 'probe-result empty';
  $('probe-result').textContent = 'Deciding…';
  try {
    const result = await api('api/probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: value }),
    });
    renderProbe(result);
    refreshTrace();
    refreshStatus();
  } catch (error) {
    $('probe-result').className = 'probe-result';
    $('probe-result').textContent = `Failed: ${error.message}`;
  }
}

/* --------------------------------------------------------------- settings view */

function note(element, message, kind = '') {
  element.className = `note ${kind}`;
  element.textContent = message;
}

function fieldControl(field, value) {
  const name = escapeHtml(field.key);
  const label = escapeHtml(field.label);
  if (field.type === 'checkbox') {
    return `<label class="check field-check"><input type="checkbox" data-field="${name}" ${value ? 'checked' : ''} /><span>${label}</span></label>`;
  }
  const help = field.help ? `<p class="field-help">${escapeHtml(field.help)}</p>` : '';
  const unit = field.unit ? `<span class="unit">${escapeHtml(field.unit)}</span>` : '';
  let control = '';
  if (field.type === 'select') {
    const options = (field.options ?? [])
      .map((option) => `<option value="${escapeHtml(option.value)}" ${String(value) === option.value ? 'selected' : ''}>${escapeHtml(option.label)}</option>`)
      .join('');
    control = `<select data-field="${name}">${options}</select>`;
  } else if (field.type === 'slider') {
    control = `
      <div class="slider">
        <input type="range" data-field="${name}" data-slider min="${field.min ?? 0}" max="${field.max ?? 1}" step="${field.step ?? 0.01}" value="${Number(value) || 0}" />
        <input type="number" data-field="${name}" data-slider-number min="${field.min ?? 0}" max="${field.max ?? 1}" step="${field.step ?? 0.01}" value="${Number(value) || 0}" />
      </div>`;
  } else if (field.type === 'number') {
    control = `<div class="number-wrap"><input type="number" data-field="${name}" min="${field.min ?? ''}" max="${field.max ?? ''}" step="${field.step ?? 1}" value="${value ?? ''}" />${unit}</div>`;
  } else if (field.type === 'templates') {
    return templatesField(field, value);
  } else {
    control = `<input type="${field.type === 'password' ? 'password' : 'text'}" data-field="${name}" value="${escapeHtml(value ?? '')}" placeholder="${escapeHtml(field.placeholder ?? '')}" autocomplete="off" spellcheck="false" />`;
  }
  return `<div class="field"><label>${label}</label>${control}${help}</div>`;
}

function templatesField(field, value) {
  const languages = value && typeof value === 'object' ? value : {};
  const rows = Object.entries(languages)
    .map(([language, template]) => `
      <div class="tpl-lang" data-lang="${escapeHtml(language)}">
        <span class="lang">${escapeHtml(language)}</span>
        <input data-part="done" value="${escapeHtml(template?.done ?? '')}" placeholder="done" spellcheck="false" />
        <input data-part="clarify" value="${escapeHtml(template?.clarify ?? '')}" placeholder="clarify" spellcheck="false" />
        <input data-part="confirm" value="${escapeHtml(template?.confirm ?? '')}" placeholder="confirm" spellcheck="false" />
        <button type="button" class="ghost tpl-remove" title="Remove this language">&times;</button>
      </div>`)
    .join('');
  return `
    <div class="field" data-templates="${escapeHtml(field.key)}">
      <label>${escapeHtml(field.label)}</label>
      <div class="tpl-head"><span></span><span>done</span><span>clarify</span><span>confirm</span><span></span></div>
      <div class="tpl-rows">${rows}</div>
      <div class="tpl-add">
        <input class="tpl-new" placeholder="fr" maxlength="8" spellcheck="false" />
        <button type="button" class="tpl-add-button">Add language</button>
      </div>
      ${field.help ? `<p class="field-help">${escapeHtml(field.help)}</p>` : ''}
    </div>`;
}

function testButton(id, label, hint) {
  return `
    <div class="test-row">
      <button type="button" id="${id}" class="ghost">${escapeHtml(label)}</button>
      <span class="note" id="${id}-result"></span>
    </div>
    ${hint ? `<p class="field-help">${escapeHtml(hint)}</p>` : ''}`;
}

function buildSettings() {
  const tabs = $('settings-tabs');
  const panes = $('settings-panes');
  tabs.innerHTML = '';
  panes.innerHTML = '';

  state.schema.groups.forEach((group, index) => {
    const visible = group.fields.filter((field) => state.showAdvanced || !field.advanced);
    const tab = document.createElement('button');
    tab.className = `tab${index === 0 ? ' active' : ''}`;
    tab.dataset.group = group.id;
    tab.textContent = group.title;
    tabs.append(tab);

    const pane = document.createElement('section');
    pane.className = `card pane${index === 0 ? '' : ' hidden'}`;
    pane.dataset.group = group.id;
    let html = `<h2>${escapeHtml(group.title)}</h2><p class="hint">${escapeHtml(group.description)}</p>`;
    html += visible.map((field) => fieldControl(field, getPath(state.config, field.key))).join('');
    if (group.id === 'decision') {
      html += testButton('test-decision', 'Test decision server', 'Calls {baseUrl}/v1/models and reports whether a typed model is available.');
    }
    if (group.id === 'catalog') {
      html += testButton('test-ha', 'Test Home Assistant connection', 'Reads the registries and states over the websocket using the values currently in this form.');
      html += `
        <div class="test-row">
          <button type="button" id="catalog-refresh" class="ghost">Reload the catalog now</button>
          <span class="note" id="catalog-refresh-result"></span>
        </div>`;
    }
    if (group.id === 'upstream') {
      html += testButton('test-upstream', 'Test fallback server', 'Lists models from the fallback server to prove it is reachable.');
    }
    pane.innerHTML = html;
    panes.append(pane);
  });

  $('show-advanced').checked = state.showAdvanced;
  const env = state.schema.envOverrides ?? [];
  const warning = $('env-warning');
  if (env.length) {
    warning.classList.remove('hidden');
    warning.innerHTML = `Environment variables are overriding these settings: <code>${env.map(escapeHtml).join('</code> <code>')}</code>. Saving will not change them.`;
  } else {
    warning.classList.add('hidden');
  }
}

function refreshAdvancedVisibility() {
  const panes = $('settings-panes');
  const activeGroup = panes.querySelector('.pane:not(.hidden)')?.dataset.group;
  buildSettings();
  if (activeGroup) selectTab(activeGroup);
}

function selectTab(groupId) {
  for (const tab of $('settings-tabs').querySelectorAll('.tab')) {
    const active = tab.dataset.group === groupId;
    tab.classList.toggle('active', active);
    // On mobile the tabs are a scrolling strip, so keep the chosen one in view.
    if (active) tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  for (const pane of $('settings-panes').querySelectorAll('.pane')) {
    pane.classList.toggle('hidden', pane.dataset.group !== groupId);
  }
}

function collectTemplates() {
  const out = {};
  for (const block of document.querySelectorAll('[data-templates]')) {
    const templates = {};
    for (const row of block.querySelectorAll('.tpl-lang')) {
      const language = row.dataset.lang;
      if (!language) continue;
      const read = (part) => row.querySelector(`[data-part="${part}"]`)?.value ?? '';
      templates[language] = { done: read('done'), clarify: read('clarify'), confirm: read('confirm') };
    }
    setPath(out, block.dataset.templates, templates);
  }
  return out;
}

function collect() {
  const body = {};
  for (const element of document.querySelectorAll('#settings-panes [data-field]')) {
    const key = element.dataset.field;
    let value;
    if (element.type === 'checkbox') value = element.checked;
    else if (element.type === 'number' || element.type === 'range') {
      value = element.value === '' ? undefined : Number(element.value);
    } else value = element.value;
    // A masked secret is the form echoing back what it was given; leave it alone.
    if (value === MASK) continue;
    setPath(body, key, value);
  }
  Object.assign(body, collectTemplates());
  return body;
}

function fillForm() {
  for (const element of document.querySelectorAll('#settings-panes [data-field]')) {
    const key = element.dataset.field;
    const value = getPath(state.config, key);
    if (element.dataset.slider !== undefined) element.value = String(value ?? element.min ?? 0);
    else if (element.dataset.sliderNumber !== undefined) element.value = String(value ?? element.min ?? 0);
    else if (element.type === 'checkbox') element.checked = Boolean(value);
    else element.value = value ?? '';
  }
}

async function loadConfig() {
  const data = await api('api/config');
  state.config = data.config ?? {};
  $('config-path').textContent = data.path ?? 'data/config.json';
  $('config-json-text').value = JSON.stringify(state.config, null, 2);
  fillForm();
}

async function saveSettings() {
  const button = $('config-save');
  button.disabled = true;
  note($('save-note'), 'saving…');
  try {
    const result = await api('api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(collect()),
    });
    state.config = result.config;
    fillForm();
    $('config-json-text').value = JSON.stringify(state.config, null, 2);
    const adjusted = result.adjusted ?? [];
    const messages = ['saved'];
    if (adjusted.length) messages.push(`${adjusted.length} value${adjusted.length === 1 ? '' : 's'} kept in range: ${adjusted.map((item) => item.key).join(', ')}`);
    if (result.restartRequired) messages.push('restart to apply the host or port change');
    note($('save-note'), messages.join(' — '), 'good');
    await refreshStatus();
  } catch (error) {
    note($('save-note'), `not saved: ${error.message}`, 'bad');
  } finally {
    button.disabled = false;
    setTimeout(() => { if ($('save-note').textContent === 'saved') $('save-note').textContent = ''; }, 4000);
  }
}

async function testDecision() {
  const result = $('test-decision-result');
  note(result, 'asking…');
  try {
    const body = collect();
    const data = await api('api/test/decision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: body.decision?.baseUrl, key: body.decision?.apiKey, model: body.decision?.model }),
    });
    note(
      result,
      data.ok ? `${data.note} ${data.models.length} model(s): ${data.models.slice(0, 6).join(', ')}` : `failed: ${data.error}`,
      data.ok ? 'good' : 'bad',
    );
  } catch (error) {
    note(result, `failed: ${error.message}`, 'bad');
  }
}

async function testHa() {
  const result = $('test-ha-result');
  note(result, 'connecting…');
  try {
    const body = collect();
    const data = await api('api/test/ha', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: body.catalog?.haUrl, token: body.catalog?.haToken }),
    });
    note(
      result,
      data.ok
        ? `connected — ${data.entities} entities, ${data.areas} areas, ${data.domains} domains. e.g. ${(data.sample ?? []).join(', ')}`
        : `failed: ${data.error}`,
      data.ok ? 'good' : 'bad',
    );
  } catch (error) {
    note(result, `failed: ${error.message}`, 'bad');
  }
}

async function testUpstream() {
  const result = $('test-upstream-result');
  note(result, 'asking…');
  try {
    const body = collect();
    const data = await api('api/test/upstream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: body.upstream?.baseUrl, key: body.upstream?.apiKey }),
    });
    note(
      result,
      data.ok ? `reachable in ${data.ms} ms${data.models?.length ? ` — ${data.models.slice(0, 6).join(', ')}` : ''}` : `failed: ${data.error}`,
      data.ok ? 'good' : 'bad',
    );
  } catch (error) {
    note(result, `failed: ${error.message}`, 'bad');
  }
}

/* ------------------------------------------------------------------- wiring */

$('nav').addEventListener('click', (event) => {
  const button = event.target.closest('.tab[data-view]');
  if (!button) return;
  for (const tab of $('nav').querySelectorAll('.tab')) tab.classList.toggle('active', tab === button);
  $('view-monitor').classList.toggle('hidden', button.dataset.view !== 'monitor');
  $('view-settings').classList.toggle('hidden', button.dataset.view !== 'settings');
});

$('settings-tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('.tab[data-group]');
  if (tab) selectTab(tab.dataset.group);
});

$('show-advanced').addEventListener('change', (event) => {
  state.showAdvanced = event.target.checked;
  writePref('show-advanced', state.showAdvanced ? '1' : '0');
  refreshAdvancedVisibility();
});

// Sliders keep a range and a number box in step, so a threshold can be dialled or typed.
$('settings-panes').addEventListener('input', (event) => {
  const element = event.target;
  if (!element.dataset?.field) return;
  const wrapper = element.closest('.slider');
  if (!wrapper) return;
  if (element.dataset.slider !== undefined) wrapper.querySelector('[data-slider-number]').value = element.value;
  else wrapper.querySelector('[data-slider]').value = element.value;
});

$('settings-panes').addEventListener('click', (event) => {
  const remove = event.target.closest('.tpl-remove');
  if (remove) {
    remove.closest('.tpl-lang').remove();
    return;
  }
  const add = event.target.closest('.tpl-add-button');
  if (add) {
    const block = add.closest('[data-templates]');
    const input = block.querySelector('.tpl-new');
    const language = (input.value ?? '').trim().toLowerCase();
    if (!/^[a-z]{2,8}(-[a-z0-9]{2,8})?$/.test(language)) {
      input.focus();
      return;
    }
    if (block.querySelector(`.tpl-lang[data-lang="${language}"]`)) return;
    const rows = block.querySelector('.tpl-rows');
    rows.insertAdjacentHTML('beforeend', `
      <div class="tpl-lang" data-lang="${escapeHtml(language)}">
        <span class="lang">${escapeHtml(language)}</span>
        <input data-part="done" value="{action} {entity}." spellcheck="false" />
        <input data-part="clarify" value="Which one did you mean: {options}?" spellcheck="false" />
        <input data-part="confirm" value="Do you want me to {action} the {entity}?" spellcheck="false" />
        <button type="button" class="ghost tpl-remove" title="Remove this language">&times;</button>
      </div>`);
    input.value = '';
  }
});

$('config-save').addEventListener('click', saveSettings);

$('config-reload').addEventListener('click', async () => {
  await loadConfig();
  note($('save-note'), 'reloaded', 'good');
  setTimeout(() => { $('save-note').textContent = ''; }, 2500);
});

let resetArmed = false;
$('config-reset').addEventListener('click', async () => {
  const button = $('config-reset');
  if (!resetArmed) {
    resetArmed = true;
    button.textContent = 'Click again to reset';
    note($('save-note'), 'this restores every setting to its built-in default', 'warn');
    setTimeout(() => {
      resetArmed = false;
      button.textContent = 'Reset everything';
    }, 5000);
    return;
  }
  resetArmed = false;
  button.textContent = 'Reset everything';
  try {
    const result = await api('api/config/reset', { method: 'POST' });
    state.config = result.config;
    fillForm();
    $('config-json-text').value = JSON.stringify(state.config, null, 2);
    note($('save-note'), 'reset to defaults', 'good');
    await refreshStatus();
  } catch (error) {
    note($('save-note'), `not reset: ${error.message}`, 'bad');
  }
});

$('config-json').addEventListener('click', () => {
  $('json-panel').open = !$('json-panel').open;
  $('config-json-text').value = JSON.stringify(state.config, null, 2);
});

$('config-json-apply').addEventListener('click', async () => {
  let parsed;
  try {
    parsed = JSON.parse($('config-json-text').value);
  } catch (error) {
    note($('json-note'), `invalid JSON: ${error.message}`, 'bad');
    return;
  }
  try {
    const result = await api('api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(parsed),
    });
    state.config = result.config;
    fillForm();
    $('config-json-text').value = JSON.stringify(state.config, null, 2);
    note($('json-note'), 'applied', 'good');
    await refreshStatus();
  } catch (error) {
    note($('json-note'), `not applied: ${error.message}`, 'bad');
  }
});

$('settings-panes').addEventListener('click', (event) => {
  if (event.target.id === 'test-decision') testDecision();
  if (event.target.id === 'test-ha') testHa();
  if (event.target.id === 'test-upstream') testUpstream();
  if (event.target.id === 'catalog-refresh') {
    const result = $('catalog-refresh-result');
    note(result, 'reading…');
    api('api/catalog/refresh', { method: 'POST' })
      .then((data) => {
        const catalog = data.catalog ?? {};
        note(result, `${catalog.entities?.length ?? 0} entities from ${catalog.source}${catalog.note ? ` — ${catalog.note}` : ''}`, catalog.source === 'ha-websocket' ? 'good' : 'warn');
        refreshStatus();
      })
      .catch((error) => note(result, `failed: ${error.message}`, 'bad'));
  }
});

$('probe-run').addEventListener('click', () => runProbe());
$('probe-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') runProbe();
});
$('probe-samples').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-text]');
  if (button) runProbe(button.dataset.text);
});
$('trace-clear').addEventListener('click', async () => {
  await api('api/trace', { method: 'DELETE' });
  renderTrace([]);
});
$('breaker-reset').addEventListener('click', async () => {
  await api('api/breaker/reset', { method: 'POST' });
  refreshStatus();
});

state.schema = await api('api/schema');
buildSettings();
await loadConfig();
await refreshStatus();
await refreshTrace();
setInterval(refreshStatus, 5000);
setInterval(refreshTrace, 2500);
