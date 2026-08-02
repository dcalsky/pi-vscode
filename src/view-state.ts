export const MAX_RESTORED_SESSIONS = 8;
export const MAX_ARCHIVED_SESSIONS = 500;

export interface OpenSessionRecord {
	id: string;
	path?: string;
}

export interface PiViewState {
	openSessions: OpenSessionRecord[];
	focusedSessionId?: string;
	archivedSessionIds: string[];
}

export function emptyViewState(): PiViewState {
	return { openSessions: [], archivedSessionIds: [] };
}

/**
 * Persisted state is workspace storage written by an older extension version or by a
 * user editing storage by hand, so every field is re-validated instead of trusted.
 */
export function normalizeViewState(value: unknown): PiViewState {
	if (!value || typeof value !== "object") return emptyViewState();
	const record = value as Record<string, unknown>;
	const archivedSessionIds = uniqueIds(record.archivedSessionIds).slice(0, MAX_ARCHIVED_SESSIONS);
	const archived = new Set(archivedSessionIds);
	const openSessions: OpenSessionRecord[] = [];
	const seen = new Set<string>();
	for (const entry of Array.isArray(record.openSessions) ? record.openSessions : []) {
		if (!entry || typeof entry !== "object") continue;
		const open = entry as Record<string, unknown>;
		const id = nonEmptyString(open.id);
		if (!id || seen.has(id) || archived.has(id)) continue;
		seen.add(id);
		const path = nonEmptyString(open.path);
		openSessions.push(path ? { id, path } : { id });
		if (openSessions.length >= MAX_RESTORED_SESSIONS) break;
	}

	const focusedSessionId = nonEmptyString(record.focusedSessionId);
	return {
		openSessions,
		archivedSessionIds,
		...(focusedSessionId && seen.has(focusedSessionId) ? { focusedSessionId } : {}),
	};
}

export function setArchived(state: PiViewState, sessionId: string, archived: boolean): PiViewState {
	const id = nonEmptyString(sessionId);
	if (!id) return state;
	const ids = state.archivedSessionIds.filter((candidate) => candidate !== id);
	if (archived) ids.unshift(id);
	return {
		...state,
		archivedSessionIds: ids.slice(0, MAX_ARCHIVED_SESSIONS),
		openSessions: archived ? state.openSessions.filter((session) => session.id !== id) : state.openSessions,
		...(archived && state.focusedSessionId === id ? { focusedSessionId: undefined } : {}),
	};
}

function uniqueIds(value: unknown): string[] {
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const entry of Array.isArray(value) ? value : []) {
		const id = nonEmptyString(entry);
		if (!id || seen.has(id)) continue;
		seen.add(id);
		ids.push(id);
	}
	return ids;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}
