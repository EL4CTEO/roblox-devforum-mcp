//#region src/workflow-types.ts
/**
* Error thrown when a workflow is rejected via rejectWorkflow()
*/
var WorkflowRejectedError = class extends Error {
	constructor(reason, workflowId) {
		super(reason ? `Workflow rejected: ${reason}` : "Workflow rejected");
		this.reason = reason;
		this.workflowId = workflowId;
		this.name = "WorkflowRejectedError";
	}
};
//#endregion
export { WorkflowRejectedError };

//# sourceMappingURL=workflow-types.js.map