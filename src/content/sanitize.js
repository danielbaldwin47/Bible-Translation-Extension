/*
 * Safe renderer: turns the normalized IR (blocks/runs from the worker) into DOM
 * using only createElement / text nodes. No innerHTML, no parsing of remote HTML,
 * so there is no XSS surface even though the text comes from a third-party API.
 *
 * IIFE -> __BTX.sanitize.
 */
(function (root) {
  'use strict';

  function renderBlocks(blocks) {
    const frag = document.createDocumentFragment();
    if (!Array.isArray(blocks)) return frag;

    for (const block of blocks) {
      if (!block) continue;
      if (block.type === 'heading') {
        const h = document.createElement('h3');
        h.className = 'btx-heading';
        h.textContent = block.text || '';
        frag.appendChild(h);
      } else if (block.type === 'para') {
        const p = document.createElement('p');
        p.className = 'btx-para';
        const style = String(block.style || 'p');
        if (/^q/.test(style)) p.classList.add('btx-poetry', `btx-${style}`);
        renderRuns(block.runs, p);
        frag.appendChild(p);
      }
    }
    return frag;
  }

  function renderRuns(runs, parent) {
    if (!Array.isArray(runs)) return;
    for (const run of runs) {
      if (!run) continue;
      if (run.t === 'v') {
        const sup = document.createElement('sup');
        sup.className = 'btx-vnum';
        sup.textContent = run.n || '';
        parent.appendChild(sup);
        parent.appendChild(document.createTextNode(' '));
      } else if (run.t === 'txt') {
        if (run.wj) {
          const span = document.createElement('span');
          span.className = 'btx-wj';
          span.textContent = run.s || '';
          parent.appendChild(span);
        } else {
          parent.appendChild(document.createTextNode(run.s || ''));
        }
      }
    }
  }

  root.__BTX = Object.assign(root.__BTX || {}, {
    sanitize: { renderBlocks },
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
