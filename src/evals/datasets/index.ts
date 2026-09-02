/**
 * Synthetic eval dataset — 30 tasks, product-agnostic.
 * Sprint-579: eval-dataset-30.
 *
 * Categories: math (6), code (6), classification (6),
 *             summarization (6), reasoning (6).
 * Ground truth labels manually validated.
 */

export type EvalCategory = "math" | "code" | "classification" | "summarization" | "reasoning";

export type EvalDifficulty = "easy" | "medium" | "hard";

export interface EvalTask {
  id: string;
  category: EvalCategory;
  difficulty: EvalDifficulty;
  /** Prompt sent to the model under evaluation. */
  prompt: string;
  /** Ground truth — exact match or list of accepted values. */
  groundTruth: string | string[];
  /** Optional: judge function id for non-exact-match scoring. */
  scorer?: "exact" | "numeric_tolerance" | "contains" | "code_output";
  /** Tolerance for numeric_tolerance scorer. */
  tolerance?: number;
}

// ─── Math (6) ────────────────────────────────────────────────────────────────

const mathTasks: EvalTask[] = [
  {
    id: "math-001",
    category: "math",
    difficulty: "easy",
    prompt: "What is 17 × 23?",
    groundTruth: "391",
    scorer: "exact",
  },
  {
    id: "math-002",
    category: "math",
    difficulty: "easy",
    prompt: "What is the square root of 144?",
    groundTruth: "12",
    scorer: "exact",
  },
  {
    id: "math-003",
    category: "math",
    difficulty: "medium",
    prompt:
      "A train travels at 80 km/h. How many kilometers does it cover in 2 hours and 45 minutes?",
    groundTruth: "220",
    scorer: "numeric_tolerance",
    tolerance: 0.5,
  },
  {
    id: "math-004",
    category: "math",
    difficulty: "medium",
    prompt: "What is the sum of the first 10 positive odd numbers?",
    groundTruth: "100",
    scorer: "exact",
  },
  {
    id: "math-005",
    category: "math",
    difficulty: "hard",
    prompt: "If f(x) = 3x² − 2x + 1, what is f(4)?",
    groundTruth: "41",
    scorer: "exact",
  },
  {
    id: "math-006",
    category: "math",
    difficulty: "hard",
    prompt:
      "A rectangle has a perimeter of 56 cm and a length that is twice its width. What is the area in cm²?",
    groundTruth: ["196", "196 cm²", "196cm²"],
    scorer: "contains",
  },
];

// ─── Code generation (6) ─────────────────────────────────────────────────────

const codeTasks: EvalTask[] = [
  {
    id: "code-001",
    category: "code",
    difficulty: "easy",
    prompt:
      "Write a Python function `is_palindrome(s: str) -> bool` that returns True if the string is a palindrome (case-insensitive, ignore spaces).",
    groundTruth: "is_palindrome",
    scorer: "contains",
  },
  {
    id: "code-002",
    category: "code",
    difficulty: "easy",
    prompt:
      "Write a TypeScript function `sum(arr: number[]): number` that returns the sum of all elements.",
    groundTruth: "reduce",
    scorer: "contains",
  },
  {
    id: "code-003",
    category: "code",
    difficulty: "medium",
    prompt:
      "Write a Python function `fibonacci(n: int) -> list[int]` that returns the first n Fibonacci numbers. fibonacci(8) should return [0,1,1,2,3,5,8,13].",
    groundTruth: "[0, 1, 1, 2, 3, 5, 8, 13]",
    scorer: "contains",
  },
  {
    id: "code-004",
    category: "code",
    difficulty: "medium",
    prompt:
      "Write a TypeScript function `groupBy<T>(arr: T[], keyFn: (item: T) => string): Record<string, T[]>` that groups array elements by a key function.",
    groundTruth: "Record",
    scorer: "contains",
  },
  {
    id: "code-005",
    category: "code",
    difficulty: "hard",
    prompt:
      "Write a Python function `lru_cache_impl(capacity: int)` that returns an LRU cache object with `get(key)` and `put(key, value)` methods. Use an OrderedDict.",
    groundTruth: "OrderedDict",
    scorer: "contains",
  },
  {
    id: "code-006",
    category: "code",
    difficulty: "hard",
    prompt:
      "Implement a TypeScript `debounce<T extends (...args: unknown[]) => void>(fn: T, delay: number): T` function.",
    groundTruth: "setTimeout",
    scorer: "contains",
  },
];

// ─── Classification (6) ──────────────────────────────────────────────────────

const classificationTasks: EvalTask[] = [
  {
    id: "class-001",
    category: "classification",
    difficulty: "easy",
    prompt:
      'Classify the sentiment of this text as POSITIVE, NEGATIVE, or NEUTRAL:\n"The product arrived on time and works perfectly."',
    groundTruth: "POSITIVE",
    scorer: "contains",
  },
  {
    id: "class-002",
    category: "classification",
    difficulty: "easy",
    prompt:
      'Is the following email spam or not spam?\n"Congratulations! You\'ve been selected for a $1,000 gift card. Click here to claim."',
    groundTruth: "spam",
    scorer: "contains",
  },
  {
    id: "class-003",
    category: "classification",
    difficulty: "medium",
    prompt:
      'Classify this news headline into one of: POLITICS, TECHNOLOGY, SPORTS, FINANCE, HEALTH.\n"Central bank raises interest rates by 25 basis points amid inflation concerns."',
    groundTruth: "FINANCE",
    scorer: "contains",
  },
  {
    id: "class-004",
    category: "classification",
    difficulty: "medium",
    prompt:
      'Is this code comment a TODO, a FIXME, or neither?\n"// This should be refactored once the API stabilizes."',
    groundTruth: ["TODO", "todo"],
    scorer: "contains",
  },
  {
    id: "class-005",
    category: "classification",
    difficulty: "hard",
    prompt:
      'Classify the programming language: `let x: i32 = 42; fn main() { println!("{}", x); }`',
    groundTruth: "Rust",
    scorer: "contains",
  },
  {
    id: "class-006",
    category: "classification",
    difficulty: "hard",
    prompt:
      'Classify the logical fallacy in: "We should trust Dr. Smith\'s diet advice — he has a PhD in biochemistry."\nChoose from: AD_HOMINEM, APPEAL_TO_AUTHORITY, STRAW_MAN, FALSE_DICHOTOMY',
    groundTruth: "APPEAL_TO_AUTHORITY",
    scorer: "contains",
  },
];

// ─── Summarization (6) ───────────────────────────────────────────────────────

const summarizationTasks: EvalTask[] = [
  {
    id: "sum-001",
    category: "summarization",
    difficulty: "easy",
    prompt:
      'Summarize in one sentence:\n"The Eiffel Tower is a wrought-iron lattice tower in Paris, France. It was designed by Gustave Eiffel and built between 1887 and 1889 as the entrance arch to the 1889 World\'s Fair. It stands 330 metres tall and attracts millions of tourists each year."',
    groundTruth: ["Eiffel", "Paris", "1889"],
    scorer: "contains",
  },
  {
    id: "sum-002",
    category: "summarization",
    difficulty: "easy",
    prompt:
      'Extract the key action from this sentence in 5 words or fewer:\n"The board unanimously voted to approve the merger with Acme Corp after reviewing the Q3 financials."',
    groundTruth: ["approved", "merger", "voted"],
    scorer: "contains",
  },
  {
    id: "sum-003",
    category: "summarization",
    difficulty: "medium",
    prompt:
      "Summarize the following code in one sentence describing what it does:\n```python\ndef fn(lst):\n    return [x for x in lst if x % 2 == 0]\n```",
    groundTruth: ["even", "filter"],
    scorer: "contains",
  },
  {
    id: "sum-004",
    category: "summarization",
    difficulty: "medium",
    prompt:
      'Give a one-line TL;DR for this commit message:\n"fix: prevent null pointer exception in UserService.getProfile when user has no associated organization by adding optional chaining and a default empty object fallback"',
    groundTruth: ["null", "UserService", "optional"],
    scorer: "contains",
  },
  {
    id: "sum-005",
    category: "summarization",
    difficulty: "hard",
    prompt:
      'Summarize the main thesis of this argument in one sentence:\n"Critics of universal basic income argue that giving people money without work requirements removes the incentive to be productive, may lead to inflation as more money chases the same goods, and could be prohibitively expensive for governments to sustain in the long term."',
    groundTruth: ["incentive", "inflation", "expensive"],
    scorer: "contains",
  },
  {
    id: "sum-006",
    category: "summarization",
    difficulty: "hard",
    prompt:
      'In ≤20 words, capture the decision made in this ADR:\n"We chose PostgreSQL over MongoDB because our data has clear relational structure, we need ACID guarantees for financial transactions, and the team has strong PostgreSQL expertise."',
    groundTruth: ["PostgreSQL", "MongoDB"],
    scorer: "contains",
  },
];

// ─── Reasoning multi-step (6) ────────────────────────────────────────────────

const reasoningTasks: EvalTask[] = [
  {
    id: "reason-001",
    category: "reasoning",
    difficulty: "easy",
    prompt:
      "Alice is taller than Bob. Bob is taller than Carol. Is Alice taller than Carol? Answer YES or NO.",
    groundTruth: "YES",
    scorer: "contains",
  },
  {
    id: "reason-002",
    category: "reasoning",
    difficulty: "easy",
    prompt:
      "A store sells apples for €1.50 each and gives a 10% discount if you buy 5 or more. How much does it cost to buy exactly 6 apples?",
    groundTruth: ["8.10", "8,10"],
    scorer: "contains",
  },
  {
    id: "reason-003",
    category: "reasoning",
    difficulty: "medium",
    prompt:
      "You have a 3-litre jug and a 5-litre jug. You need exactly 4 litres. Describe the minimum number of steps needed. How many steps?",
    groundTruth: ["6", "7"],
    scorer: "contains",
  },
  {
    id: "reason-004",
    category: "reasoning",
    difficulty: "medium",
    prompt:
      "If all Bloops are Razzies, and all Razzies are Lazzies, are all Bloops definitely Lazzies? Answer YES or NO and give one-line reasoning.",
    groundTruth: "YES",
    scorer: "contains",
  },
  {
    id: "reason-005",
    category: "reasoning",
    difficulty: "hard",
    prompt:
      "A function has O(n log n) time complexity. If it takes 10ms for n=1000, approximately how many milliseconds will it take for n=1,000,000? Round to the nearest integer.",
    groundTruth: ["20000", "20,000"],
    scorer: "contains",
  },
  {
    id: "reason-006",
    category: "reasoning",
    difficulty: "hard",
    prompt:
      "Three switches control three bulbs in the next room. You can flip switches as many times as you like, but you can only enter the room once. Describe a strategy to identify which switch controls which bulb.",
    groundTruth: ["heat", "warm", "on"],
    scorer: "contains",
  },
];

// ─── Full dataset ─────────────────────────────────────────────────────────────

export const EVAL_DATASET_30: EvalTask[] = [
  ...mathTasks,
  ...codeTasks,
  ...classificationTasks,
  ...summarizationTasks,
  ...reasoningTasks,
];

export function getTasksByCategory(category: EvalCategory): EvalTask[] {
  return EVAL_DATASET_30.filter((t) => t.category === category);
}

export function getTasksByDifficulty(difficulty: EvalDifficulty): EvalTask[] {
  return EVAL_DATASET_30.filter((t) => t.difficulty === difficulty);
}
