import assert from "node:assert/strict";
import test from "node:test";

interface SessionSummary {
	id: string;
	title: string;
	createdAtMs: number;
	updatedAtMs?: number;
	archived?: boolean;
}

interface SessionView {
	ARCHIVE_GROUP: string;
	formatAge(timestampMs: number, nowMs: number): string;
	groupSessions(
		sessions: SessionSummary[],
		options: { nowMs: number; query?: string },
	): Array<{ title: string; sessions: SessionSummary[] }>;
	sessionTimestamp(session: SessionSummary): number;
}

const sessionView = require("../../media/session-view.js") as SessionView;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test("formats the age of a session as a distance from now", () => {
	const now = new Date(2026, 7, 2, 12).getTime();
	assert.equal(sessionView.formatAge(now, now), "now");
	assert.equal(sessionView.formatAge(now + 5 * MINUTE, now), "now");
	assert.equal(sessionView.formatAge(now - 30 * 1000, now), "now");
	assert.equal(sessionView.formatAge(now - 5 * MINUTE, now), "5m ago");
	assert.equal(sessionView.formatAge(now - 3 * HOUR - 20 * MINUTE, now), "3h ago");
	assert.equal(sessionView.formatAge(now - 9 * DAY, now), "9d ago");
	assert.equal(sessionView.formatAge(now - 400 * DAY, now), "1y ago");
	assert.equal(sessionView.formatAge(Number.NaN, now), "");
});

test("prefers the last write time over the creation time", () => {
	assert.equal(sessionView.sessionTimestamp({ id: "a", title: "a", createdAtMs: 10, updatedAtMs: 50 }), 50);
	assert.equal(sessionView.sessionTimestamp({ id: "a", title: "a", createdAtMs: 10 }), 10);
});

test("groups sessions into recency buckets, newest first", () => {
	const now = new Date(2026, 7, 2, 12).getTime();
	const sessions: SessionSummary[] = [
		session("older", new Date(2026, 4, 4, 10).getTime()),
		session("month", new Date(2026, 6, 13, 10).getTime()),
		session("week", new Date(2026, 6, 28, 10).getTime()),
		session("yesterday", new Date(2026, 7, 1, 20).getTime()),
		session("today-early", new Date(2026, 7, 2, 7).getTime()),
		session("today-late", new Date(2026, 7, 2, 11).getTime()),
	];

	const groups = sessionView.groupSessions(sessions, { nowMs: now });
	assert.deepEqual(
		groups.map((group) => [group.title, group.sessions.map((entry) => entry.id)]),
		[
			["Today", ["today-late", "today-early"]],
			["Yesterday", ["yesterday"]],
			["Last 7 Days", ["week"]],
			["Last 30 Days", ["month"]],
			["Older", ["older"]],
		],
	);
});

test("collects archived sessions into a trailing archive group", () => {
	const now = new Date(2026, 7, 2, 12).getTime();
	const groups = sessionView.groupSessions(
		[
			session("open", now - HOUR),
			{ ...session("filed", now - 2 * HOUR), archived: true },
			{ ...session("filed-older", new Date(2026, 4, 4, 10).getTime()), archived: true },
		],
		{ nowMs: now },
	);

	assert.deepEqual(groups.map((group) => group.title), ["Today", sessionView.ARCHIVE_GROUP]);
	assert.deepEqual(groups[1].sessions.map((entry) => entry.id), ["filed", "filed-older"]);
});

test("filters sessions by title, ignoring case and surrounding space", () => {
	const now = new Date(2026, 7, 2, 12).getTime();
	const sessions = [session("a", now - HOUR, "CTE binding test cases"), session("b", now - 2 * HOUR, "Rewrite Table API")];

	assert.deepEqual(flatIds(sessionView.groupSessions(sessions, { nowMs: now, query: "  cte " })), ["a"]);
	assert.deepEqual(flatIds(sessionView.groupSessions(sessions, { nowMs: now, query: "api" })), ["b"]);
	assert.deepEqual(flatIds(sessionView.groupSessions(sessions, { nowMs: now, query: "   " })), ["a", "b"]);
	assert.deepEqual(sessionView.groupSessions(sessions, { nowMs: now, query: "missing" }), []);
});

function session(id: string, updatedAtMs: number, title = id): SessionSummary {
	return { id, title, createdAtMs: updatedAtMs - DAY, updatedAtMs };
}

function flatIds(groups: Array<{ sessions: SessionSummary[] }>): string[] {
	return groups.flatMap((group) => group.sessions.map((entry) => entry.id));
}
