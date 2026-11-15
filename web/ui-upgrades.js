(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const ui = window.WittUI;
  if (!ui) return;
  let groupConversationId = null, menuId = null, returnFocus = null, longPressTimer, pressOrigin, suppressClick = false;
  const escape = value => { const node = document.createElement('span'); node.textContent = String(value || ''); return node.innerHTML; };
  const sheets = ['conversationGroupSheet', 'conversationActions', 'conversationRenameSheet', 'taskOverviewSheet'];
  let sheetViewportFrame = 0;
  function syncSheetViewport() {
    const viewport = window.visualViewport;
    // Pinch zoom must not be mistaken for an on-screen keyboard.
    if (viewport && Math.abs(viewport.scale - 1) > 0.05) return;
    const height = Math.max(1, Math.min(window.innerHeight, viewport?.height || window.innerHeight));
    const top = Math.max(0, viewport?.offsetTop || 0);
    document.documentElement.style.setProperty('--upgrade-visible-height', `${height}px`);
    document.documentElement.style.setProperty('--upgrade-visible-top', `${top}px`);
  }
  function queueSheetViewport() {
    if (sheetViewportFrame) return;
    sheetViewportFrame = requestAnimationFrame(() => { sheetViewportFrame = 0; syncSheetViewport(); });
  }
  window.visualViewport?.addEventListener('resize', queueSheetViewport);
  window.visualViewport?.addEventListener('scroll', queueSheetViewport);
  window.addEventListener('resize', queueSheetViewport);
  document.addEventListener('focusin', queueSheetViewport);
  document.addEventListener('focusout', queueSheetViewport);
  syncSheetViewport();
  const close = (restore = true) => {
    groupConversationId = null;
    sheets.forEach(id => { $(`#${id}`).hidden = true; });
    if (restore && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  };
  const open = id => {
    // Keep the external launcher when moving between sheets (for example,
    // actions -> rename); a button inside the old sheet will become hidden.
    if (!sheets.some(sheetId => !$(`#${sheetId}`).hidden)) {
      returnFocus = document.activeElement;
    }
    close(false);
    syncSheetViewport();
    const sheet = $(`#${id}`); sheet.hidden = false;
    sheet.querySelector('section button, form input')?.focus({ preventScroll: true });
  };
  const pendingTaskActions = new Set();
  const taskLabels = { running:'正在执行', queued:'排队中', awaiting_confirmation:'等待确认', waiting_confirmation:'等待确认', completed:'已完成', failed:'失败', interrupted:'已暂停', idle:'尚未开始' };
  function renderTasks(conversations, limit) {
    const list = $('#taskOverviewList');
    const focused = list.contains(document.activeElement) ? document.activeElement : null;
    const focusTarget = focused ? {
      task: focused.dataset.selectTask,
      action: focused.dataset.taskAction,
      id: focused.dataset.id,
    } : null;
    window.WittFeatures?.watch(conversations);
    const active = conversations.filter(item => item.busy || ['queued','running','awaiting_confirmation','waiting_confirmation'].includes(ui.task(item).state));
    $('#taskOverviewCount').textContent = String(active.length);
    $('#taskOverviewButton').classList.toggle('has-tasks', active.length > 0);
    $('#taskOverviewButton').setAttribute('aria-label', `查看全部任务，${active.length} 项进行中`);
    const running = active.filter(item => ui.task(item).state !== 'queued').length;
    $('#taskOverviewSummary').textContent = `${running} 项执行中 · ${active.length-running} 项排队 · 最多同时执行 ${limit} 项`;
    const recent = conversations.filter(item => !active.includes(item) && ['completed','failed','interrupted'].includes(ui.task(item).state)).slice(0,8);
    const supportsTaskActions = typeof window.WittFeatures?.request === "function";
    const group = (title, entries) => entries.length ? `<h3>${title}</h3>${entries.map(item => {
      const task = ui.task(item);
      return `<button class="task-overview-row" type="button" data-select-task="${item.id}"><span class="task-overview-dot" data-state="${escape(task.state)}"></span><span><strong>${escape(item.title)}</strong><small>${escape(taskLabels[task.state] || task.label)}${item.queuePosition ? ' · 第 '+item.queuePosition+' 位' : ''}${item.waitingForProject ? ' · 等待项目：'+escape(item.waitingForProject) : ''}${item.activeDeviceLabel ? ' · '+escape(item.activeDeviceLabel) : ''}</small></span><span aria-hidden="true">↗</span></button>${supportsTaskActions && task.state==='queued'?`<div class="task-controls"><button data-task-action="cancel" data-id="${item.id}" ${pendingTaskActions.has(item.id) ? 'disabled' : ''}>取消排队</button></div>`:supportsTaskActions && ['failed','interrupted'].includes(task.state)?`<div class="task-controls"><button data-task-action="retry" data-id="${item.id}" ${pendingTaskActions.has(item.id) ? 'disabled' : ''}>重试</button></div>`:''}`;
    }).join('')}` : '';
    $('#taskOverviewList').innerHTML = group('进行中',active) + group('最近结束',recent) || '<p class="tasks-empty">还没有任务。新建对话，开始第一项工作。</p>';
    // Summary updates replace the buttons; keep keyboard users on the same task.
    if (focusTarget && !$('#taskOverviewSheet').hidden) {
      const replacement = [...list.querySelectorAll('button:not([disabled])')].find(button =>
        focusTarget.task ? button.dataset.selectTask === focusTarget.task :
          button.dataset.taskAction === focusTarget.action && button.dataset.id === focusTarget.id);
      (replacement || $('#taskOverviewRefresh')).focus({ preventScroll: true });
    }
  }
  function openConversationMenu(id) {
    const item = ui.conversations().find(value => value.id === id);
    if (!item) return;
    menuId = id;
    $('#conversationActionsTitle').textContent = item.title;
    $('#conversationArchiveButton').disabled = Boolean(item.busy);
    $('#conversationActions small').textContent = item.busy ? '任务进行中，暂停或完成后即可归档。' : '归档只移出列表，历史记录仍会保留。';
    open('conversationActions');
  }
  function openGroupDialog(id, currentGroup = '') {
    open('conversationGroupSheet');
    groupConversationId = id;
    returnFocus = $('#chatMoreButton');
    $('#conversationGroupInput').value = currentGroup;
    $('#conversationGroupInput').focus();
    $('#conversationGroupInput').select();
  }
  $('#conversationGroupForm').addEventListener('submit', event => {
    event.preventDefault();
    const project = $('#conversationGroupInput').value.trim();
    if (project.length > 80) { ui.toast('分组名称请保持在 80 字以内'); return; }
    if (groupConversationId && ui.updateMetadata(groupConversationId, { project })) close();
  });
  window.WittUpgrades = { renderTasks, openConversationMenu, openGroupDialog };
  document.querySelectorAll('[data-close-upgrade]').forEach(button => button.addEventListener('click', () => close()));
  $('#conversationRenameButton').addEventListener('click', () => {
    const item = ui.conversations().find(value => value.id === menuId);
    if (!item) return;
    open('conversationRenameSheet');
    $('#conversationRenameError').textContent = '';
    $('#conversationRenameInput').removeAttribute('aria-invalid');
    $('#conversationRenameInput').value = item.title;
    $('#conversationRenameInput').focus(); $('#conversationRenameInput').select();
  });
  $('#conversationRenameInput').addEventListener('input', () => {
    $('#conversationRenameError').textContent = '';
    $('#conversationRenameInput').removeAttribute('aria-invalid');
  });
  $('#conversationRenameForm').addEventListener('submit', event => {
    event.preventDefault(); const input = $('#conversationRenameInput');
    const title = input.value.trim();
    if (!title || title.length > 100) {
      $('#conversationRenameError').textContent = !title ? '请输入对话名称，不能只包含空格。' : '对话名称请保持在 100 字以内。';
      input.setAttribute('aria-invalid', 'true');
      input.focus({ preventScroll: true });
      return;
    }
    if (ui.updateMetadata(menuId, { title })) close();
  });
  $('#conversationArchiveButton').addEventListener('click', () => { const id = menuId; close(false); ui.archive(id); });
  $('#taskOverviewButton').addEventListener('click', () => { open('taskOverviewSheet'); ui.refreshSummaries(); });
  $('#taskOverviewRefresh').addEventListener('click', () => { ui.refreshSummaries(); ui.toast('正在刷新任务状态'); });
  $('#taskOverviewList').addEventListener('click', async event => {
    const action = event.target.closest('[data-task-action]');
    if (action) {
      const { id, taskAction } = action.dataset;
      if (action.disabled || pendingTaskActions.has(id)) return;
      // Summary refreshes replace DOM buttons; keep pending state by task ID.
      pendingTaskActions.add(id);
      action.disabled = true;
      try {
        await window.WittFeatures.request(`chat/conversations/${id}/${taskAction}`, 'POST', {});
        ui.toast(taskAction === 'cancel' ? '已取消排队' : '已提交重试');
        ui.refreshSummaries();
      } catch (error) {
        ui.toast(error.message);
      } finally {
        pendingTaskActions.delete(id);
        for (const button of $('#taskOverviewList').querySelectorAll('[data-task-action]')) {
          if (button.dataset.id === id) button.disabled = false;
        }
      }
      return;
    }
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
  // Leaving the list abandons the gesture even without another pointermove.
  ['pointerup','pointercancel','pointerleave','scroll'].forEach(name => list.addEventListener(name, clearPress));
  document.addEventListener('pointerup', () => { clearPress(); if (suppressClick) setTimeout(() => { suppressClick = false; }, 350); });
  list.addEventListener('click', event => { if (!suppressClick) return; suppressClick=false; event.stopImmediatePropagation(); event.preventDefault(); },true);
  list.addEventListener('contextmenu', event => { const row=event.target.closest('[data-id]'); if(row){event.preventDefault();clearPress();openConversationMenu(row.dataset.id);} });
  document.addEventListener('keydown', event => {
    // Let the input method consume Escape while dismissing a candidate window.
    if (event.isComposing || event.keyCode === 229) return;
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
