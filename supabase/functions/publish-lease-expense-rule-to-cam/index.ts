// @ts-nocheck
import { handleCamPublishRequest } from "../_shared/lease-expense-rule-cam-publish-workflow.ts";

Deno.serve((req: Request) => handleCamPublishRequest(req));
