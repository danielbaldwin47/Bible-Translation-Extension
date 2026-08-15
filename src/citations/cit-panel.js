/*
 * Citations mode: renders, for the current chapter, the talks/sermons that cite
 * its verses. Two citation layouts (chosen in settings, passed as opts.view):
 *   - 'verse'  : accordion verse -> source type -> talks. A cite that spans a
 *                verse range shows once per anchor verse with a range badge.
 *   - 'source' : one deduped row per citing talk, grouped by source type, each
 *                tagged with the verse/range it cites.
 * Clicking a citation row hands off to the inline talk reader via onOpenTalk.
 *
 * This file is a DOM adapter only: what to show, in what order, with what label
 * and open state is decided by the pure view-model in cit-view-model.js, which
 * hands over a descriptor tree (see its header) plus the toolbar's state
 * transitions. Nothing here sorts, groups, counts, or labels.
 *
 * IIFE -> __BTX.citPanel.
 */
(function (root) {
  'use strict';

  const citData = () => root.__BTX.citData;
  const vm = () => root.__BTX.citVM;
  const panel = () => root.__BTX.panel;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // A <summary> with a custom caret, a label, and a right-aligned count chip.
  // countClass (btx-grp-gc/jod/tpjs) names the source type on the chip; the
  // colour itself now lives on the acronym tile or the group strip, not here.
  function summaryRow(cls, group) {
    const sum = el('summary', cls);
    sum.appendChild(el('span', 'btx-caret'));
    sum.appendChild(el('span', 'btx-cit-label', group.label));
    sum.appendChild(el('span', 'btx-cit-count' + (group.countClass ? ' ' + group.countClass : ''), String(group.count)));
    return sum;
  }

  function rowEl(row, onOpenTalk) {
    const node = el('div', 'btx-cit');
    node.dataset.btxUid = row.uid;
    // Haystack for the in-panel filter box (see attachTools).
    node.dataset.btxSearch = row.search;
    const head = el('div', 'btx-cit-head');
    const left = el('div', 'btx-cit-headl');
    left.appendChild(el('span', 'btx-cit-speaker', row.speaker));
    if (row.rangeLabel) left.appendChild(el('span', 'btx-cit-range', row.rangeLabel));
    head.appendChild(left);
    head.appendChild(el('span', `btx-cit-tag ${row.tagClass}`, row.tag));
    node.appendChild(head);
    if (row.sub) node.appendChild(el('div', 'btx-cit-sub', row.sub));
    if (row.snippet) node.appendChild(el('div', 'btx-cit-snippet', '“' + row.snippet + '”'));
    node.tabIndex = 0;
    node.setAttribute('role', 'button');
    const open = () => onOpenTalk && onOpenTalk(row.entry);
    node.addEventListener('click', open);
    node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    return node;
  }

  // Whichever <details> represents a *source type* — the nested group in the
  // by-verse layout, the top-level one in by-source — carries its group key as
  // a class too, so the coloured-edge source marking (data-btx-source-mark=
  // 'strip' on the root) has a hook regardless of layout.
  function groupClass(base, group) {
    return group.kind === 'sourceType' ? base + ' btx-grp-' + group.key : base;
  }

  // One top-level group: a <details> per verse (by-verse) or per source type
  // (by-source). Nested source-type groups are <details> too; by-source rows
  // hang in a plain container instead.
  function groupEl(group, onOpenTalk) {
    const node = el('details', groupClass('btx-cit-vgroup', group));
    node.dataset.btxUid = group.uid;
    node.appendChild(summaryRow('btx-cit-vhead', group));
    node.open = group.open;
    if (group.focus) node.classList.add('btx-cit-focus');

    for (const child of group.children) {
      const cnode = el('details', groupClass('btx-cit-cgroup', child));
      cnode.dataset.btxUid = child.uid;
      cnode.appendChild(summaryRow('btx-cit-chead', child));
      cnode.open = child.open;
      for (const row of child.rows) cnode.appendChild(rowEl(row, onOpenTalk));
      node.appendChild(cnode);
    }
    if (group.rows.length) {
      const cgroup = el('div', 'btx-cit-cgroup');
      for (const row of group.rows) cgroup.appendChild(rowEl(row, onOpenTalk));
      node.appendChild(cgroup);
    }
    return node;
  }

  // Toolbar above the list: a live filter box (speaker / title / snippet) and an
  // expand-all / collapse-all button. The view-model decides what hides, what
  // opens, and what the button says; this only mirrors that onto the elements
  // and reports the user's own open/close back into the state.
  function attachTools(wrap, tools, viewModel) {
    const input = el('input', 'btx-cit-filter');
    input.type = 'search';
    input.placeholder = 'Filter by speaker, title, or text…';
    input.setAttribute('aria-label', 'Filter citations');
    const toggleAll = el('button', 'btx-cit-toolbtn', 'Expand all');
    toggleAll.type = 'button';
    tools.appendChild(input);
    tools.appendChild(toggleAll);
    const noRes = el('p', 'btx-state-text btx-cit-noresults', 'No citations match.');
    noRes.style.display = 'none';

    let state = vm().initialState(viewModel);
    let hidden = {};

    // uid -> element, re-read per interaction so it always reflects the tree
    // that is actually mounted (the groups are appended after this toolbar).
    function nodeMap() {
      const nodes = new Map();
      for (const n of wrap.querySelectorAll('[data-btx-uid]')) nodes.set(n.dataset.btxUid, n);
      return nodes;
    }

    function applyOpen(open, nodes) {
      for (const uid of Object.keys(open)) {
        const node = nodes.get(uid);
        if (node) node.open = open[uid];
      }
    }

    function applyFilter() {
      const plan = vm().filterPlan(viewModel, input.value, state);
      const nodes = nodeMap();
      for (const uid of Object.keys(plan.hidden)) {
        const node = nodes.get(uid);
        if (node) node.classList.toggle('btx-cit-hidden', plan.hidden[uid]);
      }
      applyOpen(plan.open, nodes);
      state = vm().applyPlan(state, plan);
      hidden = plan.hidden;
      noRes.style.display = plan.filtering && !plan.anyMatch ? '' : 'none';
      toggleAll.textContent = plan.toggleLabel;
    }

    input.addEventListener('input', applyFilter);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && input.value) { e.stopPropagation(); input.value = ''; applyFilter(); }
    });
    toggleAll.addEventListener('click', () => {
      const plan = vm().toggleAllPlan(viewModel, state, hidden);
      applyOpen(plan.open, nodeMap());
      state = vm().applyPlan(state, plan);
      toggleAll.textContent = vm().toggleLabel(viewModel, state, hidden);
    });
    // 'toggle' doesn't bubble, but capture listeners on ancestors still see it.
    // Every open/close the user makes lands back in the state object. (Our own
    // writes are already in `state`; the groups' initial open flags never reach
    // here — they are set while the group is still detached — but `initialState`
    // reads them from the same descriptors, so the two agree.)
    wrap.addEventListener('toggle', (e) => {
      const uid = e.target && e.target.dataset && e.target.dataset.btxUid;
      if (!uid || !(uid in state.open)) return;
      state.open[uid] = e.target.open;
      toggleAll.textContent = vm().toggleLabel(viewModel, state, hidden);
    }, true);
    return noRes;
  }

  // Render the chapter's citations into `host` — the container the panel's view
  // host handed us. Keeping that container alive (so scroll position and which
  // dropdowns are open survive a mode toggle) is the panel's business, not ours.
  // opts: { slug, chapter, fullName, focusVerse, onOpenTalk, view }
  async function render(host, opts) {
    const { slug, chapter, onOpenTalk } = opts;
    host.textContent = '';
    const loading = el('div', 'btx-state btx-loading');
    loading.appendChild(el('div', 'btx-spinner'));
    loading.appendChild(el('div', 'btx-state-text', 'Loading citations…'));
    host.appendChild(loading);

    const data = await citData().chapterData(slug, chapter);
    const viewModel = vm().buildView(data, opts);

    const wrap = el('div', 'btx-cit-list');
    if (viewModel.empty) {
      const empty = el('div', 'btx-state');
      empty.appendChild(el('p', 'btx-state-text', viewModel.emptyText));
      wrap.appendChild(empty);
    } else {
      wrap.appendChild(el('div', 'btx-cit-summary', viewModel.summary));
      let noRes = null;
      if (viewModel.showTools) {
        const tools = el('div', 'btx-cit-tools');
        wrap.appendChild(tools);
        noRes = attachTools(wrap, tools, viewModel);
      }
      for (const group of viewModel.groups) wrap.appendChild(groupEl(group, onOpenTalk));
      if (noRes) wrap.appendChild(noRes);
    }

    host.textContent = '';
    host.appendChild(wrap);
    const focusEl = viewModel.focusUid && wrap.querySelector(`[data-btx-uid="${CSS.escape(viewModel.focusUid)}"]`);
    // Where the focus verse lands is the panel's rule, not ours — the same one
    // the talk reader gets, so the list arrives with context above it too.
    if (focusEl) panel().scrollIntoView(focusEl, { frames: 1 });
  }

  root.__BTX = Object.assign(root.__BTX || {}, { citPanel: { render } });
})(typeof globalThis !== 'undefined' ? globalThis : this);
