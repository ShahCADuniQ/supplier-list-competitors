// Assembly-tree helpers — build a nested tree from the flat
// assembly_bom edges, and compute the max number of root assemblies
// that can be produced given current stock.
//
// Stock = inventoryItems.confirmedQty (the "I have this many on hand"
// counter the rest of the ERP already maintains).
//
// For a non-leaf child (a sub-assembly):
//   effective_stock = child.confirmedQty  +  max_producible(child)
// i.e. assemblies already built PLUS how many more we could build now.
// The recursion bottoms out at parts, which have no children — their
// stock is just confirmedQty.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { assemblyBom, inventoryItems } from "@/db/schema";

export type TreeNode = {
  itemId: number;
  code: string;
  name: string | null;
  kind: "part" | "assembly";
  // Required qty of THIS node to build one of its parent. For the root
  // call this is conceptually 1.
  quantity: number;
  // Available pieces on hand (confirmed_qty). For an assembly this is
  // the count of already-built sub-assemblies.
  stock: number;
  // For an assembly: how many more can we build from raw stock right
  // now, ignoring stock of the assembly itself. Null for parts.
  buildableFromStock: number | null;
  // Surfaced so the tree card can render the star + configuration
  // toggles without a separate fetch per node.
  starred: boolean;
  isConfiguration: boolean;
  // Tree continues if this node is an assembly with edges.
  children: TreeNode[];
};

type Edge = {
  parentAssemblyId: number;
  childItemId: number;
  quantity: number;
  position: number;
};

// Walks downward through the assembly graph. Cycle-safe: tracks the
// ancestor set as we descend and skips any back-edge.
async function loadEdgesFor(
  rootId: number,
): Promise<{
  edges: Edge[];
  items: Map<
    number,
    {
      id: number;
      code: string;
      name: string | null;
      kind: "part" | "assembly";
      confirmedQty: number;
      starred: boolean;
      isConfiguration: boolean;
    }
  >;
}> {
  const visited = new Set<number>([rootId]);
  const allEdges: Edge[] = [];
  let frontier = [rootId];
  while (frontier.length) {
    const rows = await db
      .select({
        parentAssemblyId: assemblyBom.parentAssemblyId,
        childItemId: assemblyBom.childItemId,
        quantity: assemblyBom.quantity,
        position: assemblyBom.position,
      })
      .from(assemblyBom)
      .where(inArray(assemblyBom.parentAssemblyId, frontier));
    allEdges.push(...rows);
    const next = new Set<number>();
    for (const r of rows) {
      if (!visited.has(r.childItemId)) {
        visited.add(r.childItemId);
        next.add(r.childItemId);
      }
    }
    frontier = Array.from(next);
  }

  const itemRows = await db
    .select({
      id: inventoryItems.id,
      code: inventoryItems.code,
      name: inventoryItems.name,
      kind: inventoryItems.kind,
      confirmedQty: inventoryItems.confirmedQty,
      starred: inventoryItems.starred,
      isConfiguration: inventoryItems.isConfiguration,
    })
    .from(inventoryItems)
    .where(inArray(inventoryItems.id, Array.from(visited)));
  const items = new Map<
    number,
    {
      id: number;
      code: string;
      name: string | null;
      kind: "part" | "assembly";
      confirmedQty: number;
      starred: boolean;
      isConfiguration: boolean;
    }
  >();
  for (const it of itemRows) {
    items.set(it.id, {
      id: it.id,
      code: it.code,
      name: it.name,
      kind: it.kind === "assembly" ? "assembly" : "part",
      confirmedQty: it.confirmedQty ?? 0,
      starred: it.starred ?? false,
      isConfiguration: it.isConfiguration ?? false,
    });
  }
  return { edges: allEdges, items };
}

export async function buildAssemblyTree(rootId: number): Promise<TreeNode | null> {
  const { edges, items } = await loadEdgesFor(rootId);
  const root = items.get(rootId);
  if (!root) return null;

  // Group edges by parent for O(1) lookup.
  const childrenByParent = new Map<number, Edge[]>();
  for (const e of edges) {
    const arr = childrenByParent.get(e.parentAssemblyId) ?? [];
    arr.push(e);
    childrenByParent.set(e.parentAssemblyId, arr);
  }
  for (const arr of childrenByParent.values()) {
    arr.sort((a, b) => a.position - b.position);
  }

  function buildNode(itemId: number, quantity: number, ancestors: Set<number>): TreeNode {
    const it = items.get(itemId)!;
    const isAssembly = it.kind === "assembly";
    const childEdges = childrenByParent.get(itemId) ?? [];
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(itemId);

    const children: TreeNode[] = isAssembly
      ? childEdges
          // Cycle guard — drop any edge that would re-enter an ancestor.
          .filter((e) => !nextAncestors.has(e.childItemId))
          .map((e) => buildNode(e.childItemId, e.quantity, nextAncestors))
      : [];

    const buildable = isAssembly ? maxBuildable(children) : null;
    return {
      itemId,
      code: it.code,
      name: it.name,
      kind: it.kind,
      quantity,
      stock: it.confirmedQty,
      buildableFromStock: buildable,
      starred: it.starred,
      isConfiguration: it.isConfiguration,
      children,
    };
  }

  return buildNode(rootId, 1, new Set());
}

// Given a node's children, how many of THIS node can we build from raw
// stock right now?  min(child.effectiveStock / child.quantity).
// effectiveStock for an assembly = child.stock + child.buildableFromStock.
export function maxBuildable(children: TreeNode[]): number {
  if (!children.length) return 0; // an empty assembly is unbuildable
  let min = Number.POSITIVE_INFINITY;
  for (const c of children) {
    const own = c.stock;
    const extra =
      c.kind === "assembly" ? c.buildableFromStock ?? 0 : 0;
    const effective = own + extra;
    const canMake = Math.floor(effective / Math.max(c.quantity, 1));
    if (canMake < min) min = canMake;
    if (min === 0) return 0;
  }
  return min === Number.POSITIVE_INFINITY ? 0 : min;
}

// Used by the database tab to show "Can build N" inline per assembly
// row. Same result as buildAssemblyTree(...).buildableFromStock but
// avoids returning the whole tree when the caller only wants the
// number.
export async function maxProducible(rootId: number): Promise<number> {
  const tree = await buildAssemblyTree(rootId);
  if (!tree || tree.kind !== "assembly") return 0;
  return tree.buildableFromStock ?? 0;
}

// ── Writes ───────────────────────────────────────────────────────────────

export async function upsertAssemblyEdge(args: {
  parentAssemblyId: number;
  childItemId: number;
  quantity: number;
  notes?: string | null;
  createdByClerkId?: string | null;
}): Promise<void> {
  if (args.parentAssemblyId === args.childItemId) {
    throw new Error("An assembly cannot contain itself");
  }
  if (await wouldCreateCycle(args.parentAssemblyId, args.childItemId)) {
    throw new Error(
      "Linking these would create a cycle — the child already contains the parent somewhere in its subtree.",
    );
  }
  const existing = await db
    .select({ id: assemblyBom.id })
    .from(assemblyBom)
    .where(
      and(
        eq(assemblyBom.parentAssemblyId, args.parentAssemblyId),
        eq(assemblyBom.childItemId, args.childItemId),
      ),
    )
    .limit(1);
  if (existing.length) {
    await db
      .update(assemblyBom)
      .set({
        quantity: Math.max(1, Math.floor(args.quantity)),
        notes: args.notes ?? null,
        updatedAt: new Date(),
      })
      .where(eq(assemblyBom.id, existing[0].id));
    return;
  }
  await db.insert(assemblyBom).values({
    parentAssemblyId: args.parentAssemblyId,
    childItemId: args.childItemId,
    quantity: Math.max(1, Math.floor(args.quantity)),
    notes: args.notes ?? null,
    createdByClerkId: args.createdByClerkId ?? null,
  });
}

export async function removeAssemblyEdge(args: {
  parentAssemblyId: number;
  childItemId: number;
}): Promise<void> {
  await db
    .delete(assemblyBom)
    .where(
      and(
        eq(assemblyBom.parentAssemblyId, args.parentAssemblyId),
        eq(assemblyBom.childItemId, args.childItemId),
      ),
    );
}

async function wouldCreateCycle(
  parentId: number,
  candidateChildId: number,
): Promise<boolean> {
  // Walk down from candidateChildId. If we hit parentId, the new edge
  // would close a cycle.
  const visited = new Set<number>([candidateChildId]);
  let frontier = [candidateChildId];
  while (frontier.length) {
    const rows = await db
      .select({ childItemId: assemblyBom.childItemId })
      .from(assemblyBom)
      .where(inArray(assemblyBom.parentAssemblyId, frontier));
    if (rows.some((r) => r.childItemId === parentId)) return true;
    const next: number[] = [];
    for (const r of rows) {
      if (!visited.has(r.childItemId)) {
        visited.add(r.childItemId);
        next.push(r.childItemId);
      }
    }
    frontier = next;
  }
  return false;
}
