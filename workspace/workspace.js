(function () {
  'use strict';

  const DECIMAL_KEYS = ['sell', 'cost', 'ship', 'ad', 'fixed', 'feePct', 'units', 'targetPct', 'reservePct'];
  const SIMULATOR_KEYS = DECIMAL_KEYS.concat(['reserveEnabled', 'platform']);
  const PLATFORMS = ['3.3', '5.8', '10.8', '15', 'custom'];
  const ROLES = ['owner', 'editor', 'viewer'];
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const LABELS = {sell:'판매가',cost:'매입 원가',ship:'배송·부자재',ad:'건당 광고비',fixed:'배분 고정비',feePct:'수수료율',units:'월 판매 수량',targetPct:'목표 잔액률',reservePct:'충당금 비율',reserveEnabled:'충당금 사용',platform:'플랫폼 설정'};
  const ROLE_NAMES = {owner:'소유자',editor:'편집자',viewer:'조회자'};

  function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
  function exactKeys(value, keys) { return record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key)); }
  function validName(value) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(value)) throw Error('이름은 1~80자로 입력해 주세요');
    return value.trim();
  }
  function scaled(value) {
    const parts = value.split('.');
    return BigInt(parts[0]) * 1000000n + BigInt((parts[1] || '').padEnd(6, '0'));
  }
  function validateSimulator(value) {
    if (!exactKeys(value, SIMULATOR_KEYS)) throw Error('simulator에는 안내된 11개 항목만 모두 포함해야 합니다');
    DECIMAL_KEYS.forEach(key => {
      const input = value[key];
      if (typeof input !== 'string' || !/^(0|[1-9]\d{0,12})(?:\.\d{1,6})?$/.test(input)) throw Error(LABELS[key] + '은 앞자리 0과 쉼표 없이 소수 6자리 이내의 숫자 문자열로 입력해 주세요');
      if (key === 'units') {
        if (scaled(input) > 1000000000000000n) throw Error('판매 수량은 0~10억 범위로 입력해 주세요');
      } else if (scaled(input) > (/Pct$/.test(key) ? 100000000n : 1000000000000000000n)) {
        throw Error(LABELS[key] + (/Pct$/.test(key) ? '은 0~100 범위로 입력해 주세요' : '는 최대 1조 원까지 입력할 수 있습니다'));
      }
    });
    if (typeof value.reserveEnabled !== 'boolean' || !PLATFORMS.includes(value.platform)) throw Error('충당금 사용 여부 또는 플랫폼 설정을 확인해 주세요');
    return Object.fromEntries(SIMULATOR_KEYS.map(key => [key, value[key]]));
  }
  function parseImport(source) {
    if (typeof source !== 'string' || new TextEncoder().encode(source).length > 32768) throw Error('JSON 입력은 32KB 이내로 선택해 주세요');
    let value;
    try { value = JSON.parse(source); } catch (_) { throw Error('올바른 JSON 형식인지 확인해 주세요'); }
    if (exactKeys(value, ['name', 'simulator'])) return {name:validName(value.name),simulator:validateSimulator(value.simulator)};
    return {name:null,simulator:validateSimulator(value)};
  }
  function validVersion(value) { return Number.isSafeInteger(value) && value > 0; }
  function validDate(value) { return typeof value === 'string' && value.length < 64 && Number.isFinite(Date.parse(value)); }
  function validWorkspace(value) {
    return record(value) && UUID.test(value.id) && typeof value.name === 'string' && value.name.length <= 80 && ROLES.includes(value.role) && validVersion(value.version) && validDate(value.createdAt) && validDate(value.updatedAt);
  }
  function validScenario(value) {
    if (!record(value) || !UUID.test(value.id) || typeof value.name !== 'string' || value.name.length > 80 || !validVersion(value.version) || !validDate(value.createdAt) || !validDate(value.updatedAt)) return false;
    try { validateSimulator(value.simulator); return true; } catch (_) { return false; }
  }
  function validMember(value) {
    return record(value) && UUID.test(value.id) && typeof value.email === 'string' && value.email.length <= 254 && ROLES.includes(value.role) && ['active','pending'].includes(value.status) && validVersion(value.version);
  }
  function uniqueIds(rows) { return new Set(rows.map(row => row.id)).size === rows.length; }
  function validateList(value) {
    if (!record(value) || !record(value.identity) || typeof value.identity.subject !== 'string' || typeof value.identity.email !== 'string' || !Array.isArray(value.workspaces) || value.workspaces.length > 100 || !value.workspaces.every(validWorkspace) || !uniqueIds(value.workspaces)) throw Error('invalid_response');
    return value;
  }
  function validateDetail(value, id) {
    if (!record(value) || !validWorkspace(value.workspace) || value.workspace.id !== id || !Array.isArray(value.members) || value.members.length > 50 || !value.members.every(validMember) || !uniqueIds(value.members) || !Array.isArray(value.scenarios) || value.scenarios.length > 100 || !value.scenarios.every(validScenario) || !uniqueIds(value.scenarios)) throw Error('invalid_response');
    return value;
  }
  function sameDecimal(a, b) { return scaled(a) === scaled(b); }
  function formatDecimal(value) {
    const parts = value.split('.');
    const whole = parts[0].replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return whole + (parts.length === 2 ? '.' + parts[1] : '');
  }

  // Pure validators are exported only in Node for contract checks
  if (typeof module === 'object' && module.exports) module.exports = {validateSimulator,parseImport,validateList,validateDetail,validName,sameDecimal,formatDecimal};
  if (typeof document === 'undefined') return;

  const $ = id => document.getElementById(id);
  const state = {identity:null,workspaces:[],detail:null,scenarioId:null,draft:false,dirty:false,busy:false,connected:false,locked:false,compared:new Set()};
  let generation = 0, importGeneration = 0;
  function element(tag, value, className) { const node = document.createElement(tag); if (value !== undefined) node.textContent = value; if (className) node.className = className; return node; }
  function status(message, error) { $('status').className = 'status' + (error ? ' error' : ''); $('status').textContent = message; }
  function dateTime(value) { return new Intl.DateTimeFormat('ko-KR', {timeZone:'Asia/Seoul',dateStyle:'short',timeStyle:'short'}).format(new Date(value)); }
  function selectedScenario() { return state.detail && state.detail.scenarios.find(item => item.id === state.scenarioId); }
  function role() { return state.detail ? state.detail.workspace.role : null; }
  function canWrite() { return ['owner','editor'].includes(role()); }
  function rootPath() { return '/api/workspaces/' + encodeURIComponent(state.detail.workspace.id); }
  function confirmDiscard() { return !state.dirty || window.confirm('저장하지 않은 편집 내용이 있습니다\n현재 입력을 버리고 계속할까요?'); }
  function markDirty() { if (!state.draft || state.busy) return; state.dirty = true; renderEditorState(); }
  function renderEditorState() {
    const badge = $('editorState');
    badge.className = 'badge' + (state.dirty ? ' unsaved' : state.draft ? ' active' : '');
    badge.textContent = state.dirty ? '저장하지 않음' : state.draft ? (state.scenarioId ? '서버 저장값' : '새 입력') : '선택 대기';
  }
  function syncControls() {
    const locked = state.busy || state.locked;
    const writable = canWrite() && !locked;
    const owner = role() === 'owner' && !locked;
    $('workspaceSelect').disabled = state.busy || !state.connected || !state.workspaces.length;
    $('refresh').disabled = state.busy;
    $('newWorkspaceName').disabled = locked || !state.connected;
    $('createWorkspace').disabled = locked || !state.connected;
    $('renameWorkspace').disabled = !owner;
    $('deleteWorkspace').disabled = !owner;
    $('newScenario').disabled = !writable;
    $('scenarioFields').disabled = !writable || !state.draft;
    $('saveScenario').disabled = !writable || !state.draft;
    $('deleteScenario').disabled = !writable || !state.scenarioId;
    $('copyScenario').disabled = state.busy || !state.draft;
    $('importFile').disabled = !writable;
    $('importJson').disabled = !writable;
    $('applyImport').disabled = !writable;
    ['memberEmail','memberRole','addMember'].forEach(id => { $(id).disabled = !owner; });
    document.querySelectorAll('.scenario-open').forEach(button => { button.disabled = state.busy; });
    document.querySelectorAll('.compare-input').forEach(input => { input.disabled = state.busy; });
    document.querySelectorAll('.member-edit').forEach(input => { input.disabled = !owner; });
    $('clearComparison').disabled = state.busy || state.compared.size === 0;
    $('main').setAttribute('aria-busy', state.busy ? 'true' : 'false');
    renderEditorState();
  }
  class ApiError extends Error {
    constructor(code, statusCode, uncertain) { super(code); this.statusCode = statusCode || 0; this.uncertain = !!uncertain; }
  }
  async function api(path, options) {
    const config = options || {}, method = config.method || 'GET';
    const mutation = method !== 'GET';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const headers = {'Accept':'application/json'};
    if (mutation) headers['Content-Type'] = 'application/json';
    if (config.version !== undefined) headers['If-Match'] = '"' + config.version + '"';
    try {
      const response = await fetch(path, {method,headers,credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,body:mutation ? JSON.stringify(config.data || {}) : undefined});
      let data;
      try {
        if (!(response.headers.get('content-type') || '').includes('application/json')) throw Error();
        data = await response.json();
      } catch (_) { throw new ApiError('invalid_response',response.status,mutation); }
      if (!response.ok) throw new ApiError(typeof data.error === 'string' ? data.error : 'request_failed',response.status,mutation && response.status >= 500);
      return data;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(error.name === 'AbortError' ? 'request_timeout' : 'network_error',0,mutation);
    } finally { clearTimeout(timer); }
  }
  function explainError(error) {
    const messages = {
      workspace_not_configured:'Cloud Workspace 서버가 설정되지 않았습니다 · 서버 연결 후 사용할 수 있습니다',
      unauthorized:'로그인 상태를 확인할 수 없습니다 · 다시 로그인한 뒤 새로고침해 주세요',
      role_not_allowed:'현재 계정에 이 작업 권한이 없습니다 · 새로고침으로 권한을 확인해 주세요',
      precondition_failed:'다른 사용자가 먼저 변경했습니다 · 현재 입력은 보존했으며 새로고침 전까지 저장을 중지합니다',
      precondition_required:'변경 기준 버전을 확인할 수 없습니다 · 새로고침한 뒤 다시 시도해 주세요',
      last_owner_required:'활성 소유자가 최소 1명 필요합니다 · 다른 소유자가 로그인한 뒤 변경해 주세요',
      workspace_not_found:'작업공간이 없거나 접근 권한이 변경되었습니다 · 새로고침으로 확인해 주세요',
      record_not_found:'항목이 없거나 이미 삭제되었습니다 · 새로고침으로 확인해 주세요',
      member_already_exists:'이미 등록된 이메일입니다 · 기존 멤버의 권한을 확인해 주세요',
      workspace_limit_reached:'계정의 작업공간 생성 한도에 도달했습니다',
      member_limit_reached:'작업공간의 멤버 한도에 도달했습니다',
      membership_limit_reached:'해당 이메일의 작업공간 참여 한도에 도달했습니다',
      scenario_limit_reached:'작업공간의 시나리오 저장 한도에 도달했습니다',
      workspace_limit:'작업공간 생성 또는 참여 한도에 도달했습니다',
      member_exists_or_limit:'이미 등록된 이메일이거나 멤버 참여 한도에 도달했습니다',
      scenario_limit:'작업공간의 시나리오 저장 한도에 도달했습니다',
      invalid_response:'서버 응답을 읽을 수 없습니다 · 로그인 상태와 서버 연결을 확인해 주세요',
      network_error:'작업공간 서버에 연결할 수 없습니다 · 네트워크와 로그인 상태를 확인해 주세요',
      request_timeout:'서버 응답 대기 시간이 초과되었습니다 · 연결 상태를 확인해 주세요'
    };
    if (error.uncertain) return '서버의 실행 결과를 확인하지 못했습니다 · 중복 실행을 막기 위해 변경을 중지했으니 새로고침으로 저장 상태를 확인해 주세요';
    if (error.statusCode === 401) return messages.unauthorized;
    if (messages[error.message]) return messages[error.message];
    if (error.statusCode === 403) return messages.role_not_allowed;
    if (error.statusCode === 412) return messages.precondition_failed;
    if (error.statusCode === 429) return '요청 한도에 도달했습니다 · 잠시 후 새로고침해 주세요';
    if (error.statusCode === 400) return '입력값을 서버에서 허용하지 않았습니다 · 이름과 숫자 형식을 확인해 주세요';
    if (error.statusCode >= 500) return '작업공간 서버를 사용할 수 없습니다 · 현재 입력을 보존했으니 연결 후 다시 확인해 주세요';
    return '요청을 완료하지 못했습니다 · 현재 입력을 보존했으니 새로고침으로 서버 상태를 확인해 주세요';
  }
  function handleError(error) {
    if (error.uncertain || [401,403,404,412,428].includes(error.statusCode)) state.locked = true;
    status(explainError(error),true);
  }
  function renderWorkspaceOptions() {
    const currentId = state.detail && state.detail.workspace.id;
    $('workspaceSelect').replaceChildren();
    if (!state.workspaces.length) {
      const option = element('option',state.connected ? '작업공간 없음 · 새로 만들어 주세요' : '서버 연결 후 선택 가능'); option.value = ''; $('workspaceSelect').append(option);
    } else state.workspaces.forEach(workspace => {
      const option = element('option',workspace.name + ' · ' + ROLE_NAMES[workspace.role]); option.value = workspace.id; $('workspaceSelect').append(option);
    });
    if (currentId) $('workspaceSelect').value = currentId;
  }
  function renderWorkspace() {
    const detail = state.detail;
    renderWorkspaceOptions();
    $('roleBadge').className = 'badge' + (detail ? ' active' : '');
    $('roleBadge').textContent = detail ? ROLE_NAMES[detail.workspace.role] : state.connected ? '선택 대기' : '연결 대기';
    $('workspaceMeta').textContent = detail ? '변경 ' + dateTime(detail.workspace.updatedAt) + ' · 서울 기준 · 버전 ' + detail.workspace.version : '작업공간을 불러오면 권한과 갱신 시간을 표시';
    renderScenarios(); renderMembers(); renderComparison(); syncControls();
  }
  function clearEditor() {
    importGeneration++;
    state.scenarioId = null; state.draft = false; state.dirty = false;
    $('scenarioForm').reset(); $('editorHeading').textContent = '시나리오 편집';
    $('editorMeta').textContent = '목록에서 시나리오를 열거나 새 시나리오를 만들어 주세요';
    $('importJson').value = ''; $('importFile').value = '';
    renderEditorState();
  }
  function fillEditor(scenario) {
    importGeneration++;
    state.scenarioId = scenario ? scenario.id : null; state.draft = true; state.dirty = false;
    $('scenarioForm').reset();
    $('scenarioName').value = scenario ? scenario.name : '';
    DECIMAL_KEYS.forEach(key => { $(key).value = scenario ? scenario.simulator[key] : key === 'units' ? '1' : ''; });
    $('reserveEnabled').checked = scenario ? scenario.simulator.reserveEnabled : false;
    $('platform').value = scenario ? scenario.simulator.platform : 'custom';
    $('editorHeading').textContent = scenario ? (canWrite() ? '시나리오 편집' : '시나리오 조회') : '새 시나리오';
    $('editorMeta').textContent = scenario ? '서버 갱신 ' + dateTime(scenario.updatedAt) + ' · 버전 ' + scenario.version + (canWrite() ? '' : ' · 조회 권한') : '입력한 값은 저장 버튼을 눌러야 서버에 반영';
    syncControls(); renderScenarios();
  }
  function readEditor() {
    const simulator = Object.fromEntries(DECIMAL_KEYS.map(key => [key,$(key).value.trim()]));
    simulator.reserveEnabled = $('reserveEnabled').checked; simulator.platform = $('platform').value;
    return {name:validName($('scenarioName').value),simulator:validateSimulator(simulator)};
  }
  function renderScenarios() {
    const list = $('scenarioList'); list.replaceChildren();
    const scenarios = state.detail ? state.detail.scenarios : [];
    $('scenarioCount').textContent = state.detail ? scenarios.length + '개' : '—';
    if (!scenarios.length) { list.append(element('p',state.detail ? '서버에 저장한 시나리오가 없습니다' : '작업공간을 선택하면 서버에 저장한 시나리오를 표시','empty')); return; }
    scenarios.forEach(scenario => {
      const card = element('article',undefined,'scenario-card' + (state.scenarioId === scenario.id ? ' selected' : ''));
      const open = element('button',undefined,'scenario-open'); open.type = 'button'; open.disabled = state.busy;
      open.setAttribute('aria-pressed',state.scenarioId === scenario.id ? 'true' : 'false');
      open.append(element('strong',scenario.name),element('small',dateTime(scenario.updatedAt) + ' · v' + scenario.version));
      open.addEventListener('click',() => { if (state.busy || !confirmDiscard()) return; fillEditor(scenario); $('editorHeading').scrollIntoView({block:'nearest'}); });
      const label = element('label',undefined,'compare-check'); const check = document.createElement('input');
      check.type = 'checkbox'; check.className = 'compare-input'; check.checked = state.compared.has(scenario.id); check.disabled = state.busy;
      check.setAttribute('aria-label',scenario.name + ' 비교에 포함');
      check.addEventListener('change',() => {
        if (check.checked && state.compared.size >= 3) { check.checked = false; status('시나리오는 최대 3개까지 함께 비교할 수 있습니다',true); return; }
        if (check.checked) state.compared.add(scenario.id); else state.compared.delete(scenario.id);
        renderComparison(); syncControls();
      });
      label.append(check,element('span','비교에 포함')); card.append(open,label); list.append(card);
    });
  }
  function comparisonValue(simulator, key) {
    if (key === 'reserveEnabled') return simulator[key] ? '사용' : '미사용';
    if (key === 'platform') return simulator[key] === 'custom' ? '직접 입력' : simulator[key] + '% 프리셋';
    return formatDecimal(simulator[key]) + (key === 'units' ? '개' : /Pct$/.test(key) ? '%' : '원');
  }
  function renderComparison() {
    const records = state.detail ? state.detail.scenarios.filter(scenario => state.compared.has(scenario.id)) : [];
    $('comparisonTableWrap').hidden = !records.length; $('comparisonEmpty').hidden = !!records.length;
    $('comparisonHead').replaceChildren(); $('comparisonBody').replaceChildren();
    if (!records.length) return;
    const header = document.createElement('tr'); const first = element('th','저장 항목'); first.scope = 'col'; header.append(first);
    records.forEach(scenario => { const cell = element('th',scenario.name); cell.scope = 'col'; header.append(cell); }); $('comparisonHead').append(header);
    SIMULATOR_KEYS.forEach(key => {
      const row = document.createElement('tr'), label = element('th',LABELS[key]); label.scope = 'row'; row.append(label);
      const baseline = records[0].simulator[key];
      const different = records.some(scenario => DECIMAL_KEYS.includes(key) ? !sameDecimal(scenario.simulator[key],baseline) : scenario.simulator[key] !== baseline);
      records.forEach(scenario => { const cell = element('td',comparisonValue(scenario.simulator,key),different ? 'different' : ''); row.append(cell); }); $('comparisonBody').append(row);
    });
  }
  function renderMembers() {
    $('memberRows').replaceChildren();
    const members = state.detail ? state.detail.members : [];
    $('memberCount').textContent = state.detail ? members.length + '명' : '—';
    $('membersTableWrap').hidden = !members.length; $('membersEmpty').hidden = !!members.length;
    members.forEach(member => {
      const row = document.createElement('tr'), email = element('td',member.email,'member-email');
      if (state.identity && member.email.toLowerCase() === state.identity.email.toLowerCase()) email.append(element('small',' · 나'));
      row.append(email,element('td',member.status === 'active' ? '활성' : '로그인 대기'));
      const roleCell = document.createElement('td');
      if (role() === 'owner') {
        const select = document.createElement('select'); select.className = 'member-edit'; select.setAttribute('aria-label',member.email + ' 권한');
        ROLES.forEach(value => { const option = element('option',ROLE_NAMES[value]); option.value = value; select.append(option); }); select.value = member.role; roleCell.append(select); row.append(roleCell);
        const controls = document.createElement('td'), group = element('div',undefined,'member-actions');
        const update = element('button','변경','secondary member-edit'); update.type = 'button'; update.setAttribute('aria-label',member.email + ' 권한 변경');
        update.addEventListener('click',() => updateMember(member,select.value));
        const remove = element('button','삭제','quiet danger member-edit'); remove.type = 'button'; remove.setAttribute('aria-label',member.email + ' 멤버 삭제'); remove.addEventListener('click',() => deleteMember(member));
        group.append(update,remove); controls.append(group); row.append(controls);
      } else { roleCell.textContent = ROLE_NAMES[member.role]; row.append(roleCell,element('td','소유자만 관리')); }
      $('memberRows').append(row);
    });
  }
  async function readServer(preferredWorkspace, preferredScenario) {
    const list = validateList(await api('/api/workspaces'));
    const selected = list.workspaces.find(item => item.id === preferredWorkspace) || list.workspaces[0];
    const detail = selected ? validateDetail(await api('/api/workspaces/' + encodeURIComponent(selected.id)),selected.id) : null;
    state.identity = list.identity; state.workspaces = list.workspaces; state.detail = detail; state.connected = true; state.locked = false;
    state.compared = new Set(Array.from(state.compared).filter(id => detail && detail.scenarios.some(item => item.id === id)));
    $('identity').textContent = list.identity.email;
    const limit = list.limits && list.limits.workspacesPerCreator;
    $('workspaceLimits').textContent = Number.isSafeInteger(limit) && limit > 0 ? '계정당 최대 ' + limit + '개 생성 · 생성한 계정이 첫 소유자' : '생성한 계정이 첫 소유자';
    clearEditor(); renderWorkspace();
    const scenario = detail && detail.scenarios.find(item => item.id === preferredScenario);
    if (scenario) fillEditor(scenario);
  }
  async function refresh() {
    if (state.busy || !confirmDiscard()) return;
    const preferredWorkspace = state.detail && state.detail.workspace.id, preferredScenario = state.scenarioId;
    state.busy = true; syncControls(); status('작업공간 서버 연결 확인 중');
    const token = ++generation;
    try {
      await readServer(preferredWorkspace,preferredScenario);
      if (token !== generation) return;
      status(state.detail ? '서버 저장값을 불러왔습니다 · 계정 권한에 따라 작업할 수 있습니다' : '서버 연결 정상 · 새 작업공간을 만들어 시작해 주세요');
    } catch (error) {
      state.locked = true;
      if (!state.connected) $('identity').textContent = '계정 확인 안 됨';
      handleError(error);
    } finally { if (token === generation) { state.busy = false; syncControls(); } }
  }
  async function selectWorkspace(id) {
    if (state.busy || !confirmDiscard()) { $('workspaceSelect').value = state.detail ? state.detail.workspace.id : ''; return; }
    if (!state.workspaces.some(item => item.id === id)) return;
    state.busy = true; syncControls(); status('작업공간을 불러오는 중');
    try {
      const detail = validateDetail(await api('/api/workspaces/' + encodeURIComponent(id)),id);
      state.detail = detail; state.compared.clear(); state.locked = false; clearEditor(); renderWorkspace(); status('서버 저장값을 불러왔습니다 · ' + ROLE_NAMES[detail.workspace.role] + ' 권한');
    } catch (error) { $('workspaceSelect').value = state.detail ? state.detail.workspace.id : ''; handleError(error); }
    finally { state.busy = false; syncControls(); }
  }
  async function mutate(action, message, refreshTarget) {
    if (state.busy || state.locked) return false;
    state.busy = true; syncControls(); status('서버에 변경 요청 중');
    let committed = false;
    try {
      const result = await action(); committed = true;
      const target = refreshTarget ? refreshTarget(result) : {workspaceId:state.detail && state.detail.workspace.id,scenarioId:state.scenarioId};
      await readServer(target.workspaceId,target.scenarioId);
      status(message); return true;
    } catch (error) {
      if (committed) { state.locked = true; status('변경 요청은 성공했지만 최신 목록을 읽지 못했습니다 · 새로고침으로 서버 상태를 확인해 주세요',true); }
      else handleError(error);
      return false;
    } finally { state.busy = false; syncControls(); }
  }
  async function createWorkspace(event) {
    event.preventDefault(); if (!state.connected || state.busy || state.locked || !confirmDiscard()) return;
    let name; try { name = validName($('newWorkspaceName').value); } catch (error) { status(error.message,true); return; }
    const succeeded = await mutate(() => api('/api/workspaces',{method:'POST',data:{name}}),'작업공간을 서버에 만들었습니다',result => {
      if (!result.workspace || !UUID.test(result.workspace.id)) throw new ApiError('invalid_response',200,true);
      return {workspaceId:result.workspace.id,scenarioId:null};
    });
    if (succeeded) { $('newWorkspaceName').value = ''; $('createDetails').open = false; }
  }
  async function renameWorkspace(event) {
    event.preventDefault(); if (role() !== 'owner' || state.busy || state.locked) return;
    let name; try { name = validName($('renameInput').value); } catch (error) { status(error.message,true); return; }
    const workspace = state.detail.workspace;
    if (name === workspace.name) { $('renameDialog').close(); return; }
    if (!confirmDiscard() || !window.confirm('작업공간 이름을 변경할까요?\n' + workspace.name + ' → ' + name)) return;
    $('renameDialog').close();
    await mutate(() => api(rootPath(),{method:'PUT',data:{name},version:workspace.version}),'작업공간 이름을 변경했습니다');
  }
  async function deleteWorkspace() {
    if (role() !== 'owner' || state.busy || state.locked) return;
    const workspace = state.detail.workspace;
    if (!window.confirm('「' + workspace.name + '」 작업공간을 삭제할까요?\n저장한 시나리오와 멤버 등록이 함께 삭제되며 되돌릴 수 없습니다' + (state.dirty ? '\n저장하지 않은 입력도 사라집니다' : ''))) return;
    await mutate(() => api(rootPath(),{method:'DELETE',data:{},version:workspace.version}),'작업공간을 삭제했습니다',() => ({workspaceId:null,scenarioId:null}));
  }
  async function saveScenario(event) {
    event.preventDefault(); if (!canWrite() || !state.draft || state.busy || state.locked) return;
    let data; try { data = readEditor(); } catch (error) { status(error.message,true); return; }
    const existing = selectedScenario();
    if (existing && !window.confirm('「' + existing.name + '」 시나리오의 서버 저장값을 현재 입력으로 변경할까요?')) return;
    const path = rootPath() + '/scenarios' + (existing ? '/' + encodeURIComponent(existing.id) : '');
    await mutate(() => api(path,{method:existing ? 'PUT' : 'POST',data,version:existing ? existing.version : undefined}),'시나리오를 서버에 저장했습니다',result => {
      if (!result.scenario || !UUID.test(result.scenario.id)) throw new ApiError('invalid_response',200,true);
      return {workspaceId:state.detail.workspace.id,scenarioId:result.scenario.id};
    });
  }
  async function deleteScenario() {
    const scenario = selectedScenario();
    if (!canWrite() || !scenario || state.busy || state.locked || !window.confirm('「' + scenario.name + '」 시나리오를 삭제할까요?\n이 작업은 되돌릴 수 없습니다' + (state.dirty ? '\n저장하지 않은 입력도 사라집니다' : ''))) return;
    await mutate(() => api(rootPath() + '/scenarios/' + encodeURIComponent(scenario.id),{method:'DELETE',data:{},version:scenario.version}),'시나리오를 삭제했습니다',() => ({workspaceId:state.detail.workspace.id,scenarioId:null}));
  }
  async function addMember(event) {
    event.preventDefault(); if (role() !== 'owner' || state.busy || state.locked || !confirmDiscard()) return;
    const email = $('memberEmail').value.trim().toLowerCase(), memberRole = $('memberRole').value;
    if (!ROLES.includes(memberRole)) return;
    if (!window.confirm(email + ' 계정을 ' + ROLE_NAMES[memberRole] + '로 등록할까요?\n이 계정은 로그인 후 작업공간에 접근할 수 있습니다')) return;
    const succeeded = await mutate(() => api(rootPath() + '/members',{method:'POST',data:{email,role:memberRole}}),'멤버를 등록했습니다 · 초대 메일은 발송하지 않습니다');
    if (succeeded) { $('memberEmail').value = ''; $('memberRole').value = 'viewer'; }
  }
  async function updateMember(member, nextRole) {
    if (role() !== 'owner' || state.busy || state.locked || !ROLES.includes(nextRole) || nextRole === member.role) return;
    if (!confirmDiscard() || !window.confirm(member.email + ' 계정의 권한을 변경할까요?\n' + ROLE_NAMES[member.role] + ' → ' + ROLE_NAMES[nextRole])) return;
    await mutate(() => api(rootPath() + '/members/' + encodeURIComponent(member.id),{method:'PUT',data:{role:nextRole},version:member.version}),'멤버 권한을 변경했습니다');
  }
  async function deleteMember(member) {
    if (role() !== 'owner' || state.busy || state.locked) return;
    if (!confirmDiscard() || !window.confirm(member.email + ' 계정을 작업공간에서 삭제할까요?\n삭제한 계정은 이 작업공간에 접근할 수 없습니다')) return;
    await mutate(() => api(rootPath() + '/members/' + encodeURIComponent(member.id),{method:'DELETE',data:{},version:member.version}),'멤버 등록을 삭제했습니다');
  }
  function applyImport() {
    if (!canWrite() || state.busy || state.locked) return;
    let imported; try { imported = parseImport($('importJson').value); } catch (error) { status(error.message,true); return; }
    if (state.draft && !window.confirm('현재 편집기 입력을 선택한 JSON 값으로 바꿀까요?\n서버 저장값은 저장 버튼을 눌러야 변경됩니다')) return;
    if (!state.draft) fillEditor(null);
    if (imported.name) $('scenarioName').value = imported.name;
    DECIMAL_KEYS.forEach(key => { $(key).value = imported.simulator[key]; });
    $('platform').value = imported.simulator.platform; $('reserveEnabled').checked = imported.simulator.reserveEnabled;
    state.dirty = true; syncControls(); status('선택한 JSON을 편집기에 가져왔습니다 · 서버에는 아직 저장하지 않았습니다');
  }
  async function copyScenario() {
    if (!state.draft || state.busy) return;
    let source; try { source = JSON.stringify(readEditor(),null,2); } catch (error) { status(error.message,true); return; }
    try { await navigator.clipboard.writeText(source); status('현재 입력 JSON을 복사했습니다 · 서버 저장은 별도입니다'); }
    catch (_) { $('importJson').value = source; $('importDetails').open = true; $('importJson').disabled = false; $('importJson').focus(); $('importJson').select(); status('자동 복사를 사용할 수 없어 JSON 입력란에 표시했습니다 · 직접 복사해 주세요'); }
  }

  $('refresh').addEventListener('click',refresh);
  $('workspaceSelect').addEventListener('change',event => selectWorkspace(event.target.value));
  $('createWorkspaceForm').addEventListener('submit',createWorkspace);
  $('renameWorkspace').addEventListener('click',() => { if (role() !== 'owner' || state.busy || state.locked) return; $('renameInput').value = state.detail.workspace.name; $('renameDialog').showModal(); $('renameInput').select(); });
  $('renameForm').addEventListener('submit',renameWorkspace);
  $('cancelRename').addEventListener('click',() => $('renameDialog').close());
  $('deleteWorkspace').addEventListener('click',deleteWorkspace);
  $('newScenario').addEventListener('click',() => { if (canWrite() && !state.busy && !state.locked && confirmDiscard()) { fillEditor(null); $('scenarioName').focus(); } });
  $('scenarioForm').addEventListener('submit',saveScenario);
  $('scenarioFields').addEventListener('input',event => { if (event.target.id === 'feePct') $('platform').value = 'custom'; markDirty(); });
  $('scenarioFields').addEventListener('change',markDirty);
  $('platform').addEventListener('change',() => { if ($('platform').value !== 'custom') $('feePct').value = $('platform').value; markDirty(); });
  $('deleteScenario').addEventListener('click',deleteScenario);
  $('copyScenario').addEventListener('click',copyScenario);
  $('clearComparison').addEventListener('click',() => { state.compared.clear(); renderScenarios(); renderComparison(); syncControls(); });
  $('memberForm').addEventListener('submit',addMember);
  $('applyImport').addEventListener('click',applyImport);
  $('importFile').addEventListener('change',async () => {
    const token = ++importGeneration;
    const file = $('importFile').files && $('importFile').files[0]; if (!file) return;
    if (file.size > 32768) { status('JSON 파일은 32KB 이내로 선택해 주세요',true); $('importFile').value = ''; return; }
    try { const source = await file.text(); if (token !== importGeneration) return; parseImport(source); $('importJson').value = source; status('선택한 파일을 읽었습니다 · 편집기에 가져오기를 누르면 입력값에 반영'); }
    catch (_) { if (token === importGeneration) status('파일을 읽지 못했거나 지원하지 않는 JSON입니다 · 11개 입력 항목과 숫자 문자열을 확인해 주세요',true); }
  });
  window.addEventListener('beforeunload',event => { if (state.dirty || state.busy) { event.preventDefault(); event.returnValue = ''; } });
  syncControls(); refresh();
})();
