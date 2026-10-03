// Task integration (dash <-> react-backdash <-> backdash server).
// Full flow in the browser: task create / rename / drag-reorder within a column /
// cross-column move / delete / claim / release, asserting against both the DOM
// and the server API. Boards are seeded with Todo (queue) / In Progress / Done,
// so the suite works against those real columns. Needs the backdash server
// (default :3000, BOARD_URL env).
import { newPage, sleep, typeSel, results, waitFor } from "./cdp.mjs";
import { Suite, APP_URL, BOARD_URL, authenticate, authFetch } from "./lib.mjs";

const BOARD = "e2e Tasks";
const TASKS = `[...document.querySelectorAll('[data-task-id]')]`;
const COLS = `[...document.querySelectorAll('[data-column-id]')]`;

const clickByText = (sel, text) =>
	`(() => { const els=[...document.querySelectorAll(${JSON.stringify(sel)})]; const el=els.find(e=>e.textContent.trim()===${JSON.stringify(text)}); if(!el) return {ok:false, err:"no button found"}; el.scrollIntoView({block:"center"}); el.click(); return {ok:true}; })()`;

const waitEval = async (page, expr, timeout = 5000) => {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		if (await page.eval(expr)) return true;
		await sleep(120);
	}
	return false;
};

async function deleteBoardsNamed(name) {
	try {
		const list = await authFetch(`${BOARD_URL}/kanban`).then((r) => r.json());
		for (const b of list.filter((x) => x.name === name)) {
			await authFetch(`${BOARD_URL}/kanban/${b.id}`, { method: "DELETE" });
		}
	} catch {}
}

// Add a task to a column through the UI add-task form (the submit button lives
// inside the same form, so it is unambiguous even with many columns).
async function addTask(c, col, name) {
	await c.eval(typeSel(`input[aria-label="New task in ${col}"]`, name));
	await c.eval(
		`(() => {
		const i=document.querySelector(${JSON.stringify(`input[aria-label="New task in ${col}"`)});
		if(!i) return {ok:false};
		const btn=i.closest("form").querySelector('button[type="submit"]');
		if(!btn || btn.disabled) return {ok:false, err:"no submit button"};
		btn.click(); return {ok:true};
	})()`,
	);
}

// Dispatch a synthetic drag event on the task card whose text includes `name`.
const dragTask = (type, name) =>
	`(() => {
	const el=${TASKS}.find(t=>t.textContent.includes(${JSON.stringify(name)}));
	if(!el) return false;
	el.dispatchEvent(new DragEvent(${JSON.stringify(type)},{bubbles:true,cancelable:true,dataTransfer:new DataTransfer()}));
	return true;
})()`;

// Dispatch a synthetic drag event on the column card whose header includes `name`.
const dragColumn = (type, name) =>
	`(() => {
	const el=${COLS}.find(c=>c.textContent.includes(${JSON.stringify(name)}));
	if(!el) return false;
	el.dispatchEvent(new DragEvent(${JSON.stringify(type)},{bubbles:true,cancelable:true,dataTransfer:new DataTransfer()}));
	return true;
})()`;

// Ordered task names per column, keyed by column name, straight from the server.
async function serverTasks(boardId) {
	const b = await authFetch(`${BOARD_URL}/kanban/${boardId}`).then((r) => r.json());
	const out = {};
	for (const c of b.columns) out[c.name] = c.tasks.map((t) => t.name);
	return out;
}

// Full board (all tasks, all columns) straight from the server.
async function serverBoard(boardId) {
	return await authFetch(`${BOARD_URL}/kanban/${boardId}`).then((r) => r.json());
}

const openEditor = (name) =>
	`(() => { const el=${TASKS}.find(t=>t.textContent.includes(${JSON.stringify(name)})); if(!el) return false; el.querySelector('[title="Edit task"]').click(); return true; })()`;

// Click the Add button of the editor's "New todo" form (the input's own form).
const clickEditorTodoAdd = `(() => { const i=document.querySelector('input[aria-label="New todo"]'); if(!i) return false; const b=i.closest("form").querySelector('button[type="submit"]'); if(!b||b.disabled) return false; b.click(); return true; })()`;

// Submit the whole editor form (the footer Save button, bound via form="task-editor-form").
const saveEditor = `(() => { const b=document.querySelector('button[form="task-editor-form"]'); if(!b) return false; b.click(); return true; })()`;

// Open a task's editor and set its dependencies by candidate name using the
// search picker: for each name, type it into the search box then click the
// matching candidate row. Returns true only when every step succeeded.
async function setDepsByNames(c, taskName, depNames) {
	if (!(await c.eval(openEditor(taskName)))) return false;
	await sleep(300);
	for (const dn of depNames) {
		await c.eval(typeSel('input[aria-label="Search dependency tasks"]', dn));
		await sleep(150);
		const clicked = await c.eval(
			`(() => { const row=[...document.querySelectorAll('[data-dep-candidate]')].find(r=>r.textContent.includes(${JSON.stringify(dn)})); if(!row) return false; row.click(); return true; })()`,
		);
		if (!clicked) return false;
		await sleep(150);
	}
	await c.eval(typeSel('input[aria-label="Search dependency tasks"]', ""));
	const saved = await c.eval(saveEditor);
	await sleep(500);
	return saved;
}

// Click the first editor todo status button whose current label is `label`
// (labels advance pending -> in progress -> done as it is cycled).
const clickFirstStatus = (label) =>
	`(() => { const b=document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)}); if(!b) return false; b.click(); return true; })()`;

export async function run() {
	const s = new Suite("tasks");
	await deleteBoardsNamed(BOARD); // idempotent start: clear leftovers from a failed run

	const token = await authenticate();
	const c = await newPage(`${APP_URL}/boards`, { token });
	const exc = [];
	c.on("Runtime.exceptionThrown", (p) =>
		exc.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || "unknown"),
	);
	c.on("Page.javascriptDialogOpening", () =>
		c.send("Page.handleJavaScriptDialog", { accept: false }).catch(() => {}),
	);

	let boardId = "";
	try {
		// 1. Create a board via the UI (auto-seeded with Todo/In Progress/Done)
		results("1. Create board");
		await c.eval(typeSel('input[placeholder="New board name"]', BOARD));
		s.check("create board clicked", (await c.eval(clickByText("button", "Create"))).ok);
		s.check(
			"board row appears",
			await waitEval(
				c,
				`[...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Open")`,
			),
		);

		// 2. Open it
		results("2. Open board");
		await c.eval(clickByText("button", "Open"));
		s.check(
			"navigated to board page",
			await waitEval(c, `location.pathname.startsWith("/boards/")`),
		);
		boardId = await c.eval(`location.pathname.split("/").pop()`);
		await waitEval(c, `${COLS}.length >= 3`);
		const seeded = await c.eval(`${COLS}.map(x=>x.textContent).join("|")`);
		s.check(
			"board seeded with default columns",
			/Todo/.test(seeded) && /In Progress/.test(seeded) && /Done/.test(seeded),
			seeded,
		);

		// 3. Create two tasks in "In Progress" via the UI
		results("3. Create tasks");
		await addTask(c, "In Progress", "Alpha");
		await addTask(c, "In Progress", "Beta");
		await sleep(500);
		let tasks = await serverTasks(boardId);
		s.check(
			"two tasks created in In Progress",
			(tasks["In Progress"] || []).length === 2,
			JSON.stringify(tasks),
		);
		s.check(
			"server order is [Alpha, Beta]",
			JSON.stringify(tasks["In Progress"] || []) === JSON.stringify(["Alpha", "Beta"]),
			JSON.stringify(tasks["In Progress"] || []),
		);

		// 3b. A long multi-word title wraps to multiple lines instead of being
		//     clipped with an ellipsis (the title now sits in its own full-width
		//     row below the handle/actions row). Created in Done so the exact
		//     [Alpha, Beta] order assertions above are untouched.
		results("3b. Long title wraps");
		await addTask(c, "Done", "Long multi word title that wraps across several lines instead of truncating");
		await sleep(500);
		// whiteSpace must not be nowrap, a wrapping policy must be set, and the
		// rendered title must be taller than one line. Single-line height is
		// measured with a hidden nowrap probe sharing the title's own class,
		// since computed lineHeight is "normal" (not a px value).
		const wrap = await c.eval(`(() => {
		const el=[...document.querySelectorAll('[data-task-name]')].find(e=>e.textContent.includes("wraps across several lines"));
		if(!el) return {ok:false, err:"title element not found"};
		const cs=getComputedStyle(el);
		const wrapEnabled = cs.whiteSpace !== "nowrap" && (["anywhere","break-word","break-words"].includes(cs.overflowWrap) || ["break-word","break-all"].includes(cs.wordBreak));
		const probe=document.createElement("span");
		probe.style.cssText="position:absolute;visibility:hidden;white-space:nowrap;";
		probe.className=el.className;
		probe.textContent="x";
		el.appendChild(probe);
		const single=probe.offsetHeight;
		probe.remove();
		const multiLine = el.offsetHeight > single * 1.5;
		return {ok: wrapEnabled && multiLine, whiteSpace: cs.whiteSpace, overflowWrap: cs.overflowWrap, wordBreak: cs.wordBreak, height: el.offsetHeight, singleLine: single};
	})()`);
		s.check("long title wraps to multiple lines", wrap.ok, JSON.stringify(wrap));

		// 4. Rename Alpha -> "Alpha 2" via double-click
		results("4. Rename task");
		const alphaId = await c.eval(
			`(() => { const el=${TASKS}.find(t=>t.textContent.includes("Alpha")); return el ? el.dataset.taskId : null; })()`,
		);
		s.check("found Alpha task card", !!alphaId, "id " + alphaId);
		await c.eval(
			`document.querySelector('[data-task-id="${alphaId}"]').querySelector('[data-task-name]').dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))`,
		);
		await sleep(150);
		await c.eval(
			`(() => {
			const input=document.querySelector('[data-task-id="${alphaId}"] input');
			const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;
			setter.call(input,"Alpha 2");
			input.dispatchEvent(new Event("input",{bubbles:true}));
			return true;
		})()`,
		);
		await c.eval(
			`(() => { const input=document.querySelector('[data-task-id="${alphaId}"] input'); input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true})); return true; })()`,
		);
		await sleep(500);
		tasks = await serverTasks(boardId);
		s.check(
			"task rename persisted",
			(tasks["In Progress"] || []).includes("Alpha 2"),
			JSON.stringify(tasks),
		);

		// 5. Reorder within the column: drag Beta, drop on "Alpha 2" (insert before).
		results("5. Reorder within column");
		s.check("dragstart dispatched", await c.eval(dragTask("dragstart", "Beta")));
		await sleep(80);
		s.check(
			"dragover+drop dispatched",
			(await c.eval(dragTask("dragover", "Alpha 2"))) &&
				(await c.eval(dragTask("drop", "Alpha 2"))),
		);
		await sleep(80);
		await c.eval(dragTask("dragend", "Beta"));
		await sleep(500);
		tasks = await serverTasks(boardId);
		const ip = tasks["In Progress"] || [];
		s.check(
			"reorder persisted as [Beta, Alpha 2]",
			JSON.stringify(ip) === JSON.stringify(["Beta", "Alpha 2"]),
			JSON.stringify(ip),
		);

		// 6. Cross-column move: drag Beta, drop on the "Done" column.
		results("6. Cross-column move");
		await c.eval(dragTask("dragstart", "Beta"));
		await sleep(80);
		s.check(
			"drop on Done dispatched",
			(await c.eval(dragColumn("dragover", "Done"))) && (await c.eval(dragColumn("drop", "Done"))),
		);
		await sleep(80);
		await c.eval(dragTask("dragend", "Beta"));
		await sleep(500);
		tasks = await serverTasks(boardId);
		s.check("task moved into Done", (tasks["Done"] || []).includes("Beta"), JSON.stringify(tasks));
		s.check(
			"task left In Progress",
			!(tasks["In Progress"] || []).includes("Beta"),
			JSON.stringify(tasks),
		);

		// 6b. Drag ghost / drop indicator: while dragging a task, a ghost
		//     placeholder marks the exact insertion point in the hovered column
		//     (before the hovered task, or at the end of the column). Purely a
		//     visual affordance, so this asserts against the DOM, not the server.
		results("6b. Drag ghost / drop indicator");
		s.check("ghost: dragstart dispatched", await c.eval(dragTask("dragstart", "Beta")));
		await sleep(80);
		s.check("ghost: dragover Alpha 2 dispatched", await c.eval(dragTask("dragover", "Alpha 2")));
		s.check(
			"ghost appears before Alpha 2 in the same column",
			await waitEval(c, `(() => {
			const ghost=document.querySelector('[data-drop-ghost]'); if(!ghost) return false;
			const alpha=${TASKS}.find(t=>t.textContent.includes("Alpha 2")); if(!alpha) return false;
			const sameCol=alpha.closest('[data-column-id]')===ghost.closest('[data-column-id]');
			const before=!!(ghost.compareDocumentPosition(alpha)&Node.DOCUMENT_POSITION_FOLLOWING);
			return sameCol&&before;
		})()`),
		);
		s.check("ghost: dragover Done column dispatched", await c.eval(dragColumn("dragover", "Done")));
		s.check(
			"ghost moves into the Done column (cross-column)",
			await waitEval(c, `(() => {
			const ghost=document.querySelector('[data-drop-ghost]'); if(!ghost) return false;
			const doneCol=${COLS}.find(c=>c.querySelector('[data-column-name]')?.textContent.trim()==="Done");
			return !!(doneCol&&doneCol.contains(ghost));
		})()`),
		);
		await c.eval(dragTask("drop", "Alpha 2"));
		await c.eval(dragTask("dragend", "Beta"));
		await sleep(120);
		s.check("ghost cleared after drop", await c.eval(`!document.querySelector('[data-drop-ghost]')`));
		s.check(
			"drag state cleared (source no longer dimmed)",
			await waitEval(c, `(() => { const b=${TASKS}.find(t=>t.textContent.includes("Beta")); if(!b) return false; return getComputedStyle(b).opacity==="1"; })()`),
		);

		// 7. Delete a task via the UI
		results("7. Delete task");
		await c.eval(
			`(() => { const el=${TASKS}.find(t=>t.textContent.includes("Alpha 2")); el.querySelector('[title="Delete task"]').click(); return true; })()`,
		);
		await sleep(500);
		tasks = await serverTasks(boardId);
		s.check(
			"task deleted from server",
			!(tasks["In Progress"] || []).includes("Alpha 2"),
			JSON.stringify(tasks),
		);

		// 8. Claim then release a task in the seeded queue column (Todo).
		results("8. Claim & release");
		await addTask(c, "Todo", "Gamma");
		await sleep(400);
		await c.eval(
			`(() => { const el=${TASKS}.find(t=>t.textContent.includes("Gamma")); el.querySelector('[title="Claim the task"]').click(); return true; })()`,
		);
		await sleep(400);
		const g1 = (await authFetch(`${BOARD_URL}/kanban/${boardId}`).then((r) => r.json())).columns
			.find((c) => c.name === "Todo")
			.tasks.find((t) => t.name === "Gamma");
		s.check(
			"task claimed (claimedBy set)",
			!!g1 && !!g1.claimedBy,
			JSON.stringify(g1?.claimedBy ?? null),
		);
		s.check(
			"release button appears after claim",
			await c.eval(
				`!!${TASKS}.find(t=>t.textContent.includes("Gamma"))?.querySelector('[title="Release the task"]')`,
			),
		);
		await c.eval(
			`(() => { const el=${TASKS}.find(t=>t.textContent.includes("Gamma")); const b=el.querySelector('[title="Release the task"]'); if(b) b.click(); return true; })()`,
		);
		await sleep(400);
		const g2 = (await authFetch(`${BOARD_URL}/kanban/${boardId}`).then((r) => r.json())).columns
			.find((c) => c.name === "Todo")
			.tasks.find((t) => t.name === "Gamma");
		s.check(
			"task released (claimedBy cleared)",
			!!g2 && !g2.claimedBy,
			JSON.stringify(g2?.claimedBy ?? null),
		);

		// 9. Task todos: add two via the editor, verify the server persisted them
		//    and the card shows a progress badge; then complete one and re-verify.
		results("9. Task todos (editor + badge)");
		await addTask(c, "In Progress", "Delta");
		await sleep(400);
		s.check("editor opened for Delta", await c.eval(openEditor("Delta")));
		await sleep(300);
		await c.eval(typeSel('input[aria-label="New todo"]', "first step"));
		s.check("todo 1 added to editor", await c.eval(clickEditorTodoAdd));
		await c.eval(typeSel('input[aria-label="New todo"]', "second step"));
		s.check("todo 2 added to editor", await c.eval(clickEditorTodoAdd));
		await sleep(200);
		s.check("editor saved (todos)", await c.eval(saveEditor));
		await sleep(500);
		let delta = (await serverBoard(boardId)).columns
			.flatMap((col) => col.tasks)
			.find((t) => t.name === "Delta");
		s.check(
			"server persisted 2 todos",
			!!delta && delta.todos?.length === 2,
			JSON.stringify(delta?.todos ?? null),
		);
		s.check(
			"progress badge shows 0/2",
			await c.eval(
				`!!${TASKS}.find(t=>t.textContent.includes("Delta"))?.textContent.includes("0/2")`,
			),
		);

		s.check("editor reopened for Delta", await c.eval(openEditor("Delta")));
		await sleep(300);
		s.check(
			"todo 1 -> in progress",
			await c.eval(clickFirstStatus("Pending — click to mark in progress")),
		);
		s.check(
			"todo 1 -> completed",
			await c.eval(clickFirstStatus("In progress — click to mark done")),
		);
		await sleep(150);
		s.check("editor saved (toggle)", await c.eval(saveEditor));
		await sleep(500);
		delta = (await serverBoard(boardId)).columns
			.flatMap((col) => col.tasks)
			.find((t) => t.name === "Delta");
		s.check(
			"first todo now completed",
			!!delta && delta.todos?.[0]?.status === "completed",
			JSON.stringify(delta?.todos ?? null),
		);
		s.check(
			"progress badge shows 1/2",
			await c.eval(
				`!!${TASKS}.find(t=>t.textContent.includes("Delta"))?.textContent.includes("1/2")`,
			),
		);

		// 11. Dependency UX (task #38): search-based picker + blocked-task grey-out.
		//     Dep A and Dep C sit in the Todo column (left), Dep B in In Progress (right).
		results("11. Dependency picker + blocked tasks");
		await addTask(c, "Todo", "Dep A");
		await addTask(c, "Todo", "Dep C");
		await addTask(c, "In Progress", "Dep B");
		await sleep(500);
		const depBoard = await serverBoard(boardId);
		const idOf = (n) => depBoard.columns.flatMap((col) => col.tasks).find((t) => t.name === n)?.id;
		const idA = idOf("Dep A");
		const idB = idOf("Dep B");
		const todoIdx = depBoard.columns.findIndex((col) => col.name === "Todo");
		const ipIdx = depBoard.columns.findIndex((col) => col.name === "In Progress");
		s.check(
			"created Dep A/C in Todo and Dep B in In Progress",
			!!idA && !!idB,
			JSON.stringify({ idA, idB }),
		);
		s.check(
			"Todo column is to the left of In Progress",
			todoIdx >= 0 && todoIdx < ipIdx,
			JSON.stringify({ todoIdx, ipIdx }),
		);

		// 11a. Part 1 — search-based multi-select picker (on Dep B, whose candidates include Dep A).
		s.check("picker: editor opened for Dep B", await c.eval(openEditor("Dep B")));
		await sleep(300);
		s.check(
			"picker: search input exists",
			await waitFor(c, 'input[aria-label="Search dependency tasks"]'),
		);
		s.check(
			"picker: unfiltered list shows candidates",
			(await c.eval(`[...document.querySelectorAll('[data-dep-candidate]')].length`)) >= 2,
		);
		await c.eval(typeSel('input[aria-label="Search dependency tasks"]', "Dep A"));
		await sleep(200);
		let rows = await c.eval(
			`[...document.querySelectorAll('[data-dep-candidate]')].map(r=>r.textContent)`,
		);
		s.check(
			"picker: search filters list to 'Dep A' only",
			rows.length === 1 && rows[0].includes("Dep A"),
			JSON.stringify(rows),
		);
		s.check(
			"picker: click candidate row selects it",
			await c.eval(
				`(() => { const r=[...document.querySelectorAll('[data-dep-candidate]')].find(r=>r.textContent.includes("Dep A")); if(!r) return false; r.click(); return true; })()`,
			),
		);
		await sleep(200);
		let chips = await c.eval(
			`[...document.querySelectorAll('[data-dep-chip]')].map(r=>r.textContent)`,
		);
		s.check(
			"picker: selected dep appears as a chip",
			chips.some((x) => x.includes("Dep A")),
			JSON.stringify(chips),
		);
		s.check(
			"picker: chip has a remove affordance",
			await c.eval(
				`(() => { const ch=[...document.querySelectorAll('[data-dep-chip]')].find(ch=>ch.textContent.includes("Dep A")); return !!ch && !!ch.querySelector("button"); })()`,
			),
		);
		s.check(
			"picker: removing the chip deselects it",
			await c.eval(
				`(() => { const ch=[...document.querySelectorAll('[data-dep-chip]')].find(ch=>ch.textContent.includes("Dep A")); const b=ch && ch.querySelector("button"); if(!b) return false; b.click(); return true; })()`,
			),
		);
		await sleep(200);
		chips = await c.eval(`[...document.querySelectorAll('[data-dep-chip]')].map(r=>r.textContent)`);
		s.check(
			"picker: chip removed after deselect",
			!chips.some((x) => x.includes("Dep A")),
			JSON.stringify(chips),
		);
		await c.eval(
			`(() => { const b=[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Cancel"); if(!b) return false; b.click(); return true; })()`,
		);
		await sleep(300);

		// 11b. Part 2 — grey a task out when any dependency is not ahead of it.
		s.check(
			"grey-out: set Dep B depends on Dep A (left)",
			await setDepsByNames(c, "Dep B", ["Dep A"]),
		);
		s.check(
			"grey-out: set Dep C depends on Dep B (right)",
			await setDepsByNames(c, "Dep C", ["Dep B"]),
		);
		await sleep(300);
		const blockedOf = (n) =>
			c.eval(
				`(() => { const el=${TASKS}.find(t=>t.textContent.includes(${JSON.stringify(n)})); return el ? el.dataset.blocked === "true" : null; })()`,
			);
		s.check(
			"grey-out: Dep B is blocked (dep Dep A is to its left)",
			(await blockedOf("Dep B")) === true,
		);
		s.check(
			"grey-out: Dep C is NOT blocked (dep Dep B is to its right)",
			(await blockedOf("Dep C")) === false,
		);
		s.check(
			"grey-out: Dep A is NOT blocked (has no dependencies)",
			(await blockedOf("Dep A")) === false,
		);

		// 9b. Custom Priority dropdown (replaces the native <select> in the editor).
		//      Static options (None/low/medium/high/urgent), so this exercises the
		//      new component with no model. Drives Gamma (from section 8, in Todo).
		results("9b. Priority dropdown (custom select replacement)");
		s.check("editor opened for Gamma", await c.eval(openEditor("Gamma")));
		await sleep(300);
		s.check("priority trigger is a <button>", await c.eval(`!!document.querySelector('button[aria-label="Task priority"]')`));
		s.check("no native <select> remains for priority", await c.eval(`!document.querySelector('select[aria-label="Task priority"]')`));
		s.check("opens on keyboard (ArrowDown)", await c.eval(`(() => { const b=document.querySelector('button[aria-label="Task priority"]'); if(!b) return false; b.focus(); b.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true})); return true; })()`));
		await sleep(150);
		s.check("keyboard-open shows a listbox", await c.eval(`!!document.querySelector('[role="listbox"]')`));
		s.check("Escape closes the listbox", await c.eval(`(() => { const b=document.querySelector('button[aria-label="Task priority"]'); if(!b) return false; b.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})); return true; })()`));
		await sleep(150);
		s.check("listbox gone after Escape", await c.eval(`!document.querySelector('[role="listbox"]')`));
		s.check("opens on click", await c.eval(`(() => { const b=document.querySelector('button[aria-label="Task priority"]'); if(!b) return false; b.click(); return true; })()`));
		await sleep(150);
		s.check("listbox exposes every priority", await c.eval(`(() => { const lb=document.querySelector('[role="listbox"]'); if(!lb) return false; const v=[...lb.querySelectorAll('[role="option"]')].map(o=>o.getAttribute('data-value')); return v.includes('') && v.includes('low') && v.includes('medium') && v.includes('high') && v.includes('urgent'); })()`));
		s.check("clicking 'high' closes the listbox", await c.eval(`(() => { const o=document.querySelector('[role="listbox"] [data-value="high"]'); if(!o) return false; o.click(); return true; })()`));
		await sleep(150);
		s.check("listbox closed after selecting 'high'", await c.eval(`!document.querySelector('[role="listbox"]')`));
		s.check("editor saved (priority)", await c.eval(saveEditor));
		await sleep(500);
		const gamma = (await serverBoard(boardId)).columns.flatMap((col) => col.tasks).find((t) => t.name === "Gamma");
		s.check("server persisted priority 'high'", !!gamma && gamma.priority === "high", JSON.stringify(gamma?.priority ?? null));

		// 10. Delete the board via the API; the sidebar must drop it over SSE.
		results("10. Delete board");
		await c.send("Page.navigate", { url: APP_URL + "/" });
		await sleep(400);
		const del = await authFetch(`${BOARD_URL}/kanban/${boardId}`, { method: "DELETE" });
		s.check("board deleted via API", del.status === 204 || del.status === 200);
		await sleep(800);
		s.check(
			"sidebar updated after delete",
			!(await c.eval(
				`document.querySelector("aside")?.textContent?.includes(${JSON.stringify(BOARD)})`,
			)),
		);
	} finally {
		await deleteBoardsNamed(BOARD); // never leave the scratch board behind
	}

	s.check("no uncaught page errors", exc.length === 0, exc.slice(0, 3).join(" | "));
	await c.close();
	return s.summary();
}
