import os
from aws_cdk import (
    Stack,
    Duration,
    RemovalPolicy,
    aws_s3 as s3,
    aws_lambda as awslambda,
    aws_stepfunctions as sfn,
    aws_stepfunctions_tasks as tasks,
    aws_events as events,
    aws_events_targets as targets,
)
from constructs import Construct

class LeadPipelineStack(Stack):

    def __init__(self, scope: Construct, construct_id: str, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)

        # 1. IMPORT EXISTING RAW S3 BUCKET
        # Note: Your raw bucket MUST have EventBridge notifications enabled in AWS
        raw_bucket = s3.Bucket.from_bucket_name(
            self, "ZapierWebhookData", 
            "zapier-webhook-data-calvinfr"
        )

        # 2. CREATE NEW PROCESSED S3 BUCKET
        processed_bucket = s3.Bucket(
            self, "ProcessedLeadBucket",
            bucket_name="processed-lead-bucket-calvinfr",
            removal_policy=RemovalPolicy.RETAIN,
            encryption=s3.BucketEncryption.S3_MANAGED,
            enforce_ssl=True
        )

        # 3. CREATE AWS LAMBDA FUNCTION (Processor)
        lead_lambda = awslambda.Function(
            self, "LeadProcessorLambda",
            runtime=awslambda.Runtime.NODEJS_20_X,
            handler="index.handler",
            code=awslambda.Code.from_asset("lambda"),
            timeout=Duration.minutes(15),
            environment={
                # Automatically populated dynamically by AWS CDK
                "PROCESSED_BUCKET_NAME": processed_bucket.bucket_name,
                # Injected during deployment execution from GitHub Secrets
                "SLACK_WEBHOOK_URL": os.getenv("SLACK_WEBHOOK_URL", "")
            }
        )

        # 4. DEFINE STEP FUNCTIONS WORKFLOW STATES
        # State A: The 20-minute Wait State
        wait_state = sfn.Wait(
            self, "WaitTwentyMinutes",
            time=sfn.WaitTime.duration(Duration.minutes(20))
        )

        # State B: Invoke Lambda Task
        # Pass the incoming EventBridge S3 payload straight into the Lambda function
        lambda_task = tasks.LambdaInvoke(
            self, "InvokeLeadProcessor",
            lambda_function=lead_lambda,
        )

        # Chain the workflow together: Wait -> Then Execute Lambda
        definition = wait_state.next(lambda_task)

        # 5. CREATE STATE MACHINE
        state_machine = sfn.StateMachine(
            self, "LeadProcessingStateMachine",
            definition_body=sfn.DefinitionBody.from_chainable(definition),
            timeout=Duration.minutes(35)
        )

        # 6. TRIGGER VIA EVENTBRIDGE ON S3 OBJECT CREATION
        # Listens for any new file drops in your specific raw bucket name
        s3_event_rule = events.Rule(
            self, "RawLeadObjectCreatedRule",
            event_pattern=events.EventPattern(
                source=["aws.s3"],
                detail_type=["Object Created"],
                detail={
                    "bucket": {
                        "name": [raw_bucket.bucket_name]
                    }
                }
            )
        )
        
        # Point the EventBridge rule directly to start our Step Function execution
        s3_event_rule.add_target(targets.SfnStateMachine(state_machine))

        # 7. GRANT IAM PERMISSIONS TO LAMBDA
        raw_bucket.grant_read(lead_lambda)
        processed_bucket.grant_write(lead_lambda)
        # Ensures the State Machine has explicit rights to trigger your Lambda
        lead_lambda.grant_invoke(state_machine)
