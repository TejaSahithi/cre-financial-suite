import { handleExpenseCamSendRequest } from "../_shared/send-expense-classification-to-cam-workflow.ts";

Deno.serve(handleExpenseCamSendRequest);
