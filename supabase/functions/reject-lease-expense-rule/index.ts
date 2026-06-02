// @ts-nocheck
import { handleRuleReviewRequest } from "../_shared/lease-expense-rule-review-workflow.ts";

Deno.serve((req: Request) => handleRuleReviewRequest(req, "reject"));
