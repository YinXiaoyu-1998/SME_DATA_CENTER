import { prepareOrderScopeTransitionSchema } from "@smedc/domain";
import { validationErrorToolResult } from "@smedc/mcp-contract";
import { delegateJsonApiRequest, type ApiDelegationContext } from "./api-delegation.js";
import type { SmedcMcpToolHandlers } from "./tool-handlers.js";

export function createOrderScopeMcpToolHandlers(
  context: ApiDelegationContext
): SmedcMcpToolHandlers {
  return {
    prepare_order_scope_transition: async (input, request) => {
      const parsed = prepareOrderScopeTransitionSchema.safeParse(input);
      if (!parsed.success) return validationErrorToolResult(parsed.error.issues);
      return delegateJsonApiRequest(
        { ...context, audit: request.audit, abortSignal: request.abortSignal },
        {
          method: "POST",
          path: "/v1/structured/order-scope-transitions",
          body: parsed.data
        }
      );
    }
  };
}
