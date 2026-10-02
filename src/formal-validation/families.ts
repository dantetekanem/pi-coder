import type { StorySide } from "../diff-story/plan.js";
import { declaration, functionOwners, type StoryUnit } from "../diff-story/units.js";
import type { SnapshotIndex } from "./source.js";

// A declaration longer than this is a container (an extension factory, a module wrapper), not one behavior.
const MAX_PARENT_LINES = 250;

const TEST_CASE = /^\s*(?:test|it|specify|scenario)(?:\.(?:only|skip|todo|concurrent))?\s*\(?\s*["'`]|^\s*(?:async\s+)?def\s+test_\w*/;
// Also table tests such as `it.each([...])("name %s", ...)`, which story units do not declare.
const CASE_LINE = /^\s*(?:test|it|specify|scenario)(?:\.(?:only|skip|todo|concurrent|each|fails))*\s*[(`"']|^\s*(?:async\s+)?def\s+test_\w*/;
const CASE_NAME = /^\s*(?:test|it|specify|scenario)(?:\.(?:only|skip|todo|concurrent|fails))*(?:\.each\s*(?:`[^`]*`|\((?:[^()]|\([^()]*\))*\)))?\s*\(?\s*(["'`])((?:\\.|(?!\1).)*)\1/;

/** The full test name, including apostrophes the story declaration pattern stops at, from the case's first lines. */
function caseName(source: readonly string[], start: number): string | undefined {
  const head = source.slice(start, start + 6).map((line, index) => index === 0 ? line : line.trim()).join(" ");
  return CASE_NAME.exec(head)?.[2] ?? /^\s*(?:async\s+)?def\s+(test_\w+)/.exec(head)?.[1];
}

interface Extent {
  start: number;
  end: number;
  head: string;
}

/**
 * Story ownership hands a parent's closing line to its last nested declaration, so a parent's
 * extent runs from its declaration line to its own closing line at the same indentation.
 */
function blockEnd(source: readonly string[], start: number): number {
  const head = source[start]!;
  if (/\{.*\}\s*[);,]*$/.test(head) || /^\s*def\s+\S+\s*=\s+/.test(head)) return start;
  const indent = head.search(/\S/);
  for (let line = start + 1; line < source.length; line += 1) {
    const text = source[line]!;
    if (text.trim().length === 0) continue;
    const depth = text.search(/\S/);
    if (depth < indent) return line - 1;
    if (depth !== indent) continue;
    if (!/^\s*(?:end\b|[}\])])/.test(text)) return line - 1;
    // `): Result {` closes a multi-line signature and opens the body.
    if (!/(?:[{([]|\bdo|=>)\s*$/.test(text)) return line;
  }
  return source.length - 1;
}

/** An unchanged test case around changed helper lines; its whole body is what the test proves. */
export interface EnclosingCase {
  name: string;
  fileId: string;
  side: StorySide;
  startLine: number;
  endLine: number;
}

export interface UnitFamilies {
  /** Unit ID to the ID of the changed declaration that encloses it, or itself. */
  root: Map<string, string>;
  /** Root ID to its members in unit order, root first. */
  members: Map<string, string[]>;
  /** Roots whose declaration line is a test case rather than a helper. */
  cases: Set<string>;
  /** Full test names by root, read from the case's declaration line. */
  names: Map<string, string>;
  /** Test roots that sit inside an unchanged test case. */
  enclosing: Map<string, EnclosingCase>;
  /** Units whose declaration is too long to read as one behavior. */
  containers: Set<string>;
}

/**
 * Story units split nested declarations (a const arrow inside a test, a helper inside a method) into
 * units of their own. A family puts each one back under the nearest changed declaration that encloses it.
 */
export function unitFamilies(units: readonly StoryUnit[], index: SnapshotIndex): UnitFamilies {
  const owned = new Map<string, { owners: Array<string | undefined>; extents: Map<string, Extent> }>();
  const ownersOf = (fileId: string, side: StorySide) => {
    const key = `${side}\u001f${fileId}`;
    let entry = owned.get(key);
    if (entry == null) {
      const source = index.lines(fileId, side);
      const owners = functionOwners(source);
      const extents = new Map<string, Extent>();
      owners.forEach((owner, offset) => {
        if (owner == null || extents.has(owner)) return;
        extents.set(owner, { start: offset + 1, end: blockEnd(source, offset) + 1, head: source[offset]! });
      });
      entry = { owners, extents };
      owned.set(key, entry);
    }
    return entry;
  };
  const extentsOf = (unit: StoryUnit): Partial<Record<StorySide, Extent>> => {
    const found: Partial<Record<StorySide, Extent>> = {};
    for (const anchor of unit.anchors) {
      if (found[anchor.side] != null) continue;
      const { owners, extents } = ownersOf(anchor.fileId, anchor.side);
      for (let line = anchor.startLine; line <= anchor.endLine; line += 1) {
        // Loose lines folded into a unit have no owner; the first owned line names the declaration.
        const owner = owners[line - 1];
        if (owner == null) continue;
        found[anchor.side] = extents.get(owner)!;
        break;
      }
    }
    return found;
  };
  const extents = new Map(units.map((unit) => [unit.id, extentsOf(unit)]));
  const containers = new Set(units.filter((unit) => Object.values(extents.get(unit.id)!)
    .some((extent) => extent != null && extent.end - extent.start + 1 > MAX_PARENT_LINES)).map((unit) => unit.id));

  const parent = new Map<string, string>();
  for (const unit of units) {
    const own = extents.get(unit.id)!;
    let best: { id: string; start: number } | undefined;
    for (const side of ["added", "deleted"] as const) {
      const inner = own[side];
      if (inner == null) continue;
      for (const candidate of units) {
        if (candidate.id === unit.id || candidate.path !== unit.path || containers.has(candidate.id)) continue;
        const outer = extents.get(candidate.id)![side];
        if (outer == null || outer.start >= inner.start || inner.end > outer.end) continue;
        if (best == null || outer.start > best.start) best = { id: candidate.id, start: outer.start };
      }
      if (best != null) break;
    }
    if (best != null) parent.set(unit.id, best.id);
  }

  const root = new Map<string, string>();
  for (const unit of units) {
    let current = unit.id;
    const seen = new Set([current]);
    while (parent.has(current) && !seen.has(parent.get(current)!)) {
      current = parent.get(current)!;
      seen.add(current);
    }
    root.set(unit.id, current);
  }
  const members = new Map<string, string[]>();
  for (const unit of units) {
    const id = root.get(unit.id)!;
    const list = members.get(id) ?? [];
    if (id === unit.id) list.unshift(unit.id);
    else list.push(unit.id);
    members.set(id, list);
  }
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const cases = new Set<string>();
  const names = new Map<string, string>();
  for (const id of members.keys()) {
    const unit = byId.get(id)!;
    if (!unit.test) continue;
    const own = extents.get(id)!;
    const side = (["added", "deleted"] as const).find((candidate) => own[candidate] != null && TEST_CASE.test(own[candidate]!.head));
    if (side == null && !/^test_\w/.test(unit.symbol)) continue;
    cases.add(id);
    const fileId = unit.anchors[0]!.fileId;
    const name = side == null ? undefined : caseName(index.lines(fileId, side), own[side]!.start - 1);
    if (name != null) names.set(id, name);
  }

  const caseExtents = new Map<string, Extent[]>();
  const caseExtentsOf = (fileId: string, side: StorySide): Extent[] => {
    const key = `${side}\u001f${fileId}`;
    let found = caseExtents.get(key);
    if (found == null) {
      const source = index.lines(fileId, side);
      found = [];
      source.forEach((line, offset) => {
        if (CASE_LINE.test(line)) found!.push({ start: offset + 1, end: blockEnd(source, offset) + 1, head: line });
      });
      caseExtents.set(key, found);
    }
    return found;
  };

  // Changed helpers inside one unchanged test case merge into one family named after that case.
  const enclosing = new Map<string, EnclosingCase>();
  const caseRoots = new Map<string, string>();
  for (const id of [...members.keys()]) {
    const unit = byId.get(id)!;
    if (!unit.test || cases.has(id)) continue;
    for (const side of ["added", "deleted"] as const) {
      const anchors = unit.anchors.filter((anchor) => anchor.side === side);
      const fileId = anchors[0]?.fileId;
      if (fileId == null) continue;
      // Loose lines have no declaration of their own; their span stands in for one.
      const inner = extents.get(id)![side]
        ?? { start: Math.min(...anchors.map((anchor) => anchor.startLine)), end: Math.max(...anchors.map((anchor) => anchor.endLine)), head: "" };
      let best: Extent | undefined;
      for (const extent of caseExtentsOf(fileId, side)) {
        if (extent.start < inner.start && inner.end <= extent.end && (best == null || extent.start > best.start)) best = extent;
      }
      if (best == null) continue;
      const key = `${side}\u001f${fileId}\u001f${best.start}`;
      const existing = caseRoots.get(key);
      if (existing == null) {
        caseRoots.set(key, id);
        const name = caseName(index.lines(fileId, side), best.start - 1) ?? declaration(best.head) ?? best.head.trim();
        enclosing.set(id, { name, fileId, side, startLine: best.start, endLine: best.end });
        names.set(id, name);
        cases.add(id);
      } else {
        members.get(existing)!.push(...members.get(id)!);
        for (const member of members.get(id)!) root.set(member, existing);
        members.delete(id);
      }
      break;
    }
  }
  return { root, members, cases, names, enclosing, containers };
}
