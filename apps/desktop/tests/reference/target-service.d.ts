import type { ActionRequest, ActionResult, OperationResult, TargetConnection, TargetSnapshot } from "../../src/shared/contracts.js";
export interface TargetService { listConnections(): readonly TargetConnection[]; getSnapshot(targetId: string): Promise<OperationResult<TargetSnapshot>>; executeAction(request: ActionRequest): Promise<OperationResult<ActionResult>>; }
