import { useState, type FormEvent } from 'react';
import { DELEGATE_ADAPTERS, isFinished, type AdapterId, type Task } from '@voltran/shared';
import { api } from '../api.ts';
import { reportError, useUi, type Dialog } from '../store.ts';
import { agentPanes } from '../tasks.ts';
import { Modal } from './Dialogs.tsx';

const NO_TASKS: Task[] = [];

export function TaskDialog({ dialog, onClose }: { dialog: Extract<Dialog, { kind: 'task' }>; onClose: () => void }) {
    const app = useUi((state) => state.app);
    const selectedSessionId = useUi((state) => state.selectedSessionId);
    const tasks = useUi((state) => state.app?.tasks ?? NO_TASKS).filter((task) => task.projectId === dialog.projectId);
    const panes = app ? agentPanes(app, dialog.projectId) : [];
    const sessions = (app?.sessions ?? []).filter(
        (session) => session.projectId === dialog.projectId && !session.archived,
    );
    const labelOf = (adapter: AdapterId): string =>
        app?.adapters.find((entry) => entry.id === adapter)?.label ?? adapter;
    const sessionTitle = (id: string): string => sessions.find((session) => session.id === id)?.title ?? '';
    const handoffPane = panes.find((pane) => pane.id === dialog.handoffFrom);

    const [prompt, setPrompt] = useState('');
    const [title, setTitle] = useState('');
    const [targets, setTargets] = useState<string[]>(
        (dialog.paneIds ?? []).filter((id) => panes.some((pane) => pane.id === id && id !== dialog.handoffFrom)),
    );
    const [newAgent, setNewAgent] = useState<AdapterId | null>(null);
    const [sessionId, setSessionId] = useState(
        dialog.sessionId ??
            (sessions.some((session) => session.id === selectedSessionId) ? selectedSessionId : sessions[0]?.id) ??
            '',
    );
    const [dependsOn, setDependsOn] = useState<string[]>(dialog.dependsOn ?? []);
    const [handoffFrom, setHandoffFrom] = useState(dialog.handoffFrom ?? '');
    const [parentId, setParentId] = useState(dialog.parentId ?? '');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const waitable = tasks
        .filter((task) => task.status !== 'failed' && task.status !== 'cancelled')
        .slice(-30)
        .reverse();
    const parents = tasks
        .filter((task) => !isFinished(task.status) || task.status === 'done')
        .slice(-30)
        .reverse();
    const delegates = (app?.adapters ?? []).filter((adapter) => DELEGATE_ADAPTERS.includes(adapter.id));

    const toggleTarget = (id: string): void => {
        setNewAgent(null);
        setTargets((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));
    };
    const toggleDependency = (id: string): void =>
        setDependsOn((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));

    const submit = async (event: FormEvent): Promise<void> => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
            const created = await api.createTasks({
                prompt,
                title: title.trim() || undefined,
                ...(newAgent ? { adapter: newAgent, sessionId } : { paneIds: targets }),
                dependsOn,
                parentId: parentId || null,
                handoffFrom: handoffFrom || null,
            });
            useUi
                .getState()
                .showToast(
                    created.length > 1
                        ? `Queued for ${created.length} agents`
                        : newAgent
                          ? `Queued for a new ${labelOf(newAgent)} pane`
                          : 'Queued',
                );
            onClose();
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure));
            setBusy(false);
        }
    };

    const heading = handoffPane
        ? `Hand off from ${handoffPane.title}`
        : targets.length === 1 && dialog.paneIds?.length === 1
          ? `Queue a task for ${panes.find((pane) => pane.id === targets[0])?.title ?? 'this agent'}`
          : 'New task';

    return (
        <Modal title={heading} onClose={onClose} className="modal--task">
            <form className="form" onSubmit={(event) => void submit(event).catch(reportError)}>
                <label className="field">
                    <span className="field__label">Prompt</span>
                    <textarea
                        className="field__input field__input--area"
                        value={prompt}
                        onChange={(event) => setPrompt(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                                event.preventDefault();
                                event.currentTarget.form?.requestSubmit();
                            }
                        }}
                        placeholder={
                            handoffPane
                                ? 'What should the next agent do with this context?'
                                : 'What should the agent do?'
                        }
                        rows={5}
                        data-autofocus
                        required
                    />
                </label>
                <fieldset className="field">
                    <legend className="field__label">
                        Send to <span className="field__optional">pick several to broadcast</span>
                    </legend>
                    <div className="chips">
                        {panes
                            .filter((pane) => pane.id !== handoffFrom)
                            .map((pane) => (
                                <button
                                    key={pane.id}
                                    type="button"
                                    className={`chip${targets.includes(pane.id) ? ' is-selected' : ''}`}
                                    aria-pressed={targets.includes(pane.id)}
                                    title={`${labelOf(pane.adapter)} in ${sessionTitle(pane.sessionId)}`}
                                    onClick={() => toggleTarget(pane.id)}
                                >
                                    {pane.title}
                                    {sessions.length > 1 ? (
                                        <span className="chip__note">{sessionTitle(pane.sessionId)}</span>
                                    ) : null}
                                </button>
                            ))}
                        {delegates.map((adapter) => (
                            <button
                                key={adapter.id}
                                type="button"
                                className={`chip chip--new${newAgent === adapter.id ? ' is-selected' : ''}`}
                                aria-pressed={newAgent === adapter.id}
                                disabled={!adapter.available || sessions.length === 0}
                                onClick={() => {
                                    setTargets([]);
                                    setNewAgent(newAgent === adapter.id ? null : adapter.id);
                                }}
                            >
                                + {adapter.label}
                                {!adapter.available ? <span className="chip__note">not installed</span> : null}
                            </button>
                        ))}
                    </div>
                </fieldset>
                {newAgent && sessions.length > 1 ? (
                    <label className="field">
                        <span className="field__label">Open the new pane in</span>
                        <select
                            className="field__input"
                            value={sessionId}
                            onChange={(event) => setSessionId(event.target.value)}
                        >
                            {sessions.map((session) => (
                                <option key={session.id} value={session.id}>
                                    {session.title}
                                </option>
                            ))}
                        </select>
                    </label>
                ) : null}
                {waitable.length > 0 ? (
                    <fieldset className="field">
                        <legend className="field__label">
                            Start after <span className="field__optional">their results go along</span>
                        </legend>
                        <div className="task-picks">
                            {waitable.map((task) => (
                                <label key={task.id} className="check">
                                    <input
                                        type="checkbox"
                                        checked={dependsOn.includes(task.id)}
                                        onChange={() => toggleDependency(task.id)}
                                    />
                                    <span>
                                        {task.title}
                                        <span className="check__note">
                                            {task.status} ·{' '}
                                            {panes.find((pane) => pane.id === task.paneId)?.title ?? 'closed pane'}
                                        </span>
                                    </span>
                                </label>
                            ))}
                        </div>
                    </fieldset>
                ) : null}
                <div className="field-row field-row--even">
                    <label className="field">
                        <span className="field__label">Hand off context from</span>
                        <select
                            className="field__input"
                            value={handoffFrom}
                            onChange={(event) => {
                                setHandoffFrom(event.target.value);
                                setTargets((current) => current.filter((id) => id !== event.target.value));
                            }}
                        >
                            <option value="">Nobody</option>
                            {panes.map((pane) => (
                                <option key={pane.id} value={pane.id}>
                                    {pane.title}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="field">
                        <span className="field__label">Subtask of</span>
                        <select
                            className="field__input"
                            value={parentId}
                            onChange={(event) => setParentId(event.target.value)}
                        >
                            <option value="">No parent</option>
                            {parents.map((task) => (
                                <option key={task.id} value={task.id}>
                                    {task.title}
                                </option>
                            ))}
                        </select>
                    </label>
                </div>
                <label className="field">
                    <span className="field__label">
                        Title <span className="field__optional">optional</span>
                    </span>
                    <input
                        className="field__input"
                        value={title}
                        onChange={(event) => setTitle(event.target.value)}
                        placeholder="The prompt's first line"
                    />
                </label>
                {handoffFrom ? (
                    <p className="form__aside">
                        The agent gets the last reply and the notes of{' '}
                        {panes.find((pane) => pane.id === handoffFrom)?.title ?? 'that pane'} in front of the prompt.
                    </p>
                ) : null}
                {error ? (
                    <p className="form__error" role="alert">
                        {error}
                    </p>
                ) : null}
                <div className="form__actions">
                    <button type="button" className="button button--ghost" onClick={onClose}>
                        Cancel
                    </button>
                    <button
                        type="submit"
                        className="button button--primary"
                        disabled={busy || !prompt.trim() || (targets.length === 0 && !newAgent)}
                    >
                        {targets.length > 1 ? `Queue for ${targets.length} agents` : 'Queue task'}
                    </button>
                </div>
            </form>
        </Modal>
    );
}
