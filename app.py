#!/usr/bin/env python3
import aws_cdk as cdk
from lib.lead_pipeline_stack import LeadPipelineStack

app = cdk.App()
LeadPipelineStack(app, "LeadPipelineStack",
    # Explicitly defining the environment ensures smooth deployment via GitHub Actions
    env=cdk.Environment(account="515424600331", region="us-east-1")
)

app.synth()
