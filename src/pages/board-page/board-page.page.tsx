import { Fragment, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
	BackdashError,
	useBackdash,
	useBoard,
	useClientActions,
	type Column,
	type Task,
} from "react-backdash";
import { ConfirmDialog } from "../../components/confirm-dialog/confirm-dialog.component.tsx";
import { TagManager } from "../../components/tag-manager/tag-manager.component.tsx";
import { TaskEditor } from "../../components/task-editor/task-editor.component.tsx";
import styles from "./board-page.module.scss";

type DragState =
	{ kind: "column"; id: number } | { kind: "task"; id: number; fromColumnId: number } | null;

function formatDue(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function TaskCard({
	task,
	column,
	colIndex,
	boardId,
	taskNameById,
	taskColIndexById,
	isDragSource,
	drag,
	onDragStartTask,
	onDropOnTask,
	onTaskDragOver,
	onDragEnd,
	onEdit,
}: {
	task: Task;
	column: Column;
	colIndex: number;
	boardId: string;
	taskNameById: Map<number, string>;
	taskColIndexById: Map<number, number>;
	isDragSource: boolean;
	drag: DragState;
	onDragStartTask: (task: Task, columnId: number) => void;
	onDropOnTask: (taskId: number, columnId: number) => void;
	onTaskDragOver: (task: Task, columnId: number) => void;
	onDragEnd: () => void;
	onEdit: (task: Task) => void;
}) {
	const { updateTask, deleteTask, claimTask, releaseTask } = useClientActions();
	const [renaming, setRenaming] = useState(false);
	const [title, setTitle] = useState("");

	// A freshly-created task may not yet carry these arrays (the server omits
	// empty lists and the optimistic create predates the server response), so
	// normalize them here. An undefined field would otherwise throw in the badge
	// code below and, with no error boundary, unmount the whole board.
	const todos = task.todos ?? [];
	const tags = task.tags ?? [];
	const dependsOn = task.dependsOn ?? [];
	const dependents = task.dependents ?? [];

	// Grey a task out when any of its dependencies is NOT ahead of it: the
	// dependency sits in the same column or one to the left. A dependency in a
	// strictly later column is fine (id missing from the map is treated as ok).
	const blocked = dependsOn.some((id) => {
		const depCol = taskColIndexById.get(id);
		return depCol !== undefined && depCol <= colIndex;
	});

	const todosDone = todos.filter((t) => t.status === "completed").length;
	const hasBadges =
		task.priority !== null ||
		tags.length > 0 ||
		task.assignee !== null ||
		task.estimate !== null ||
		task.dueAt !== null ||
		dependsOn.length > 0 ||
		dependents.length > 0 ||
		todos.length > 0;

	function commitRename() {
		setRenaming(false);
		const trimmed = title.trim();
		if (trimmed && trimmed !== task.name) {
			void updateTask(boardId, column.id, task.id, { name: trimmed }).catch(() => undefined);
		}
	}

	return (
		<div
			className={`${styles.task} ${isDragSource ? styles.dragging : ""} ${blocked ? styles.blocked : ""}`}
			draggable
			data-task-id={task.id}
			data-blocked={blocked ? "true" : undefined}
			title={blocked ? "Blocked: a dependency is in the same or an earlier column" : undefined}
			onDragStart={(e) => {
				// don't let the column lane interpret this as a column drag
				e.stopPropagation();
				e.dataTransfer.effectAllowed = "move";
				onDragStartTask(task, column.id);
			}}
			onDragEnd={onDragEnd}
			onDragOver={(e) => {
				e.preventDefault();
				e.stopPropagation();
				if (drag?.kind === "task") onTaskDragOver(task, column.id);
			}}
			onDrop={(e) => {
				e.preventDefault();
				e.stopPropagation();
				onDropOnTask(task.id, column.id);
			}}
		>
			<div className={styles.taskTop}>
				<span className={styles.handle} title="Drag task">
					⠿
				</span>
				<div className={styles.taskActions}>
					<button
						type="button"
						className="icon-btn"
						title="Edit task"
						onClick={(e) => {
							e.stopPropagation();
							onEdit(task);
						}}
					>
						✎
					</button>
					<button type="button" className="icon-btn" title="Delete task" onClick={() => void deleteTask(boardId, column.id, task.id).catch(() => undefined)}>
						✕
					</button>
				</div>
			</div>
			{renaming ? (
				<input
					className={styles.rename}
					value={title}
					autoFocus
					draggable={false}
					onClick={(e) => e.stopPropagation()}
					onChange={(e) => setTitle(e.target.value)}
					onBlur={commitRename}
					onKeyDown={(e) => {
						if (e.key === "Enter") commitRename();
						if (e.key === "Escape") setRenaming(false);
					}}
				/>
			) : (
				<span
					className={styles.taskName}
					data-task-name={task.id}
					onDoubleClick={() => {
						setTitle(task.name);
						setRenaming(true);
					}}
					title="Double-click to rename"
				>
					{task.name}
				</span>
			)}
			{task.description && <div className={styles.taskDesc}>{task.description}</div>}
			{hasBadges && (
				<div className={styles.badges}>
					{task.priority && (
						<span className={`${styles.priority} ${styles[`prio_${task.priority}`]}`}>
							{task.priority}
						</span>
					)}
					{todos.length > 0 && (
						<span
							className={`${styles.metaBadge} ${
								todosDone === todos.length ? styles.todosDone : ""
							} ${styles.todosBadge}`}
							title={`${todosDone}/${todos.length} todos done`}
						>
							☑ {todosDone}/{todos.length}
						</span>
					)}
					{tags.map((tag) => (
						<span
							key={tag.id}
							className={styles.tag}
							style={tag.color ? { borderColor: tag.color, color: tag.color } : undefined}
						>
							{tag.name}
						</span>
					))}
					{task.assignee && <span className={styles.metaBadge}>@{task.assignee}</span>}
					{task.estimate !== null && <span className={styles.metaBadge}>{task.estimate} pts</span>}
					{task.dueAt && <span className={styles.metaBadge}>{formatDue(task.dueAt)}</span>}
					{dependsOn.length > 0 && (
						<span
							className={`${styles.metaBadge} ${styles.depBadge}`}
							title={`Depends on: ${dependsOn
								.map((id) => taskNameById.get(id) ?? `#${id}`)
								.join(", ")}`}
						>
							⛓ {dependsOn.length}
						</span>
					)}
					{dependents.length > 0 && (
						<span
							className={`${styles.metaBadge} ${styles.depBadge}`}
							title={`Blocks: ${dependents
								.map((id) => taskNameById.get(id) ?? `#${id}`)
								.join(", ")}`}
						>
							⇢ {dependents.length}
						</span>
					)}
				</div>
			)}
			<div className={styles.taskMeta}>
				{task.claimedBy ? (
					<>
						<span className={styles.claimedBadge}>{task.claimedBy}</span>
						<button
							type="button"
							className="btn btn-ghost"
							title="Release the task"
							onClick={() => void releaseTask(boardId, column.id, task.id).catch(() => undefined)}
						>
							Release
						</button>
					</>
				) : column.isQueue ? (
					<button
						type="button"
						className="btn btn-ghost"
						title="Claim the task"
						onClick={() => void claimTask(boardId, column.id, task.id).catch(() => undefined)}
					>
						Claim
					</button>
				) : null}
			</div>
		</div>
	);
}

function ColumnCard({
	column,
	colIndex,
	boardId,
	taskNameById,
	taskColIndexById,
	drag,
	dropTarget,
	onColumnDragStart,
	onColumnDrop,
	onTaskDragStart,
	onDropOnTask,
	onTaskDragOver,
	onColumnDragOver,
	onDragEnd,
	onEdit,
}: {
	column: Column;
	colIndex: number;
	boardId: string;
	taskNameById: Map<number, string>;
	taskColIndexById: Map<number, number>;
	drag: DragState;
	dropTarget: { columnId: number; position: number | null } | null;
	onColumnDragStart: (id: number) => void;
	onColumnDrop: (id: number) => void;
	onTaskDragStart: (task: Task, columnId: number) => void;
	onDropOnTask: (taskId: number, columnId: number) => void;
	onTaskDragOver: (task: Task, columnId: number) => void;
	onColumnDragOver: (columnId: number) => void;
	onDragEnd: () => void;
	onEdit: (task: Task) => void;
}) {
	const { updateColumn, deleteColumn, createTask } = useClientActions();
	const [renaming, setRenaming] = useState(false);
	const [title, setTitle] = useState("");
	const [taskName, setTaskName] = useState("");
	const [confirming, setConfirming] = useState(false);

	// Insertion index for the drag ghost in this column, or null when this
	// column is not the drop target. `dropTarget.position === null` (or no task
	// at/after it) means append to the end.
	const ghostIndex = (() => {
		if (drag?.kind !== "task" || dropTarget?.columnId !== column.id) return null;
		const pos = dropTarget.position;
		if (pos === null) return column.tasks.length;
		const idx = column.tasks.findIndex((t) => t.position >= pos);
		return idx === -1 ? column.tasks.length : idx;
	})();

	function commitRename() {
		setRenaming(false);
		const trimmed = title.trim();
		if (trimmed && trimmed !== column.name) {
			void updateColumn(boardId, column.id, { name: trimmed }).catch(() => undefined);
		}
	}

	function confirmDelete() {
		setConfirming(false);
		void deleteColumn(boardId, column.id).catch(() => undefined);
	}

	function addTask(e: React.FormEvent) {
		e.preventDefault();
		const trimmed = taskName.trim();
		if (!trimmed) return;
		setTaskName("");
		void createTask(boardId, column.id, { name: trimmed }).catch(() => undefined);
	}

	return (
		<>
			<div
				className={`${styles.card} ${drag?.kind === "column" && drag.id === column.id ? styles.dragging : ""}`}
				draggable
				data-column-id={column.id}
				onDragStart={(e) => {
					e.dataTransfer.effectAllowed = "move";
					onColumnDragStart(column.id);
				}}
				onDragEnd={onDragEnd}
				onDragOver={(e) => {
					e.preventDefault();
					if (drag?.kind === "task") onColumnDragOver(column.id);
				}}
				onDrop={(e) => {
					e.preventDefault();
					onColumnDrop(column.id);
				}}
			>
				<div className={styles.cardTop}>
					<span className={styles.handle} title="Drag to reorder">
						⠿
					</span>
					{renaming ? (
						<input
							className={styles.rename}
							value={title}
							autoFocus
							draggable={false}
							onClick={(e) => e.stopPropagation()}
							onChange={(e) => setTitle(e.target.value)}
							onBlur={commitRename}
							onKeyDown={(e) => {
								if (e.key === "Enter") commitRename();
								if (e.key === "Escape") setRenaming(false);
							}}
						/>
					) : (
						<span
							className={styles.name}
							data-column-name={column.id}
							onDoubleClick={() => {
								setTitle(column.name);
								setRenaming(true);
							}}
							title="Double-click to rename"
						>
							{column.name}
						</span>
					)}
					<button
						type="button"
						className="icon-btn"
						title="Delete column"
						onClick={() => setConfirming(true)}
					>
						✕
					</button>
				</div>
				<button
					type="button"
					className={`${styles.queueToggle} ${column.isQueue ? styles.queueOn : ""}`}
					title={
						column.isQueue
							? "Queue column — agents can claim its tasks. Click to make it a normal column."
							: "Mark as a queue so agents can claim its tasks."
					}
					onClick={() =>
						void updateColumn(boardId, column.id, { isQueue: !column.isQueue }).catch(
							() => undefined,
						)
					}
				>
					{column.isQueue ? "queue" : "+ queue"}
				</button>

				<div className={styles.tasks}>
					{column.tasks.map((task, index) => (
						<Fragment key={task.id}>
							{ghostIndex === index && (
								<div className={styles.dropGhost} data-drop-ghost aria-hidden="true" />
							)}
							<TaskCard
								key={task.id}
								task={task}
								column={column}
								colIndex={colIndex}
								boardId={boardId}
								taskNameById={taskNameById}
								taskColIndexById={taskColIndexById}
								isDragSource={drag?.kind === "task" && drag.id === task.id}
								drag={drag}
								onDragStartTask={onTaskDragStart}
								onDropOnTask={onDropOnTask}
								onTaskDragOver={onTaskDragOver}
								onDragEnd={onDragEnd}
								onEdit={onEdit}
							/>
						</Fragment>
					))}
					{ghostIndex === column.tasks.length && (
						<div className={styles.dropGhost} data-drop-ghost aria-hidden="true" />
					)}
					{column.tasks.length === 0 && <div className={styles.empty}>No tasks</div>}
				</div>

				<form className={styles.addTask} onSubmit={addTask}>
					<input
						value={taskName}
						placeholder="Add task…"
						aria-label={`New task in ${column.name}`}
						onChange={(e) => setTaskName(e.target.value)}
					/>
					<button type="submit" className="btn btn-primary" disabled={!taskName.trim()}>
						Add
					</button>
				</form>
			</div>
			<ConfirmDialog
				open={confirming}
				title="Delete column"
				message={`Delete column "${column.name}"?`}
				confirmLabel="Delete"
				danger
				onConfirm={confirmDelete}
				onCancel={() => setConfirming(false)}
			/>
		</>
	);
}

export function BoardPage() {
	const { boardId = "" } = useParams();
	const navigate = useNavigate();
	const client = useBackdash();
	const board = useBoard(boardId);
	const { createColumn, reorderColumns, deleteBoard, moveTask } = useClientActions();

	const [missingId, setMissingId] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [drag, setDrag] = useState<DragState>(null);
	const [dropTarget, setDropTarget] = useState<{ columnId: number; position: number | null } | null>(null);
	const [confirming, setConfirming] = useState(false);
	const [editing, setEditing] = useState<{ columnId: number; taskId: number } | null>(null);
	const [tagsOpen, setTagsOpen] = useState(false);
	const notFound = missingId === boardId;

	// Resolve the editor's task from the live board so it stays fresh while open
	const editingTask = editing
		? (board?.columns
				.find((c) => c.id === editing.columnId)
				?.tasks.find((t) => t.id === editing.taskId) ?? null)
		: null;

	// id -> name and id -> column index across the whole board, so dependency
	// badges can name their related tasks and the blocked state can tell whether
	// a dependency sits in the same or an earlier column.
	const { taskNameById, taskColIndexById } = useMemo(() => {
		const nameById = new Map<number, string>();
		const colIndexById = new Map<number, number>();
		board?.columns.forEach((c, ci) =>
			c.tasks.forEach((t) => {
				nameById.set(t.id, t.name);
				colIndexById.set(t.id, ci);
			}),
		);
		return { taskNameById: nameById, taskColIndexById: colIndexById };
	}, [board]);

	useEffect(() => {
		client.getBoard(boardId).catch((error) => {
			if (error instanceof BackdashError && error.status === 404) setMissingId(boardId);
		});
	}, [client, boardId]);

	// Reorder columns; `targetId` null means "dropped outside a column" (go to end).
	function handleColumnDrop(targetId: number | null) {
		if (drag?.kind !== "column" || !board) {
			setDrag(null);
			return;
		}
		const dragId = drag.id;
		const ids = board.columns.map((c) => c.id);
		const from = ids.indexOf(dragId);
		if (targetId !== null && targetId !== dragId) {
			const forward = from < ids.indexOf(targetId);
			ids.splice(from, 1);
			ids.splice(ids.indexOf(targetId) + (forward ? 1 : 0), 0, dragId);
		} else if (targetId === null) {
			ids.splice(from, 1);
			ids.push(dragId);
		} else {
			setDrag(null);
			return;
		}
		void reorderColumns(board.id, ids).catch(() => undefined);
		setDrag(null);
	}

	function handleTaskDrop(target: { columnId: number; position?: number } | null) {
		if (drag?.kind !== "task" || !board) {
			setDrag(null);
			setDropTarget(null);
			return;
		}
		// Dropping outside a column is a no-op: the task stays where it was.
		if (target) {
			void moveTask(board.id, drag.id, {
				columnId: target.columnId,
				position: target.position,
			}).catch(() => undefined);
		}
		setDrag(null);
		setDropTarget(null);
	}

	// Hover reporting for the drag ghost: hovering a specific task targets the
	// slot just before it; hovering the column lane targets the end of the column.
	function onTaskDragOver(task: Task, columnId: number) {
		setDropTarget({ columnId, position: task.position });
	}

	function onColumnDragOver(columnId: number) {
		setDropTarget({ columnId, position: null });
	}

	function onColumnDrop(columnId: number) {
		if (drag?.kind === "column") handleColumnDrop(columnId);
		else if (drag?.kind === "task") handleTaskDrop({ columnId });
		else setDrag(null);
	}

	function onDropOnTask(targetTaskId: number, columnId: number) {
		if (drag?.kind === "task" && board) {
			const target = board.columns
				.find((c) => c.id === columnId)
				?.tasks.find((t) => t.id === targetTaskId);
			// insert just before the hovered task
			if (target) handleTaskDrop({ columnId, position: target.position });
		}
		setDrag(null);
	}

	function onTaskDragStart(task: Task, columnId: number) {
		setDrag({ kind: "task", id: task.id, fromColumnId: columnId });
	}

	function onColumnDragStart(id: number) {
		setDrag({ kind: "column", id });
	}

	function addColumn(e: React.FormEvent) {
		e.preventDefault();
		const trimmed = name.trim();
		if (!trimmed || !board) return;
		setName("");
		void createColumn(board.id, { name: trimmed }).catch(() => undefined);
	}

	function deleteBoardConfirmed() {
		if (!board) return;
		setConfirming(false);
		void deleteBoard(board.id)
			.then(() => navigate("/boards"))
			.catch(() => undefined);
	}

	if (notFound) {
		return (
			<div className={styles.page}>
				<div className={styles.inner}>
					<p>Board not found.</p>
					<Link to="/boards">Back to boards</Link>
				</div>
			</div>
		);
	}

	if (!board) {
		return (
			<div className={styles.page}>
				<div className={styles.inner}>
					<p>Loading…</p>
				</div>
			</div>
		);
	}

	return (
		<div
			className={styles.page}
			onDragOver={(e) => e.preventDefault()}
			onDrop={(e) => {
				e.preventDefault();
				if (drag?.kind === "column") handleColumnDrop(null);
				else setDrag(null);
			}}
		>
			<div className={styles.inner}>
				<div className={styles.header}>
					<button type="button" className="btn btn-ghost" onClick={() => navigate("/boards")}>
						← Boards
					</button>
					<h1 className={styles.title}>{board.name}</h1>
					<button
						type="button"
						className="btn btn-ghost"
						title="Create and edit task tags"
						onClick={() => setTagsOpen(true)}
					>
						Tags
					</button>
					<button
						type="button"
						className="icon-btn"
						title="Delete board"
						onClick={() => setConfirming(true)}
					>
						✕
					</button>
				</div>

				<div className={styles.columns}>
					{board.columns.map((column, colIndex) => (
						<ColumnCard
							key={column.id}
							column={column}
							colIndex={colIndex}
							boardId={board.id}
							taskNameById={taskNameById}
							taskColIndexById={taskColIndexById}
							drag={drag}
							dropTarget={dropTarget}
							onColumnDragStart={onColumnDragStart}
							onColumnDrop={onColumnDrop}
							onTaskDragStart={onTaskDragStart}
							onDropOnTask={onDropOnTask}
							onTaskDragOver={onTaskDragOver}
							onColumnDragOver={onColumnDragOver}
							onDragEnd={() => {
								setDrag(null);
								setDropTarget(null);
							}}
							onEdit={(task) => setEditing({ columnId: task.columnId, taskId: task.id })}
						/>
					))}
					{board.columns.length === 0 && (
						<div className={styles.hint}>No columns yet. Add one below.</div>
					)}
					<form className={styles.addCard} onSubmit={addColumn}>
						<input
							value={name}
							placeholder="Add column…"
							aria-label="New column name"
							onChange={(e) => setName(e.target.value)}
						/>
						<button type="submit" className="btn btn-primary" disabled={!name.trim()}>
							Add
						</button>
					</form>
				</div>
			</div>
			<ConfirmDialog
				open={confirming}
				title="Delete board"
				message={`Delete board "${board.name}"? This removes its columns.`}
				confirmLabel="Delete"
				danger
				onConfirm={deleteBoardConfirmed}
				onCancel={() => setConfirming(false)}
			/>
			{tagsOpen && <TagManager boardId={board.id} open onClose={() => setTagsOpen(false)} />}
			{editingTask && (
				<TaskEditor
					key={editingTask.id}
					boardId={board.id}
					task={editingTask}
					open
					onClose={() => setEditing(null)}
				/>
			)}
		</div>
	);
}
