'use strict';
/* Operations Portal — the data grid.
   ===========================================================================
   ONE component behind every table in the workspace, so "search, filters,
   sorting, pagination, export CSV, export Excel, print, column show/hide,
   sticky header, row selection, bulk actions" is implemented once and every
   screen gets all of it. A screen supplies columns and a fetch function;
   everything else is here.

   TWO MODES, and the choice is not cosmetic:

     mode:'server'  the endpoint paginates and searches. The grid asks for one
                    page at a time. Correct for anything unbounded.
     mode:'client'  the grid pulls one page at the API's ceiling and then
                    searches / sorts / paginates in the browser. Only for
                    endpoints with NO search parameter, where filtering
                    server-side is not an option.

   WHAT SORTING HONESTLY MEANS HERE
   Not one endpoint in this API accepts a sort parameter — every list is
   ordered server-side by created_at desc. So in 'server' mode a column sort
   reorders THE ROWS ON THE CURRENT PAGE and nothing more. Pretending
   otherwise would be a data-integrity bug dressed as a feature: an operator
   sorting by Amount descending on page 1 of 9 would believe they were looking
   at the largest bookings. The header therefore carries a title attribute
   saying so, and the footer states it in words whenever a sort is active and
   more than one page exists.

   EXCEL, WITHOUT A LIBRARY
   Where the backend has a real xlsx writer (GET /api/reports/export, via
   openpyxl) the grid calls it — `exportServer` below. Everywhere else "Excel"
   emits a single-sheet SpreadsheetML .xls, which Excel, LibreOffice and
   Sheets all open natively. That is a deliberate trade: no CDN dependency in
   a portal that must paint instantly, and no pretence that a client-side
   file covers rows that were never downloaded (client-side exports are
   labelled with exactly the row count they contain).
   =========================================================================== */

const OPS_PAGE_SIZES = [25, 50, 100];

/* The router's page_size ceiling — Query(20, ge=1, le=100) on every list
   endpoint. Asking for more is a 422, so client mode can never hold more
   than this and says so rather than implying a full dataset. */
const OPS_PAGE_MAX = 100;

let opsGridSeq = 0;

function OpsGrid(config) {
  const g = {
    id: config.id,
    mount: config.mount,
    columns: config.columns.map(c => ({ align: '', sortable: true, ...c })),
    fetch: config.fetch,
    mode: config.mode || 'server',
    filters: config.filters || [],
    searchable: config.searchable !== false,
    searchPlaceholder: config.searchPlaceholder || 'Search…',
    selectable: !!config.selectable,
    bulkActions: config.bulkActions || [],
    rowKey: config.rowKey || (r => r.id),
    rowClass: config.rowClass || null,
    onRow: config.onRow || null,
    exportName: config.exportName || config.id,
    exportServer: config.exportServer || null,   /* {csv,xlsx,pdf} -> Promise<Blob> */
    emptyText: config.emptyText || 'No records match these criteria.',
    title: config.title || '',
    note: config.note || '',
    pageSize: config.pageSize || 25,
    onLoad: config.onLoad || null,

    /* live state */
    page: 1,
    total: 0,
    rows: [],
    allRows: [],       /* client mode: everything fetched */
    matchedRows: [],   /* client mode: what survived search + filters */
    sort: config.sort || null,   /* {key, dir} */
    search: '',
    filterValues: { ...(config.filterDefaults || {}) },
    selected: new Set(),
    seq: 0,
    uid: `g${++opsGridSeq}`,
  };

  /* Column visibility survives a reload, per grid and per browser — an
     operator who hid six columns to fit their monitor should not have to do
     it again after lunch. */
  const visKey = `ops_cols_${g.id}`;
  const savedVis = (() => {
    try { return JSON.parse(localStorage.getItem(visKey) || 'null'); } catch { return null; }
  })();
  g.columns.forEach(c => {
    if (savedVis && Object.prototype.hasOwnProperty.call(savedVis, c.key)) c.hidden = !savedVis[c.key];
  });
  const saveVis = () => {
    const map = {};
    g.columns.forEach(c => { map[c.key] = !c.hidden; });
    localStorage.setItem(visKey, JSON.stringify(map));
  };

  /* ---------------------------------------------------------------------
     COLUMN ORDER AND WIDTH — two more saved preferences
     ---------------------------------------------------------------------
     Kept in their own localStorage keys rather than folded into the
     visibility map above, so an operator who already has column layouts
     saved from an earlier build keeps them: the old `{key: bool}` shape is
     still read exactly as it was, and these are additive.

       ops_cols_<id>   visibility   {key: true|false}      (pre-existing)
       ops_colo_<id>   order        [key, key, ...]
       ops_colw_<id>   widths       {key: px}

     WHY WIDTHS FLIP THE TABLE TO FIXED LAYOUT
     `table.ops-table` is width:100% with the browser's automatic algorithm,
     which treats a th width as a suggestion and will happily ignore it to
     fit content — so dragging a column would feel broken. Rather than force
     `table-layout:fixed` on every grid in the portal (which would change how
     every existing screen sizes its columns), a grid switches to fixed
     layout ONLY once this operator has actually resized one of its columns.
     Until then rendering is byte-for-byte what it was. At the moment of the
     first drag every visible column's measured width is captured — see the
     note on that measurement for why it uses fractional rects rather than
     offsetWidth.                                                        */
  const orderKey = `ops_colo_${g.id}`;
  const widthKey = `ops_colw_${g.id}`;
  const readJson = k => {
    try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; }
  };

  const savedOrder = readJson(orderKey);
  if (Array.isArray(savedOrder) && savedOrder.length) {
    /* Unknown keys in the saved list are dropped and columns the saved list
       never heard of keep their place at the end — so shipping a new column
       does not make it invisible to everyone with a saved order. */
    const pos = new Map(savedOrder.map((k, i) => [k, i]));
    g.columns.sort((a, b) => {
      const ia = pos.has(a.key) ? pos.get(a.key) : Number.MAX_SAFE_INTEGER;
      const ib = pos.has(b.key) ? pos.get(b.key) : Number.MAX_SAFE_INTEGER;
      return ia - ib;
    });
  }
  const saveOrder = () => localStorage.setItem(orderKey, JSON.stringify(g.columns.map(c => c.key)));

  g.colWidths = readJson(widthKey) || {};
  let fixedLayout = Object.keys(g.colWidths).length > 0;
  const saveWidths = () => localStorage.setItem(widthKey, JSON.stringify(g.colWidths));

  const visible = () => g.columns.filter(c => !c.hidden);
  const colCount = () => visible().length + (g.selectable ? 1 : 0);

  /* A cell's display HTML and its export text are different things: the grid
     shows a status pill, the CSV needs the word. `value()` is the export
     value; `render()` is the display. Either may be omitted. */
  const cellHtml = (col, row) => {
    if (col.render) return col.render(row);
    const v = col.value ? col.value(row) : row[col.key];
    return v == null || v === '' ? '<span class="ops-muted">—</span>' : escapeHtml(String(v));
  };
  const cellText = (col, row) => {
    if (col.value) { const v = col.value(row); return v == null ? '' : String(v); }
    if (col.text) return col.text(row);
    const v = row[col.key];
    return v == null ? '' : String(v);
  };

  /* ------------------------------------------------------------ skeleton */
  g.mount.innerHTML = `
    <div class="ops-panel ops-print-target" id="${g.uid}-panel">
      ${g.title ? `<div class="ops-panel-head"><h2>${escapeHtml(g.title)}</h2>
        <div class="ops-panel-tools"><span class="ops-grid-count" id="${g.uid}-count">—</span></div></div>` : ''}
      <div class="ops-print-head" id="${g.uid}-printhead"></div>
      <div class="ops-grid-bar" id="${g.uid}-bar"></div>
      <div class="ops-bulk" id="${g.uid}-bulk"></div>
      <div class="ops-table-wrap" id="${g.uid}-wrap">
        <table class="ops-table">
          <thead id="${g.uid}-head"></thead>
          <tbody id="${g.uid}-body"></tbody>
        </table>
      </div>
      <div class="ops-grid-foot" id="${g.uid}-foot"></div>
      ${g.note ? `<div class="ops-panel-note">${g.note}</div>` : ''}
    </div>`;

  const el = suffix => $(`${g.uid}-${suffix}`);

  /* ---------------------------------------------------------------- bar */
  function renderBar() {
    const filterHtml = g.filters.map(f => {
      const val = g.filterValues[f.key] ?? '';
      const label = `<span class="ops-grid-flabel">${escapeHtml(f.label)}</span>`;
      if (f.type === 'select') {
        return `${label}<select data-ops-filter="${f.key}" title="${escapeHtml(f.label)}">
                  <option value="">${escapeHtml(f.anyLabel || 'All')}</option>
                  ${opsSelectOptions(f.options, val)}
                </select>`;
      }
      if (f.type === 'date') {
        return `${label}<input type="date" data-ops-filter="${f.key}" value="${escapeHtml(String(val))}" title="${escapeHtml(f.label)}">`;
      }
      if (f.type === 'number') {
        return `${label}<input type="number" data-ops-filter="${f.key}" value="${escapeHtml(String(val))}" placeholder="${escapeHtml(f.placeholder || '')}" title="${escapeHtml(f.label)}">`;
      }
      return `${label}<input type="text" data-ops-filter="${f.key}" value="${escapeHtml(String(val))}" placeholder="${escapeHtml(f.placeholder || '')}" title="${escapeHtml(f.label)}">`;
    }).join('');

    el('bar').innerHTML = `
      ${g.searchable ? `<div class="ops-grid-search">
        <input type="search" data-ops-gsearch placeholder="${escapeHtml(g.searchPlaceholder)}" value="${escapeHtml(g.search)}" autocomplete="off">
      </div>` : ''}
      ${filterHtml}
      <button type="button" class="ops-btn ops-btn-sm" data-ops-apply>Apply</button>
      <button type="button" class="ops-btn ops-btn-sm" data-ops-reset>Reset</button>
      <div class="ops-grid-bar-right">
        <button type="button" class="ops-btn ops-btn-sm" data-ops-refresh title="Reload from the server">↻</button>
        <div class="ops-colwrap" style="position:relative">
          <button type="button" class="ops-btn ops-btn-sm" data-ops-cols>Columns ▾</button>
          <div class="ops-colmenu" id="${g.uid}-colmenu"></div>
        </div>
        <div class="ops-btn-group">
          <button type="button" class="ops-btn ops-btn-sm" data-ops-export="csv">CSV</button>
          <button type="button" class="ops-btn ops-btn-sm" data-ops-export="xlsx">Excel</button>
          ${g.exportServer && g.exportServer.pdf ? '<button type="button" class="ops-btn ops-btn-sm" data-ops-export="pdf">PDF</button>' : ''}
          <button type="button" class="ops-btn ops-btn-sm" data-ops-print>Print</button>
        </div>
      </div>`;

    /* Enter anywhere in the filter bar runs the query — data-entry muscle
       memory, and the brief's "Enter = submit". */
    opsAll('input,select', el('bar')).forEach(input => {
      input.addEventListener('keydown', e => { if (e.key === 'Enter') apply(); });
    });
    opsEl('[data-ops-apply]', el('bar')).addEventListener('click', apply);
    opsEl('[data-ops-reset]', el('bar')).addEventListener('click', reset);
    opsEl('[data-ops-refresh]', el('bar')).addEventListener('click', () => load());
    opsEl('[data-ops-cols]', el('bar')).addEventListener('click', e => {
      e.stopPropagation();
      const m = el('colmenu');
      const open = m.classList.contains('open');
      opsAll('.ops-colmenu.open').forEach(x => x.classList.remove('open'));
      m.classList.toggle('open', !open);
    });
    opsAll('[data-ops-export]', el('bar')).forEach(b =>
      b.addEventListener('click', () => doExport(b.dataset.opsExport)));
    opsEl('[data-ops-print]', el('bar')).addEventListener('click', doPrint);

    renderColMenu();
  }

  function renderColMenu() {
    /* Each row: visibility checkbox + a pair of nudges that move the column in
       the table. Buttons rather than HTML5 drag-and-drop on purpose — this menu
       is a 200px-wide popover and a drop target that small is fiddly with a
       mouse and unusable with a keyboard. Two arrows are precise, reversible
       and reachable by Tab. */
    el('colmenu').innerHTML = g.columns.map((c, i) => `
      <div class="ops-colrow">
        <label><input type="checkbox" data-ops-col="${i}" ${c.hidden ? '' : 'checked'}>
          ${escapeHtml(c.label != null ? c.label : c.key)}</label>
        <span class="ops-colmove">
          <button type="button" data-ops-colup="${i}" ${i === 0 ? 'disabled' : ''}
                  title="Move left" aria-label="Move column left">▲</button>
          <button type="button" data-ops-coldown="${i}" ${i === g.columns.length - 1 ? 'disabled' : ''}
                  title="Move right" aria-label="Move column right">▼</button>
        </span>
      </div>`).join('')
      + `<div class="ops-colmenu-foot">
           <button type="button" class="ops-btn ops-btn-sm" data-ops-col-all>Show all</button>
           <button type="button" class="ops-btn ops-btn-sm" data-ops-col-reset
                   title="Restore this table's original column order and widths">Reset layout</button>
         </div>`;

    const move = (from, to) => {
      if (to < 0 || to >= g.columns.length) return;
      const [col] = g.columns.splice(from, 1);
      g.columns.splice(to, 0, col);
      saveOrder();
      renderColMenu();
      renderHead();
      renderBody();
      el('colmenu').classList.add('open');   /* keep the menu up while nudging */
    };
    opsAll('[data-ops-colup]', el('colmenu')).forEach(b =>
      b.addEventListener('click', () => move(Number(b.dataset.opsColup), Number(b.dataset.opsColup) - 1)));
    opsAll('[data-ops-coldown]', el('colmenu')).forEach(b =>
      b.addEventListener('click', () => move(Number(b.dataset.opsColdown), Number(b.dataset.opsColdown) + 1)));

    opsEl('[data-ops-col-reset]', el('colmenu')).addEventListener('click', () => {
      localStorage.removeItem(orderKey);
      localStorage.removeItem(widthKey);
      g.colWidths = {};
      fixedLayout = false;
      g.columns = config.columns.map(c => ({ align: '', sortable: true, ...c }));
      g.columns.forEach(c => {
        if (savedVis && Object.prototype.hasOwnProperty.call(savedVis, c.key)) c.hidden = !savedVis[c.key];
      });
      renderColMenu();
      renderHead();
      renderBody();
      opsToast('Column order and widths reset for this table.');
    });

    opsAll('[data-ops-col]', el('colmenu')).forEach(cb => {
      cb.addEventListener('change', () => {
        const col = g.columns[Number(cb.dataset.opsCol)];
        /* Never let the last column be hidden — an empty table with a working
           column menu is a puzzle, not a view. */
        if (!cb.checked && visible().length <= 1) {
          cb.checked = true;
          return opsToast('At least one column must stay visible.');
        }
        col.hidden = !cb.checked;
        saveVis();
        renderHead();
        renderBody();
      });
    });
    opsEl('[data-ops-col-all]', el('colmenu')).addEventListener('click', () => {
      g.columns.forEach(c => { c.hidden = false; });
      saveVis();
      renderColMenu();
      renderHead();
      renderBody();
    });
  }

  /* --------------------------------------------------------------- head */
  function renderHead() {
    const sortNote = 'Sorts the rows on this page — the API does not sort server-side';
    const table = opsEl('table.ops-table', el('wrap'));
    table?.classList.toggle('ops-table-fixed', fixedLayout);

    el('head').innerHTML = `<tr>
      ${g.selectable ? `<th class="ops-check-cell"><input type="checkbox" data-ops-all
          title="Select every row on this page" aria-label="Select all rows on this page"></th>` : ''}
      ${visible().map(c => {
        const on = g.sort && g.sort.key === c.key;
        const arrow = on ? `<span class="ops-sort">${g.sort.dir === 'asc' ? '▲' : '▼'}</span>` : '';
        /* A width the operator dragged wins over the column's declared one. */
        const w = g.colWidths[c.key] ? `${g.colWidths[c.key]}px` : c.width;
        return `<th class="${c.sortable ? 'sortable' : ''}${c.align === 'right' ? ' ops-num' : ''}${c.key === '_actions' ? ' ops-actions' : ''}"
                    ${c.sortable ? `data-ops-sort="${escapeHtml(c.key)}" title="${sortNote}"` : ''}
                    ${w ? `style="width:${w}"` : ''}>${escapeHtml(c.label != null ? c.label : c.key)}${arrow}<span
                    class="ops-colgrip" data-ops-grip="${escapeHtml(c.key)}"
                    title="Drag to resize · double-click to reset"></span></th>`;
      }).join('')}
    </tr>`;

    wireResize();

    opsAll('[data-ops-sort]', el('head')).forEach(th => {
      th.addEventListener('click', () => {
        const key = th.dataset.opsSort;
        g.sort = g.sort && g.sort.key === key
          ? { key, dir: g.sort.dir === 'asc' ? 'desc' : 'asc' }
          : { key, dir: 'asc' };
        if (g.mode === 'client') { paginateClient(); } else { sortRows(g.rows); }
        renderHead();
        renderBody();
        renderFoot();
      });
    });
    const all = opsEl('[data-ops-all]', el('head'));
    all?.addEventListener('change', () => {
      g.rows.forEach(r => {
        if (all.checked) g.selected.add(String(g.rowKey(r)));
        else g.selected.delete(String(g.rowKey(r)));
      });
      renderBody();
      renderBulk();
    });
  }

  /* --------------------------------------------------------- column resize
     The grip is a 7px strip on the right edge of each header cell. Dragging
     it must not also trigger the sort handler on the same th, hence the
     stopPropagation on mousedown and the click swallow after a drag.

     The first drag on a grid captures every visible column's measured width
     before changing anything, then switches the table to fixed layout — see
     the note by widthKey above for why. */
  const OPS_COL_MIN = 44;

  function wireResize() {
    opsAll('[data-ops-grip]', el('head')).forEach(grip => {
      const th = grip.parentElement;
      const key = grip.dataset.opsGrip;

      grip.addEventListener('click', e => e.stopPropagation());

      /* Double-click clears this column's saved width and lets it size itself
         again — the escape hatch for a column dragged down to nothing. */
      grip.addEventListener('dblclick', e => {
        e.stopPropagation();
        delete g.colWidths[key];
        if (!Object.keys(g.colWidths).length) fixedLayout = false;
        saveWidths();
        renderHead();
        renderBody();
      });

      grip.addEventListener('mousedown', e => {
        e.preventDefault();
        e.stopPropagation();

        if (!fixedLayout) {
          /* Freeze the CURRENT layout before switching algorithms, and freeze
             it IN THE DOM — not just in g.colWidths.
             `table-layout:fixed` sizes from the first row's specified widths
             and splits the table equally between any columns that have none.
             These cells were rendered with no width at all (nothing was saved
             yet), so flipping the class first makes every column jump to
             1/n of the table for the duration of the drag. Writing each
             measured width onto its own th first means the switch changes the
             algorithm and nothing else.

             Every th is written, including the selection checkbox, which has
             no column key to persist under — miss it and its width becomes
             part of the pool the browser redistributes.

             Measured with getBoundingClientRect rather than offsetWidth: the
             fractional widths sum to the table width, where eleven rounded-up
             offsetWidths can overshoot it by ~27px and get scaled back down. */
          opsAll('th', el('head')).forEach(cell => {
            const w = Math.round(cell.getBoundingClientRect().width);
            const k = opsEl('[data-ops-grip]', cell)?.dataset.opsGrip;
            if (k) g.colWidths[k] = w;
            cell.style.width = `${w}px`;
          });
          fixedLayout = true;
          opsEl('table.ops-table', el('wrap'))?.classList.add('ops-table-fixed');
        }

        const startX = e.clientX;
        const startW = th.offsetWidth;
        document.body.classList.add('ops-col-resizing');

        const move = ev => {
          const next = Math.max(OPS_COL_MIN, startW + (ev.clientX - startX));
          g.colWidths[key] = next;
          th.style.width = `${next}px`;
        };
        const up = () => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          document.body.classList.remove('ops-col-resizing');
          saveWidths();
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
    });
  }

  /* Numbers must sort as numbers and dates as dates; everything else is a
     locale string compare. A column can override with sortValue(). */
  function sortRows(rows) {
    if (!g.sort) return rows;
    const col = g.columns.find(c => c.key === g.sort.key);
    if (!col) return rows;
    const dir = g.sort.dir === 'asc' ? 1 : -1;
    const val = row => {
      if (col.sortValue) return col.sortValue(row);
      const raw = col.value ? col.value(row) : (col.text ? col.text(row) : row[col.key]);
      return raw;
    };
    rows.sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;      /* blanks last, either direction */
      if (y == null) return -1;
      const nx = typeof x === 'number' ? x : Number(String(x).replace(/[^\d.-]/g, ''));
      const ny = typeof y === 'number' ? y : Number(String(y).replace(/[^\d.-]/g, ''));
      if (!Number.isNaN(nx) && !Number.isNaN(ny) && String(x).trim() !== '' && String(y).trim() !== '') {
        return (nx - ny) * dir;
      }
      return String(x).localeCompare(String(y), undefined, { numeric: true }) * dir;
    });
    return rows;
  }

  /* --------------------------------------------------------------- body */
  function renderBody() {
    const cols = visible();
    if (!g.rows.length) {
      el('body').innerHTML = opsEmptyRow(colCount(), g.emptyText);
      return;
    }
    el('body').innerHTML = g.rows.map(row => {
      const key = String(g.rowKey(row));
      const sel = g.selected.has(key);
      const extra = g.rowClass ? g.rowClass(row) : '';
      return `<tr data-ops-row="${escapeHtml(key)}" class="${sel ? 'sel ' : ''}${g.onRow ? 'click ' : ''}${extra}">
        ${g.selectable ? `<td class="ops-check-cell"><input type="checkbox" data-ops-pick="${escapeHtml(key)}" ${sel ? 'checked' : ''}
            aria-label="Select row"></td>` : ''}
        ${cols.map(c => `<td class="${c.align === 'right' ? 'ops-num ' : ''}${c.key === '_actions' ? 'ops-actions ' : ''}${c.nowrap ? 'ops-nowrap' : ''}">${cellHtml(c, row)}</td>`).join('')}
      </tr>`;
    }).join('');

    opsAll('[data-ops-pick]', el('body')).forEach(cb => {
      /* A checkbox inside a clickable row must not also open the row. */
      cb.addEventListener('click', e => e.stopPropagation());
      cb.addEventListener('change', () => {
        if (cb.checked) g.selected.add(cb.dataset.opsPick);
        else g.selected.delete(cb.dataset.opsPick);
        cb.closest('tr').classList.toggle('sel', cb.checked);
        renderBulk();
      });
    });

    if (g.onRow) {
      opsAll('[data-ops-row]', el('body')).forEach(tr => {
        tr.addEventListener('click', e => {
          /* Row actions own their clicks. */
          if (e.target.closest('button,a,input,select')) return;
          const row = g.rows.find(r => String(g.rowKey(r)) === tr.dataset.opsRow);
          if (row) g.onRow(row);
        });
      });
    }

    /* Row-action buttons are declared by the column as
       data-ops-act="<name>" and dispatched to config.actions[name](row). */
    opsAll('[data-ops-act]', el('body')).forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const tr = btn.closest('[data-ops-row]');
        const row = g.rows.find(r => String(g.rowKey(r)) === tr.dataset.opsRow);
        config.actions?.[btn.dataset.opsAct]?.(row, btn);
      });
    });

    const all = opsEl('[data-ops-all]', el('head'));
    if (all) {
      const keys = g.rows.map(r => String(g.rowKey(r)));
      all.checked = keys.length > 0 && keys.every(k => g.selected.has(k));
    }
  }

  /* -------------------------------------------------------------- bulk */
  function renderBulk() {
    if (!g.selectable || !g.bulkActions.length) return;
    const n = g.selected.size;
    const bar = el('bulk');
    bar.classList.toggle('on', n > 0);
    if (!n) { bar.innerHTML = ''; return; }
    bar.innerHTML = `<b>${n}</b> selected
      ${g.bulkActions.map((a, i) => `<button type="button" class="ops-btn ops-btn-sm ${a.danger ? 'ops-btn-danger' : ''}" data-ops-bulk="${i}">${escapeHtml(a.label)}</button>`).join('')}
      <button type="button" class="ops-btn ops-btn-sm ops-btn-link" data-ops-clear>Clear selection</button>`;
    opsAll('[data-ops-bulk]', bar).forEach(b =>
      b.addEventListener('click', async () => {
        const action = g.bulkActions[Number(b.dataset.opsBulk)];
        const rows = selectedRows();
        if (!rows.length) return;
        await action.run(rows, api);
      }));
    opsEl('[data-ops-clear]', bar).addEventListener('click', () => {
      g.selected.clear();
      renderBody();
      renderBulk();
    });
  }

  /* Selection survives paging in server mode (the ids are kept), but the row
     objects only exist for pages that were actually loaded — so a bulk action
     operates on what is currently in hand, which is what the count shows. */
  function selectedRows() {
    return g.rows.filter(r => g.selected.has(String(g.rowKey(r))));
  }

  /* -------------------------------------------------------------- foot */
  function renderFoot() {
    const pages = Math.max(1, Math.ceil(g.total / g.pageSize));
    const from = g.total ? (g.page - 1) * g.pageSize + 1 : 0;
    const to = Math.min(g.page * g.pageSize, g.total);
    const sortWarn = g.sort && pages > 1
      ? `<span class="ops-muted">· sorted within this page only</span>` : '';
    const clientCap = g.mode === 'client' && g.total >= OPS_PAGE_MAX
      ? `<span class="ops-muted">· first ${OPS_PAGE_MAX} records (API page limit)</span>` : '';

    el('foot').innerHTML = `
      <span>${from ? `${from}–${to} of ${g.total}` : '0 records'}</span>
      ${sortWarn}${clientCap}
      <span class="ops-spacer"></span>
      <span class="ops-muted">Rows</span>
      <select data-ops-psize>${opsSelectOptions(OPS_PAGE_SIZES, g.pageSize, String)}</select>
      <span class="ops-page-btns">
        <button type="button" class="ops-btn ops-btn-sm" data-ops-page="1" ${g.page <= 1 ? 'disabled' : ''}>«</button>
        <button type="button" class="ops-btn ops-btn-sm" data-ops-page="${g.page - 1}" ${g.page <= 1 ? 'disabled' : ''}>‹</button>
        <span class="ops-muted">${g.page} / ${pages}</span>
        <button type="button" class="ops-btn ops-btn-sm" data-ops-page="${g.page + 1}" ${g.page >= pages ? 'disabled' : ''}>›</button>
        <button type="button" class="ops-btn ops-btn-sm" data-ops-page="${pages}" ${g.page >= pages ? 'disabled' : ''}>»</button>
      </span>`;

    opsAll('[data-ops-page]', el('foot')).forEach(b =>
      b.addEventListener('click', () => goPage(Number(b.dataset.opsPage))));
    opsEl('[data-ops-psize]', el('foot')).addEventListener('change', e => {
      g.pageSize = Number(e.target.value);
      g.page = 1;
      if (g.mode === 'client') { paginateClient(); renderBody(); renderFoot(); } else { load(); }
    });
    if (el('count')) {
      el('count').textContent = g.total
        ? `${g.total} record${g.total === 1 ? '' : 's'}` : 'No records';
    }
  }

  function goPage(p) {
    const pages = Math.max(1, Math.ceil(g.total / g.pageSize));
    g.page = Math.min(Math.max(1, p), pages);
    if (g.mode === 'client') { paginateClient(); renderBody(); renderFoot(); } else { load(); }
  }

  /* ------------------------------------------------------------- query */
  function readBar() {
    const s = opsEl('[data-ops-gsearch]', el('bar'));
    if (s) g.search = s.value.trim();
    opsAll('[data-ops-filter]', el('bar')).forEach(input => {
      g.filterValues[input.dataset.opsFilter] = input.value;
    });
  }
  function apply() {
    readBar();
    g.page = 1;
    g.selected.clear();
    load();
  }
  function reset() {
    g.search = '';
    g.filterValues = { ...(config.filterDefaults || {}) };
    g.sort = config.sort || null;
    g.page = 1;
    g.selected.clear();
    renderBar();
    renderHead();
    load();
  }

  /* Only non-empty filters are sent: an empty string is not "no filter" to
     FastAPI, it is a value that fails enum validation with a 422. */
  function activeFilters() {
    const out = {};
    Object.entries(g.filterValues).forEach(([k, v]) => {
      if (v !== '' && v != null) out[k] = v;
    });
    return out;
  }

  async function load() {
    const seq = ++g.seq;
    el('body').innerHTML = opsLoadingRow(colCount(), 'Loading…');
    try {
      const wantAll = g.mode === 'client';
      const res = await g.fetch({
        page: wantAll ? 1 : g.page,
        pageSize: wantAll ? OPS_PAGE_MAX : g.pageSize,
        search: g.search,
        filters: activeFilters(),
        sort: g.sort,
      });
      if (seq !== g.seq) return;    /* a newer load already won */

      if (wantAll) {
        g.allRows = res.rows || [];
        paginateClient();
      } else {
        g.rows = sortRows((res.rows || []).slice());
        g.total = res.total ?? g.rows.length;
      }
      renderBody();
      renderFoot();
      renderBulk();
      g.onLoad?.(res, api);
    } catch (err) {
      if (seq !== g.seq) return;
      g.rows = [];
      g.total = 0;
      el('body').innerHTML = opsEmptyRow(colCount(), opsError(err, 'Could not load these records.'));
      renderFoot();
    }
  }

  /* Client mode: the search box and any `match`-capable filter run in the
     browser over the single page that was fetched. */
  function paginateClient() {
    let rows = g.allRows.slice();
    const q = g.search.toLowerCase();
    if (q) {
      rows = rows.filter(r => g.columns.some(c => cellText(c, r).toLowerCase().includes(q)));
    }
    g.filters.forEach(f => {
      const v = g.filterValues[f.key];
      if (v === '' || v == null || !f.match) return;
      rows = rows.filter(r => f.match(r, v));
    });
    sortRows(rows);
    g.matchedRows = rows;
    g.total = rows.length;
    const pages = Math.max(1, Math.ceil(g.total / g.pageSize));
    if (g.page > pages) g.page = pages;
    g.rows = rows.slice((g.page - 1) * g.pageSize, g.page * g.pageSize);
  }

  /* ------------------------------------------------------------ export */
  /* Exports what the operator is actually looking at: in client mode every row
     that survived the search and filters (not just the visible page, and not
     the unfiltered fetch), in server mode the page in hand — because that is
     all the browser has. Visible columns only, in their displayed order, so
     the file matches the screen. */
  function exportRows() {
    const cols = visible().filter(c => c.key !== '_actions');
    const header = cols.map(c => c.label || c.key);
    const source = g.mode === 'client' ? g.matchedRows : g.rows;
    const body = source.map(r => cols.map(c => cellText(c, r)));
    return { header, body };
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    /* Revoke on the next tick — revoking synchronously can cancel the
       download in some browsers. */
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function doExport(format) {
    /* Prefer the server's own writer when the screen has one: it exports the
       whole filtered result set (up to 5000 rows) rather than the page in
       front of you, and the xlsx/pdf are real files from openpyxl/reportlab. */
    if (g.exportServer && g.exportServer[format]) {
      try {
        opsToast(`Preparing ${format.toUpperCase()}…`);
        const blob = await g.exportServer[format]({ search: g.search, filters: activeFilters() });
        download(blob, `${g.exportName}-${opsToday()}.${format}`);
        return;
      } catch (err) {
        return opsToast(opsError(err, 'The export failed.'), 'err');
      }
    }

    const { header, body } = exportRows();
    if (!body.length) return opsToast('There is nothing to export.', 'err');

    if (format === 'csv') {
      /* RFC 4180 quoting, and a BOM so Excel opens UTF-8 correctly instead of
         mangling ₹ and non-ASCII passenger names. */
      const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const csv = [header, ...body].map(r => r.map(esc).join(',')).join('\r\n');
      download(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }),
        `${g.exportName}-${opsToday()}.csv`);
      opsToast(`Exported ${body.length} row${body.length === 1 ? '' : 's'} to CSV.`, 'ok');
      return;
    }

    if (format === 'xlsx') {
      /* SpreadsheetML: one worksheet, no dependency, opens everywhere. Saved
         as .xls because that is the format it actually is. */
      const cell = v => `<Cell><Data ss:Type="String">${escapeHtml(String(v ?? ''))}</Data></Cell>`;
      const rowXml = r => `<Row>${r.map(cell).join('')}</Row>`;
      const xml = `<?xml version="1.0"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
          xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Worksheet ss:Name="${escapeHtml((g.title || g.exportName).slice(0, 28) || 'Export')}">
  <Table>${rowXml(header)}${body.map(rowXml).join('')}</Table>
 </Worksheet>
</Workbook>`;
      download(new Blob([xml], { type: 'application/vnd.ms-excel' }),
        `${g.exportName}-${opsToday()}.xls`);
      opsToast(`Exported ${body.length} row${body.length === 1 ? '' : 's'} to Excel.`, 'ok');
    }
  }

  /* Print: tag the section so the print stylesheet keeps only this grid, and
     stamp a heading that says what was printed and with which filters —
     an unlabelled printout of a filtered table is a liability. */
  function doPrint() {
    const section = g.mount.closest('.ops-section') || document.body;
    const filters = Object.entries(activeFilters()).map(([k, v]) => {
      const f = g.filters.find(x => x.key === k);
      return `${f ? f.label : k}: ${v}`;
    });
    if (g.search) filters.unshift(`Search: ${g.search}`);
    el('printhead').textContent =
      `${g.title || OPS_TITLES[opsCurrentSection] || 'Report'} — ${new Date().toLocaleString('en-IN')}`
      + (filters.length ? ` — ${filters.join(', ')}` : '')
      + ` — ${g.rows.length} of ${g.total} rows`;
    section.classList.add('ops-printing');
    const cleanup = () => {
      section.classList.remove('ops-printing');
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    window.print();
    /* Safari never fires afterprint in some versions; belt and braces. */
    setTimeout(cleanup, 1500);
  }

  /* --------------------------------------------------------------- api */
  const api = {
    reload: load,
    setFilter(key, value, run = true) {
      g.filterValues[key] = value;
      renderBar();
      if (run) { g.page = 1; load(); }
    },
    setSearch(value, run = true) {
      g.search = value;
      renderBar();
      if (run) { g.page = 1; load(); }
    },
    clearSelection() { g.selected.clear(); renderBody(); renderBulk(); },
    rows: () => g.rows,
    allRows: () => (g.mode === 'client' ? g.matchedRows : g.rows),
    total: () => g.total,
    selectedRows,
    state: g,
  };

  renderBar();
  renderHead();
  renderFoot();
  load();
  return api;
}

/* ===========================================================================
   TABS
   ===========================================================================
   Several modules are one subject with two or three views over it (inventory
   vs bookings of a travel type; the payment queue vs all payments vs what a
   merchant owes). Rendering them as tabs keeps them one click apart instead of
   one sidebar entry each, which is the whole point of a workspace that is
   supposed to reach anything in the fewest clicks.

   `tabs` is [{id, label, render(host), count}]. Only the visible tab's render
   runs, and it runs once per activation — a tab is cheap to leave and come
   back to.
   =========================================================================== */
function OpsTabs(host, tabs, opts = {}) {
  const usable = tabs.filter(t => t.when === undefined || t.when);
  if (!usable.length) {
    host.innerHTML = `<div class="ops-panel"><div class="ops-panel-body">
      <div class="ops-msg ops-msg-info" style="margin:0">Nothing here is available for your account.</div>
    </div></div>`;
    return { go() {} };
  }
  const uid = `t${++opsGridSeq}`;
  host.innerHTML = `
    <div class="ops-tabs" id="${uid}-tabs"></div>
    <div id="${uid}-body"></div>`;

  let current = null;
  const bar = $(`${uid}-tabs`);
  const body = $(`${uid}-body`);

  function paint() {
    bar.innerHTML = usable.map(t => `
      <button type="button" class="ops-tab${t.id === current ? ' active' : ''}" data-ops-tab="${t.id}">
        ${escapeHtml(t.label)}${t.count != null ? ` <span class="ops-tab-count">(${t.count})</span>` : ''}
      </button>`).join('');
    opsAll('[data-ops-tab]', bar).forEach(b =>
      b.addEventListener('click', () => go(b.dataset.opsTab)));
  }

  function go(id) {
    const tab = usable.find(t => t.id === id) || usable[0];
    current = tab.id;
    paint();
    body.innerHTML = '';
    if (opts.hash) localStorage.setItem(`ops_tab_${opts.hash}`, current);
    Promise.resolve(tab.render(body)).catch(err => {
      body.innerHTML = `<div class="ops-panel"><div class="ops-panel-body">
        <div class="ops-msg ops-msg-err" style="margin:0">${escapeHtml(opsError(err, 'This view failed to load.'))}</div>
      </div></div>`;
    });
  }

  /* Remember which tab this operator works in — a finance clerk who lives on
     the verification queue should not land on the general list every time. */
  const remembered = opts.hash ? localStorage.getItem(`ops_tab_${opts.hash}`) : null;
  go(opts.start || (remembered && usable.some(t => t.id === remembered) ? remembered : usable[0].id));
  return { go, current: () => current };
}

/* ===========================================================================
   Column helpers — the same few shapes recur in a dozen grids, and a shared
   definition is why a status renders the same colour on every screen.
   =========================================================================== */
const OpsCol = {
  status(key = 'status', label = 'Status') {
    return {
      key, label, nowrap: true,
      render: r => opsTag(r[key], r.status_label),
      text: r => opsStatusLabel(r[key]),
    };
  },
  money(key, label, opts = {}) {
    return {
      key, label, align: 'right', nowrap: true,
      render: r => {
        const v = r[key];
        return v == null ? '<span class="ops-muted">—</span>' : money(Number(v));
      },
      text: r => (r[key] == null ? '' : String(r[key])),
      sortValue: r => (r[key] == null ? null : Number(r[key])),
      ...opts,
    };
  },
  date(key, label) {
    return {
      key, label, nowrap: true,
      render: r => (r[key] ? escapeHtml(fmtDate(r[key])) : '<span class="ops-muted">—</span>'),
      text: r => (r[key] ? String(r[key]).slice(0, 10) : ''),
      sortValue: r => (r[key] ? new Date(r[key]).getTime() : null),
    };
  },
  dateTime(key, label) {
    return {
      key, label, nowrap: true,
      render: r => (r[key] ? escapeHtml(fmtDateTime(r[key])) : '<span class="ops-muted">—</span>'),
      text: r => (r[key] ? String(r[key]) : ''),
      sortValue: r => (r[key] ? new Date(r[key]).getTime() : null),
    };
  },
  ref(key, label) {
    return {
      key, label, nowrap: true,
      render: r => (r[key] ? `<span class="ops-ref">${escapeHtml(r[key])}</span>` : '<span class="ops-muted">—</span>'),
    };
  },
  enumLabel(key, label) {
    return {
      key, label, nowrap: true,
      render: r => (r[key] ? escapeHtml(opsLabel(r[key])) : '<span class="ops-muted">—</span>'),
      text: r => (r[key] ? opsLabel(r[key]) : ''),
    };
  },
  actions(buttons) {
    /* buttons: [{act, label, when(row), danger, primary}] */
    return {
      key: '_actions', label: 'Action', sortable: false, width: '1%',
      render: row => buttons
        .filter(b => !b.when || b.when(row))
        .map(b => `<button type="button" class="ops-btn ops-btn-sm${b.primary ? ' ops-btn-primary' : ''}${b.danger ? ' ops-btn-danger' : ''}"
                     data-ops-act="${escapeHtml(b.act)}">${escapeHtml(b.label)}</button>`).join('') || '',
      text: () => '',
    };
  },
};
