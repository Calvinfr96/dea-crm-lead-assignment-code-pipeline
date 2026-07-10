import aws_cdk as core
import aws_cdk.assertions as assertions

from dea_crm_lead_assignment_code_pipeline.dea_crm_lead_assignment_code_pipeline_stack import DeaCrmLeadAssignmentCodePipelineStack

# example tests. To run these tests, uncomment this file along with the example
# resource in dea_crm_lead_assignment_code_pipeline/dea_crm_lead_assignment_code_pipeline_stack.py
def test_sqs_queue_created():
    app = core.App()
    stack = DeaCrmLeadAssignmentCodePipelineStack(app, "dea-crm-lead-assignment-code-pipeline")
    template = assertions.Template.from_stack(stack)

#     template.has_resource_properties("AWS::SQS::Queue", {
#         "VisibilityTimeout": 300
#     })
