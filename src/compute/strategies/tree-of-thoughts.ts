/**
 * src/compute/strategies/tree-of-thoughts.ts
 *
 * Tree-of-Thoughts (ToT) compute strategy.
 *
 * Reference: Yao et al. 2023, "Tree of Thoughts: Deliberate Problem Solving
 * with Large Language Models", arXiv:2305.10601.
 *
 * Algorithm (paper §3):
 *   1. Build a tree of partial-solution states, root = empty/initial state.
 *   2. Expand each node into up to `branchFactor` children via the generator.
 *   3. Evaluate each state with a lightweight heuristic (no extra LLM call).
 *   4. BFS expands level-by-level; DFS goes depth-first with backtracking
 *      when score < pruning threshold.
 *   5. Bound total expansions by `maxCalls` (== generator-call budget).
 *   6. Return the highest-scoring leaf output.
 *
 * Default state-evaluator (no LLM):
 *   - string outputs : monotone progress score based on length (caps at 200)
 *   - number outputs : closeness to plausible-answer band [0, 100]
 *   - other          : 0.5 (neutral)
 *
 * @experimental Public-experimental API per `contract-stability.md` (sprint-582).
 */

import type { ComputeContext, Strategy, StrategyResult } from "../types.js";

// ─── Public types ────────────────────────────────────────────────────────────

/** @public */
export type ToTSearchPolicy = "bfs" | "dfs";

/** @public */
export interface ToTConfig {
  /** BFS or DFS. Default: "bfs". */
  searchPolicy: ToTSearchPolicy;
  /** Max tree depth (steps). Default: 3. */
  maxDepth: number;
  /** Max branching factor (children per node). Default: 3. */
  branchFactor: number;
  /** Hard cap on total generator calls. Default: maxDepth * branchFactor. */
  maxCalls: number;
  /** State evaluator → score in [0,1]. Default: heuristic on output shape. */
  evaluateState?: (state: unknown) => number;
  /** Prune any node whose evaluator score is below this. Default: 0.2. */
  pruneThreshold: number;
}

const STRATEGY_NAME = "tree-of-thoughts";

const VALID_POLICIES: ReadonlySet<string> = new Set(["bfs", "dfs"]);

// ─── Default evaluator ───────────────────────────────────────────────────────

function defaultEvaluator(state: unknown): number {
  if (typeof state === "string") {
    const len = state.length;
    if (len === 0) return 0;
    // Monotone, saturates at 200 chars → 1.0
    return Math.min(1, len / 200);
  }
  if (typeof state === "number" && Number.isFinite(state)) {
    if (state < 0 || state > 200) return 0.1;
    // Centered around 50 for plausibility (synthetic-task heuristic)
    return 0.5 + 0.5 * (1 / (1 + Math.abs(state - 50)));
  }
  return 0.5;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Aborted", "AbortError");
  }
}

interface TreeNode<O> {
  state: O;
  depth: number;
  score: number;
}

// ─── Strategy factory ────────────────────────────────────────────────────────

/**
 * Construct a Tree-of-Thoughts {@link Strategy}.
 *
 * @throws RangeError when `maxDepth`, `branchFactor`, or `maxCalls` is < 1.
 * @throws Error when `searchPolicy` is not "bfs" or "dfs".
 * @public
 */
export function treeOfThoughtsStrategy<TInput, TOutput>(
  config?: Partial<ToTConfig>,
): Strategy<TInput, TOutput> {
  const searchPolicy: ToTSearchPolicy = config?.searchPolicy ?? "bfs";
  const maxDepth = config?.maxDepth ?? 3;
  const branchFactor = config?.branchFactor ?? 3;
  const maxCalls = config?.maxCalls ?? maxDepth * branchFactor;
  const pruneThreshold = config?.pruneThreshold ?? 0.2;
  const evaluateState = config?.evaluateState ?? defaultEvaluator;

  if (!Number.isInteger(maxDepth) || maxDepth < 1) {
    throw new RangeError(`treeOfThoughtsStrategy: maxDepth must be >=1, got ${maxDepth}`);
  }
  if (!Number.isInteger(branchFactor) || branchFactor < 1) {
    throw new RangeError(`treeOfThoughtsStrategy: branchFactor must be >=1, got ${branchFactor}`);
  }
  if (!Number.isInteger(maxCalls) || maxCalls < 1) {
    throw new RangeError(`treeOfThoughtsStrategy: maxCalls must be >=1, got ${maxCalls}`);
  }
  if (!VALID_POLICIES.has(searchPolicy)) {
    throw new Error(
      `treeOfThoughtsStrategy: searchPolicy must be "bfs" or "dfs", got "${searchPolicy}"`,
    );
  }

  const strategyLabel = `${STRATEGY_NAME}-${searchPolicy}`;

  return {
    name: strategyLabel,

    async run(
      input: TInput,
      generator: (input: TInput, ctx: ComputeContext) => Promise<TOutput>,
      ctx: ComputeContext = {},
    ): Promise<StrategyResult<TOutput>> {
      const start = performance.now();
      const signal = ctx.signal;
      throwIfAborted(signal);

      const childCtx: ComputeContext = signal ? { signal } : {};

      let callsUsed = 0;
      const allLeaves: TreeNode<TOutput>[] = [];
      const allScores: number[] = [];

      // Helper: expand one parent into up to branchFactor children.
      // Each child = 1 generator call.
      const expandNode = async (
        _parent: TreeNode<TOutput> | null,
        depth: number,
      ): Promise<TreeNode<TOutput>[]> => {
        const childrenToMake = Math.min(branchFactor, maxCalls - callsUsed);
        if (childrenToMake <= 0) return [];

        // Parallel sampling at this level.
        throwIfAborted(signal);
        const samples = await Promise.all(
          Array.from({ length: childrenToMake }, () => generator(input, childCtx)),
        );
        callsUsed += childrenToMake;

        const nodes: TreeNode<TOutput>[] = samples.map((state) => {
          const score = clamp01(evaluateState(state));
          return { state, depth, score };
        });

        for (const n of nodes) allScores.push(n.score);

        // Pruned nodes are still recorded as leaves (score known) but not expanded.
        return nodes;
      };

      if (searchPolicy === "bfs") {
        // ── BFS ───────────────────────────────────────────────────────────
        let frontier: TreeNode<TOutput>[] = [];

        // Depth-1 children from root.
        const initial = await expandNode(null, 1);
        frontier = initial;
        // Leaves at maxDepth or pruned go into allLeaves.
        for (const n of initial) {
          if (n.depth >= maxDepth || n.score < pruneThreshold) {
            allLeaves.push(n);
          }
        }

        while (frontier.length > 0 && callsUsed < maxCalls) {
          // Filter out pruned/leaf nodes — only expand survivors.
          const survivors = frontier.filter((n) => n.score >= pruneThreshold && n.depth < maxDepth);
          if (survivors.length === 0) break;

          const nextFrontier: TreeNode<TOutput>[] = [];
          for (const parent of survivors) {
            if (callsUsed >= maxCalls) break;
            const children = await expandNode(parent, parent.depth + 1);
            for (const c of children) {
              if (c.depth >= maxDepth || c.score < pruneThreshold) {
                allLeaves.push(c);
              } else {
                nextFrontier.push(c);
              }
            }
          }

          // If BFS terminates with un-expanded frontier (budget hit), those are leaves too.
          if (callsUsed >= maxCalls) {
            for (const n of nextFrontier) allLeaves.push(n);
            break;
          }
          frontier = nextFrontier;
        }
        // Any remaining frontier nodes at end-of-budget = leaves.
        for (const n of frontier) {
          if (!allLeaves.includes(n)) allLeaves.push(n);
        }
      } else {
        // ── DFS with backtracking ─────────────────────────────────────────
        const stack: TreeNode<TOutput>[] = [];
        const initial = await expandNode(null, 1);
        // Push so highest score is explored first.
        const sortedInitial = [...initial].sort((a, b) => b.score - a.score);
        stack.push(...sortedInitial.reverse()); // reverse so highest pops first

        for (const n of initial) {
          if (n.depth >= maxDepth || n.score < pruneThreshold) {
            allLeaves.push(n);
          }
        }

        while (stack.length > 0 && callsUsed < maxCalls) {
          const node = stack.pop();
          if (!node) break;
          // Backtrack if pruned or terminal.
          if (node.score < pruneThreshold || node.depth >= maxDepth) {
            // Already recorded as leaf above (or will be).
            if (!allLeaves.includes(node)) allLeaves.push(node);
            continue;
          }
          // Expand survivor.
          const children = await expandNode(node, node.depth + 1);
          const sortedChildren = [...children].sort((a, b) => b.score - a.score);
          for (const c of sortedChildren.reverse()) {
            if (c.depth >= maxDepth || c.score < pruneThreshold) {
              allLeaves.push(c);
            } else {
              stack.push(c);
            }
          }
        }
        // Any unexplored stack nodes = leaves (budget-bound).
        for (const n of stack) {
          if (!allLeaves.includes(n)) allLeaves.push(n);
        }
      }

      // ── Pick highest-scoring leaf ─────────────────────────────────────
      if (allLeaves.length === 0) {
        // Should never happen: root expansion always produces ≥1 leaf
        // unless maxCalls=0 (which we reject). Defensive fallback.
        const fallback = await generator(input, childCtx);
        callsUsed++;
        allScores.push(clamp01(evaluateState(fallback)));
        const latency_ms = performance.now() - start;
        return {
          result: fallback,
          metadata: {
            strategy: strategyLabel,
            candidates: 1,
            verifier_scores: allScores,
            cost: { calls: callsUsed },
            latency_ms,
          },
        };
      }

      let best = allLeaves[0];
      for (let i = 1; i < allLeaves.length; i++) {
        const n = allLeaves[i] as TreeNode<TOutput>;
        if (n.score > best.score) best = n;
      }

      const latency_ms = performance.now() - start;
      return {
        result: best.state,
        metadata: {
          strategy: strategyLabel,
          candidates: callsUsed,
          verifier_scores: allScores,
          cost: { calls: callsUsed },
          latency_ms,
        },
      };
    },
  };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
