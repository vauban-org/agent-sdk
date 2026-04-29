/**
 * createOODAAgent — public factory.
 *
 * @public
 */

import { OODAAgentImpl } from "./agent.js";
import type { OODAAgent, OODAAgentConfig } from "./types.js";

export function createOODAAgent<
  TConfig = unknown,
  TObs = unknown,
  TOrient = unknown,
  TDecision = unknown,
  TAction = unknown,
  TFeedback = unknown,
>(
  config: OODAAgentConfig<
    TConfig,
    TObs,
    TOrient,
    TDecision,
    TAction,
    TFeedback
  >,
): OODAAgent {
  return new OODAAgentImpl<
    TConfig,
    TObs,
    TOrient,
    TDecision,
    TAction,
    TFeedback
  >(config);
}
