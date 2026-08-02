import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface FileLinkTarget {
	path: string;
	line?: number;
	column?: number;
}

export function resolveFileLink(target: string, cwd: string, home = homedir()): FileLinkTarget {
	const match = /^(.*?)(?::(\d+)(?::(\d+))?)?$/.exec(target);
	const rawPath = match?.[1] ?? target;
	const path = rawPath === "~" ? home : rawPath.startsWith("~/") || rawPath.startsWith("~\\") ? join(home, rawPath.slice(2)) : rawPath;
	const line = oneBasedPosition(match?.[2]);
	const column = oneBasedPosition(match?.[3]);
	return {
		path: isAbsolute(path) ? path : resolve(cwd, path),
		...(line === undefined ? {} : { line }),
		...(column === undefined ? {} : { column }),
	};
}

export function httpUrl(target: string): string | undefined {
	try {
		const url = new URL(target);
		return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}

function oneBasedPosition(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const position = Number(value);
	return Number.isSafeInteger(position) && position > 0 ? position - 1 : undefined;
}
