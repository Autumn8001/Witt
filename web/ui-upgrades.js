(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const ui = window.WittUI;
  if (!ui) return;
  let menuId = null, returnFocus = null, longPressTimer, pressOrigin, suppressClick = false;
  const escape = value => { const node = document.createElement('span'); node.textContent = String(value || ''); return node.innerHTML; };
  const sheets = ['conversationActions', 'conversationRenameSheet', 'taskOverviewSheet'];
  const close = (restore = true) => {
    sheets.forEach(id => { $(`#${id}`).hidden = true; });
    if (restore && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  };
  const open = id => {
    returnFocus = document.activeElement;
    close(false);
    const sheet = $(`#${id}`); sheet.hidden = false;
    sheet.querySelector('section button, form input')?.focus({ preventScroll: true });
  };
  const taskLabels = { running:'正在执行', queued:'排队中', awaiting_confirmation:'等待确认', waiting_confirmation:'等待确认', completed:'已完成', failed:'失败', interrupted:'已暂停', idle:'尚未开始' };
  function renderTasks(conversations, limit) {
    window.WittFeatures?.watch(conversations);
    const active = conversations.filter(item => item.busy || ['queued','running','awaiting_confirmation','waiting_confirmation'].includes(ui.task(item).state));
    $('#taskOverviewCount').textContent = String(active.length);
    $('#taskOverviewButton').classList.toggle('has-tasks', active.length > 0);
    $('#taskOverviewButton').setAttribute('aria-label', `查看全部任务，${active.length} 项进行中`);
    const running = active.filter(item => ui.task(item).state !== 'queued').length;
    $('#taskOverviewSummary').textContent = `${running} 项执行中 · ${active.length-running} 项排队 · 最多同时执行 ${limit} 项`;
    const recent = conversations.filter(item => !active.includes(item) && ['completed','failed','interrupted'].includes(ui.task(item).state)).slice(0,8);
    const group = (title, entries) => entries.length ? `<h3>${title}</h3>${entries.map(item => {
      const task = ui.task(item);
      return `<button class="task-overview-row" type="button" data-select-task="${item.id}"><span class="task-overview-dot" data-state="${escape(task.state)}"></span><span><strong>${escape(item.title)}</strong><small>${escape(taskLabels[task.state] || task.label)}${item.queuePosition ? ' · 第 '+item.queuePosition+' 位' : ''}${item.waitingForProject ? ' · 等待项目：'+escape(item.waitingForProject) : ''}${item.activeDeviceLabel ? ' · '+escape(item.activeDeviceLabel) : ''}</small></span><span aria-hidden="true">↗</span></button>${task.state==='queued'?`<div class="task-controls"><button data-task-action="cancel" data-id="${item.id}">取消排队</button></div>`:['failed','interrupted'].includes(task.state)?`<div class="task-controls"><button data-task-action="retry" data-id="${item.id}">重试</button></div>`:''}`;
    }).join('')}` : '';
    $('#taskOverviewList').innerHTML = group('进行中',active) + group('最近结束',recent) || '<p class="tasks-empty">还没有任务。新建对话，开始第一项工作。</p>';
  }
  function openConversationMenu(id) {
    const item = ui.conversations().find(value => value.id === id);
    if (!item) return;
    menuId = id;
    $('#conversationActionsTitle').textContent = item.title;
    $('#conversationPinButton').innerHTML = `${item.pinned ? '取消置顶' : '置顶'} <span>⌖</span>`;
    $('#conversationArchiveButton').disabled = Boolean(item.busy);
    $('#conversationActions small').textContent = item.busy ? '任务进行中，暂停或完成后即可归档。' : '归档只移出列表，历史记录仍会保留。';
    open('conversationActions');
  }
  window.WittUpgrades = { renderTasks, openConversationMenu };
  document.querySelectorAll('[data-close-upgrade]').forEach(button => button.addEventListener('click', () => close()));
  $('#conversationRenameButton').addEventListener('click', () => {
    const item = ui.conversations().find(value => value.id === menuId);
    if (!item) return;
    open('conversationRenameSheet');
    $('#conversationRenameInput').value = item.title;
    $('#conversationRenameInput').focus(); $('#conversationRenameInput').select();
  });
  $('#conversationRenameForm').addEventListener('submit', event => {
    event.preventDefault(); const title = $('#conversationRenameInput').value.trim();
    if (!title || title.length > 100) return;
    if (ui.updateMetadata(menuId, { title })) close();
  });
  $('#conversationPinButton').addEventListener('click', () => { ui.togglePin(menuId); close(); });
  $('#conversationArchiveButton').addEventListener('click', () => { const id = menuId; close(false); ui.archive(id); });
  $('#taskOverviewButton').addEventListener('click', () => { open('taskOverviewSheet'); ui.refreshSummaries(); });
  $('#taskOverviewRefresh').addEventListener('click', () => { ui.refreshSummaries(); ui.toast('正在刷新任务状态'); });
  $('#taskOverviewList').addEventListener('click', event => {
    const action=event.target.closest('[data-task-action]');if(action){action.disabled=true;window.WittFeatures?.request(`chat/conversations/${action.dataset.id}/${action.dataset.taskAction}`,'POST',{}).then(()=>{ui.toast(action.dataset.taskAction==='cancel'?'已取消排队':'已提交重试');ui.refreshSummaries();}).catch(e=>ui.toast(e.message)).finally(()=>action.disabled=false);return;}
    const button = event.target.closest('[data-select-task]'); if (!button) return;
    close(false); ui.select(button.dataset.selectTask);
  });
  $('#userSettingsBackdrop').addEventListener('click', () => $('#closeDrawerAccount').click());
  const list = $('#conversationList');
  list.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('.conversation-more')) return;
    const row = event.target.closest('[data-id]'); if (!row) return;
    pressOrigin = {x:event.clientX,y:event.clientY};
    longPressTimer = setTimeout(() => { suppressClick=true; openConversationMenu(row.dataset.id); },550);
  });
  list.addEventListener('pointermove', event => { if (pressOrigin && Math.hypot(event.clientX-pressOrigin.x,event.clientY-pressOrigin.y)>9) clearTimeout(longPressTimer); });
  const clearPress = () => { clearTimeout(longPressTimer); pressOrigin=null; };
  ['pointerup','pointercancel','scroll'].forEach(name => list.addEventListener(name, clearPress));
  document.addEventListener('pointerup', () => { clearPress(); if (suppressClick) setTimeout(() => { suppressClick = false; }, 350); });
  list.addEventListener('click', event => { if (!suppressClick) return; suppressClick=false; event.stopImmediatePropagation(); event.preventDefault(); },true);
  list.addEventListener('contextmenu', event => { const row=event.target.closest('[data-id]'); if(row){event.preventDefault();clearPress();openConversationMenu(row.dataset.id);} });
  document.addEventListener('keydown', event => {
    const overlay = sheets.map(id => $(`#${id}`)).find(node=>!node.hidden) || (!$('#drawerAccountMenu').hidden ? $('#drawerAccountMenu') : null);
    if (!overlay) return;
    if (event.key==='Escape') { event.preventDefault(); close(); if(overlay.id==='drawerAccountMenu')$('#closeDrawerAccount').click(); }
    if (event.key==='Tab') {
      const buttons=[...overlay.querySelectorAll('button:not([disabled]),input,select,a[href]')].filter(node=>node.getClientRects().length);
      const first=buttons[0],last=buttons.at(-1);
      if(event.shiftKey && document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first?.focus();}
    }
  });
  ui.refresh();
})();
