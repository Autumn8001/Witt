(() => {
  'use strict';
  const drawer = document.querySelector('#drawer');
  const avatar = document.querySelector('#drawerAvatar');
  const menu = document.querySelector('#drawerAccountMenu');
  const searchToggle = document.querySelector('#drawerSearchToggle');
  const controls = document.querySelector('#drawerSearchControls');
  const search = document.querySelector('#historySearch');
  if (!drawer || !avatar || !menu || !searchToggle || !controls || !search) return;
  const setMenu = (open, restoreFocus = false) => {
    menu.hidden = !open;
    avatar.setAttribute('aria-expanded', String(open));
    if (open) menu.querySelector('#closeDrawerAccount')?.focus({ preventScroll: true });
    else if (restoreFocus) avatar.focus({ preventScroll: true });
  };
  avatar.addEventListener('click', () => setMenu(menu.hidden));
  document.querySelector('#closeDrawerAccount').addEventListener('click', () => setMenu(false, true));
  menu.addEventListener('click', (event) => {
    if (event.target.closest('.drawer-profile, .workspace-entry, #updateButton')) setMenu(false);
  });
  document.addEventListener('pointerdown', (event) => {
    if (!menu.hidden && !menu.contains(event.target) && !avatar.contains(event.target)) setMenu(false);
  });
  const setSearch = (open) => {
    controls.hidden = !open;
    searchToggle.setAttribute('aria-expanded', String(open));
    if (open) search.focus({ preventScroll: true });
  };
  searchToggle.addEventListener('click', () => {
    if (!controls.hidden) {
      search.value = '';
      const project = document.querySelector('#historyProject');
      const attachments = document.querySelector('#historyAttachments');
      if (project) project.value = '';
      if (attachments) attachments.checked = false;
      search.dispatchEvent(new Event('input', { bubbles: true }));
    }
    setSearch(controls.hidden);
  });
  // Older bundled clients have no history search bridge; keep title search usable.
  if (!document.querySelector('#historyProject')) {
    const filterTitles = () => {
      const query = search.value.trim().toLocaleLowerCase();
      drawer.querySelectorAll('.conversation-row').forEach((row) => {
        row.style.setProperty('display', row.querySelector('strong').textContent.toLocaleLowerCase().includes(query) ? 'grid' : 'none', 'important');
      });
    };
    search.addEventListener('input', filterTitles);
    new MutationObserver(filterTitles).observe(document.querySelector('#conversationList'), { childList: true });
  }
  new MutationObserver(() => {
    if (drawer.getAttribute('aria-hidden') === 'true') setMenu(false);
  }).observe(drawer, { attributes: true, attributeFilter: ['aria-hidden'] });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (document.querySelector('.upgrade-sheet:not([hidden])')) return;
    if (!menu.hidden) { setMenu(false, true); return; }
    if (!controls.hidden) { searchToggle.click(); searchToggle.focus(); return; }
    if (drawer.classList.contains('open')) document.querySelector('#closeDrawer').click();
  });
})();
